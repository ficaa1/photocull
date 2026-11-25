//! The transaction-level transport the Sony session drives, and a scripted virtual camera.

use super::ptp::{handle, op, resp};
use std::collections::VecDeque;
use std::fmt;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct Operation<'a> {
    pub opcode: u16,
    /// At most five.
    pub params: &'a [u32],
}

pub enum DataPhase<'a> {
    None,
    Out(&'a [u8]),
    In {
        sink: &'a mut (dyn Write + Send),
        limit: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub code: u16,
    pub params: Vec<u32>,
    pub bytes_in: u64,
}

impl Reply {
    pub fn ok(bytes_in: u64) -> Reply {
        Reply {
            code: resp::OK,
            params: vec![],
            bytes_in,
        }
    }

    pub fn code(code: u16) -> Reply {
        Reply {
            code,
            params: vec![],
            bytes_in: 0,
        }
    }
}

#[derive(Debug)]
pub enum TransportError {
    Removed,
    InUse,
    Permission,
    TimedOut,
    Framing(String),
    Limit,
    Sink(std::io::Error),
    Native {
        domain: String,
        code: i64,
        message: String,
    },
}

impl TransportError {
    pub fn native(message: impl Into<String>) -> Self {
        TransportError::Native {
            domain: "PhotoCull".into(),
            code: 0,
            message: message.into(),
        }
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::Removed => write!(f, "the camera was disconnected"),
            TransportError::InUse => write!(f, "another application is using the camera"),
            TransportError::Permission => write!(f, "access to the camera was denied"),
            TransportError::TimedOut => write!(f, "the camera did not answer in time"),
            TransportError::Framing(m) => write!(f, "unexpected camera reply: {m}"),
            TransportError::Limit => write!(f, "the camera sent more data than expected"),
            TransportError::Sink(e) => write!(f, "could not write the received data: {e}"),
            TransportError::Native {
                domain,
                code,
                message,
            } => write!(f, "{message} ({domain} {code})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    Ptp {
        generation: u64,
        code: u16,
        params: Vec<u32>,
    },
    Removed {
        generation: u64,
    },
    SessionLost {
        generation: u64,
    },
}

impl TransportEvent {
    pub fn generation(&self) -> u64 {
        match self {
            TransportEvent::Ptp { generation, .. }
            | TransportEvent::Removed { generation }
            | TransportEvent::SessionLost { generation } => *generation,
        }
    }
}

/// One exclusive PTP session. `open`/`close` own the underlying session; every call blocks the
/// camera worker until the transaction completes, fails or reaches its deadline.
pub trait PtpTransport {
    fn open(&mut self, deadline: Instant) -> Result<(), TransportError>;
    fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        deadline: Instant,
    ) -> Result<Reply, TransportError>;
    fn close(&mut self, deadline: Instant) -> Result<(), TransportError>;
    fn poll_event(&mut self) -> Option<TransportEvent>;

    /// Attachment generation; events from older generations are stale.
    fn generation(&self) -> u64 {
        0
    }
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration)
    }
    /// Waits for an event until `until`, polling at most every 10 ms.
    fn wait_event(&mut self, until: Instant) -> Option<TransportEvent> {
        loop {
            if let Some(event) = self.poll_event() {
                return Some(event);
            }
            let now = self.now();
            if now >= until {
                return None;
            }
            self.sleep((until - now).min(Duration::from_millis(10)));
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectedPhase {
    None,
    Out(Vec<u8>),
    In(Vec<u8>),
}

pub enum Step {
    Open,
    Transaction {
        opcode: u16,
        params: Vec<u32>,
        phase: ExpectedPhase,
        result: Result<Reply, TransportError>,
    },
    /// 1008(FFFFC001) answered from the virtual queue head without consuming it.
    CaptureInfo,
    /// 1009(FFFFC001) streams and consumes the virtual queue head.
    CaptureObject,
    /// 1009(FFFFC001) consumes the head, delivers `bytes` of it, then fails.
    CaptureObjectFails {
        bytes: usize,
        error: TransportError,
    },
    Close,
}

pub struct VirtualObject {
    pub info: Vec<u8>,
    pub data: Vec<u8>,
}

/// A recorded call, for asserting outbound traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub opcode: u16,
    pub params: Vec<u32>,
    pub out: Option<Vec<u8>>,
}

struct ScriptStep {
    step: Step,
    signal: Option<Arc<AtomicBool>>,
}

/// Deterministic camera double: byte-exact expected steps, a virtual capture queue, scheduled
/// events and a mock clock that advances only on sleep or scheduled latency.
pub struct ScriptedTransport {
    steps: VecDeque<ScriptStep>,
    queue: VecDeque<VirtualObject>,
    events: Vec<(Duration, TransportEvent)>,
    base: Instant,
    elapsed: Duration,
    latency: Duration,
    generation: u64,
    pub sent: Vec<Sent>,
}

impl Default for ScriptedTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptedTransport {
    pub fn new() -> Self {
        ScriptedTransport {
            steps: VecDeque::new(),
            queue: VecDeque::new(),
            events: Vec::new(),
            base: Instant::now(),
            elapsed: Duration::ZERO,
            latency: Duration::ZERO,
            generation: 1,
            sent: Vec::new(),
        }
    }

    pub fn push(&mut self, step: Step) -> &mut Self {
        self.steps.push_back(ScriptStep { step, signal: None });
        self
    }

    pub fn expect(
        &mut self,
        opcode: u16,
        params: &[u32],
        phase: ExpectedPhase,
        result: Result<Reply, TransportError>,
    ) -> &mut Self {
        self.push(Step::Transaction {
            opcode,
            params: params.to_vec(),
            phase,
            result,
        })
    }

    /// Sets `flag` once the most recently added step has completed.
    pub fn then_signal(&mut self, flag: Arc<AtomicBool>) -> &mut Self {
        if let Some(last) = self.steps.back_mut() {
            last.signal = Some(flag);
        }
        self
    }

    pub fn enqueue_object(&mut self, info: Vec<u8>, data: Vec<u8>) -> &mut Self {
        self.queue.push_back(VirtualObject { info, data });
        self
    }

    pub fn queued_objects(&self) -> usize {
        self.queue.len()
    }

    /// Schedules an event at a mock-clock offset from the start.
    pub fn schedule(&mut self, at: Duration, event: TransportEvent) -> &mut Self {
        self.events.push((at, event));
        self.events.sort_by_key(|(t, _)| *t);
        self
    }

    pub fn set_latency(&mut self, latency: Duration) {
        self.latency = latency;
    }

    pub fn set_generation(&mut self, generation: u64) {
        self.generation = generation;
    }

    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }

    pub fn remaining_steps(&self) -> usize {
        self.steps.len()
    }

    /// Panics unless every scripted step was consumed.
    pub fn finish(&self) {
        assert!(
            self.steps.is_empty(),
            "{} scripted steps were not consumed",
            self.steps.len()
        );
    }

    fn next(&mut self, what: &str) -> ScriptStep {
        self.steps
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected {what}: script is exhausted"))
    }

    fn deliver(phase: DataPhase<'_>, bytes: &[u8], upto: usize) -> Result<u64, TransportError> {
        match phase {
            DataPhase::In { sink, limit } => {
                if bytes.len() as u64 > limit {
                    return Err(TransportError::Limit);
                }
                sink.write_all(&bytes[..upto.min(bytes.len())])
                    .map_err(TransportError::Sink)?;
                Ok(bytes.len() as u64)
            }
            _ => panic!("virtual capture read without a data-in phase"),
        }
    }
}

impl PtpTransport for ScriptedTransport {
    fn open(&mut self, _deadline: Instant) -> Result<(), TransportError> {
        let s = self.next("open");
        assert!(matches!(s.step, Step::Open), "expected Open");
        if let Some(flag) = s.signal {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        _deadline: Instant,
    ) -> Result<Reply, TransportError> {
        self.elapsed += self.latency;
        let out = match &phase {
            DataPhase::Out(bytes) => Some(bytes.to_vec()),
            _ => None,
        };
        self.sent.push(Sent {
            opcode: request.opcode,
            params: request.params.to_vec(),
            out,
        });
        let s = self.next(&format!("transaction {:04X}", request.opcode));
        let capture = [handle::CAPTURE];
        let result = match s.step {
            Step::Transaction {
                opcode,
                params,
                phase: expected,
                result,
            } => {
                assert_eq!(
                    request.opcode, opcode,
                    "opcode {:04X} instead of {opcode:04X}",
                    request.opcode
                );
                assert_eq!(
                    request.params,
                    params.as_slice(),
                    "parameters for {opcode:04X}"
                );
                match (expected, phase) {
                    (ExpectedPhase::None, DataPhase::None) => {}
                    (ExpectedPhase::Out(bytes), DataPhase::Out(sent)) => {
                        assert_eq!(sent, bytes.as_slice(), "data for {opcode:04X}");
                    }
                    (ExpectedPhase::In(bytes), DataPhase::In { sink, limit }) => {
                        if bytes.len() as u64 > limit {
                            return Err(TransportError::Limit);
                        }
                        sink.write_all(&bytes).map_err(TransportError::Sink)?;
                        if let Ok(reply) = &result {
                            assert_eq!(reply.bytes_in, bytes.len() as u64);
                        }
                    }
                    (_, DataPhase::None) => panic!("{opcode:04X}: expected a data phase"),
                    (_, DataPhase::Out(_)) => panic!("{opcode:04X}: unexpected data-out"),
                    (_, DataPhase::In { .. }) => panic!("{opcode:04X}: unexpected data-in"),
                }
                result
            }
            Step::CaptureInfo => {
                assert_eq!(request.opcode, op::GET_OBJECT_INFO);
                assert_eq!(request.params, capture);
                match self.queue.front() {
                    None => Ok(Reply::code(resp::INVALID_OBJECT_HANDLE)),
                    Some(head) => {
                        let info = head.info.clone();
                        Self::deliver(phase, &info, info.len()).map(Reply::ok)
                    }
                }
            }
            Step::CaptureObject => {
                assert_eq!(request.opcode, op::GET_OBJECT);
                assert_eq!(request.params, capture);
                match self.queue.pop_front() {
                    None => Ok(Reply::code(resp::INVALID_OBJECT_HANDLE)),
                    Some(head) => Self::deliver(phase, &head.data, head.data.len()).map(Reply::ok),
                }
            }
            Step::CaptureObjectFails { bytes, error } => {
                assert_eq!(request.opcode, op::GET_OBJECT);
                assert_eq!(request.params, capture);
                if let Some(head) = self.queue.pop_front() {
                    Self::deliver(phase, &head.data, bytes)?;
                }
                Err(error)
            }
            Step::Open => panic!("expected Open, got transaction {:04X}", request.opcode),
            Step::Close => panic!("expected Close, got transaction {:04X}", request.opcode),
        };
        if let Some(flag) = s.signal {
            flag.store(true, Ordering::SeqCst);
        }
        result
    }

    fn close(&mut self, _deadline: Instant) -> Result<(), TransportError> {
        let s = self.next("close");
        assert!(matches!(s.step, Step::Close), "expected Close");
        Ok(())
    }

    fn poll_event(&mut self) -> Option<TransportEvent> {
        match self.events.first() {
            Some((at, _)) if *at <= self.elapsed => Some(self.events.remove(0).1),
            _ => None,
        }
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn now(&self) -> Instant {
        self.base + self.elapsed
    }

    fn sleep(&mut self, duration: Duration) {
        self.elapsed += duration;
    }

    fn wait_event(&mut self, until: Instant) -> Option<TransportEvent> {
        if let Some(e) = self.poll_event() {
            return Some(e);
        }
        let limit = until.saturating_duration_since(self.base);
        match self.events.first() {
            Some((at, _)) if *at <= limit => {
                self.elapsed = self.elapsed.max(*at);
                self.poll_event()
            }
            _ => {
                self.elapsed = self.elapsed.max(limit);
                None
            }
        }
    }
}
