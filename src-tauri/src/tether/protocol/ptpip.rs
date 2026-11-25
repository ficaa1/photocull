//! PTP/IP 1.0 (CIPA DC-005-2005) initiator: a command/data stream and an event stream to one
//! camera endpoint, carrying the same transactions as the USB transport.

use super::ptp::{event, op, resp, MAX_PARAMS};
use super::transport::{DataPhase, Operation, PtpTransport, Reply, TransportError, TransportEvent};
use std::collections::VecDeque;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const PTPIP_PORT: u16 = 15740;
pub const PROTOCOL_VERSION: u32 = 0x0001_0000;

pub mod packet {
    pub const INIT_COMMAND_REQUEST: u32 = 0x01;
    pub const INIT_COMMAND_ACK: u32 = 0x02;
    pub const INIT_EVENT_REQUEST: u32 = 0x03;
    pub const INIT_EVENT_ACK: u32 = 0x04;
    pub const INIT_FAIL: u32 = 0x05;
    pub const OPERATION_REQUEST: u32 = 0x06;
    pub const OPERATION_RESPONSE: u32 = 0x07;
    pub const EVENT: u32 = 0x08;
    pub const START_DATA: u32 = 0x09;
    pub const DATA: u32 = 0x0A;
    pub const CANCEL: u32 = 0x0B;
    pub const END_DATA: u32 = 0x0C;
    pub const PROBE_REQUEST: u32 = 0x0D;
    pub const PROBE_RESPONSE: u32 = 0x0E;
}

const HEADER: usize = 8;
const DATA_HEADER: usize = 12;
const CHUNK: usize = 64 << 10;
const MAX_NAME_UNITS: usize = 40;
const SESSION_ID: u32 = 1;
const UNKNOWN_LENGTH: u64 = u64::MAX;
const PHASE_NONE_OR_IN: u32 = 1;
const PHASE_OUT: u32 = 2;
/// Includes one slot always left for the terminal notification.
const EVENT_QUEUE: usize = 256;
/// Completion budget for an event-stream frame once its first byte arrived, and for a probe reply.
const EVENT_FRAME_BUDGET: Duration = Duration::from_secs(10);
/// A blocking connect cannot be interrupted, so it is retried in slices this long.
const DIAL_SLICE: Duration = Duration::from_secs(1);
/// Socket reads and writes poll cancellation and stream retirement at this cadence because
/// cross-thread `shutdown()` does not reliably wake blocked calls on macOS and Windows.
const IO_SLICE: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct PtpIpConfig {
    pub endpoint: SocketAddr,
    pub initiator_guid: [u8; 16],
    pub friendly_name: String,
    /// First attachment generation; each open uses the next one.
    pub generation: u64,
}

#[derive(Default)]
struct Link {
    /// The generation whose streams are usable.
    live: Option<u64>,
    /// Set while PhotoCull itself closes the streams: no terminal event.
    deliberate: bool,
    events: VecDeque<TransportEvent>,
    /// Shutdown handles for both streams of the live generation.
    sockets: Vec<TcpStream>,
    /// Streams dialled by an open still in progress.
    pending: Vec<TcpStream>,
    /// Set by [`PtpIpAbort`]; every later open fails at once.
    cancelled: bool,
}

#[derive(Default)]
struct Shared {
    link: Mutex<Link>,
    ready: Condvar,
}

impl Shared {
    /// Retires `generation` once: both streams shut down, so any blocked read wakes, and one
    /// `SessionLost` is queued unless the close was deliberate.
    fn retire(&self, generation: u64) {
        let mut link = self.link.lock().unwrap();
        if link.live != Some(generation) {
            return;
        }
        link.live = None;
        for socket in link.sockets.drain(..) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if !link.deliberate {
            link.events
                .push_back(TransportEvent::SessionLost { generation });
        }
        drop(link);
        self.ready.notify_all();
    }

    /// False when the queue overflowed and the caller must force a resynchronisation.
    fn push_event(&self, generation: u64, code: u16, params: Vec<u32>) -> bool {
        let mut link = self.link.lock().unwrap();
        if link.live != Some(generation) {
            return true;
        }
        let dirty = matches!(
            code,
            event::SONY_PROPERTY_CHANGED | event::DEVICE_PROP_CHANGED
        );
        if dirty
            && link
                .events
                .iter()
                .any(|e| matches!(e, TransportEvent::Ptp { code: c, .. } if *c == code))
        {
            return true;
        }
        if link.events.len() + 1 >= EVENT_QUEUE {
            return false;
        }
        link.events.push_back(TransportEvent::Ptp {
            generation,
            code,
            params,
        });
        drop(link);
        self.ready.notify_all();
        true
    }

    fn is_live(&self, generation: u64) -> bool {
        self.link.lock().unwrap().live == Some(generation)
    }

    fn cancelled(&self) -> bool {
        self.link.lock().unwrap().cancelled
    }

    /// Keeps a shutdown handle for a stream an open just dialled, or refuses it after an abort.
    fn track(&self, stream: &TcpStream) -> Result<(), TransportError> {
        let handle = stream.try_clone().map_err(io_error)?;
        let mut link = self.link.lock().unwrap();
        if link.cancelled {
            let _ = handle.shutdown(Shutdown::Both);
            return Err(cancelled());
        }
        link.pending.push(handle);
        Ok(())
    }
}

/// Interrupts an open from another thread: both streams close at once, including while the
/// camera waits for the photographer to confirm pairing.
#[derive(Clone)]
pub struct PtpIpAbort(Arc<Shared>);

impl PtpIpAbort {
    pub fn abort(&self) {
        let mut link = self.0.link.lock().unwrap();
        link.cancelled = true;
        link.deliberate = true;
        for socket in link.pending.iter().chain(link.sockets.iter()) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        drop(link);
        self.0.ready.notify_all();
    }
}

pub struct PtpIpTransport {
    config: PtpIpConfig,
    shared: Arc<Shared>,
    command: Option<TcpStream>,
    reader: Option<JoinHandle<()>>,
    generation: u64,
    opens: u64,
    next_tid: u32,
    session_open: bool,
    responder_guid: Option<[u8; 16]>,
    responder_name: Option<String>,
    scratch: Vec<u8>,
}

impl PtpIpTransport {
    pub fn new(config: PtpIpConfig) -> Self {
        PtpIpTransport {
            config,
            shared: Arc::default(),
            command: None,
            reader: None,
            generation: 0,
            opens: 0,
            next_tid: 0,
            session_open: false,
            responder_guid: None,
            responder_name: None,
            scratch: vec![0; CHUNK],
        }
    }

    pub fn endpoint(&self) -> SocketAddr {
        self.config.endpoint
    }

    /// The camera's 16-byte GUID from the last Init Command Ack.
    pub fn responder_guid(&self) -> Option<[u8; 16]> {
        self.responder_guid
    }

    pub fn responder_name(&self) -> Option<&str> {
        self.responder_name.as_deref()
    }

    pub fn is_live(&self) -> bool {
        self.session_open && self.shared.is_live(self.generation)
    }

    pub fn abort_handle(&self) -> PtpIpAbort {
        PtpIpAbort(self.shared.clone())
    }

    fn take_tid(&mut self) -> u32 {
        let tid = self.next_tid;
        self.next_tid = match tid.wrapping_add(1) {
            0 | u32::MAX => 1,
            n => n,
        };
        tid
    }

    /// Shuts both streams down without a terminal event and joins the event reader.
    fn abort(&mut self) {
        {
            let mut guard = self.shared.link.lock().unwrap();
            let link = &mut *guard;
            link.deliberate = true;
            link.live = None;
            for socket in link.sockets.drain(..).chain(link.pending.drain(..)) {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
        self.shared.ready.notify_all();
        if let Some(command) = self.command.take() {
            let _ = command.shutdown(Shutdown::Both);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        self.session_open = false;
    }

    fn establish(&mut self, deadline: Instant) -> Result<(), TransportError> {
        let mut command = dial(self.config.endpoint, deadline, &self.shared)?;
        {
            let mut io = Io::connecting(&mut command, &self.shared);
            write_full(
                &mut io,
                &init_command_request(&self.config.initiator_guid, &self.config.friendly_name),
                deadline,
            )?;
            let ack = read_init_ack(&mut io, deadline)?;
            self.responder_guid = Some(ack.guid);
            self.responder_name = Some(ack.name);

            let mut events = dial(self.config.endpoint, deadline, &self.shared)?;
            {
                let mut ev_io = Io::connecting(&mut events, &self.shared);
                write_full(
                    &mut ev_io,
                    &frame(packet::INIT_EVENT_REQUEST, &ack.connection.to_le_bytes()),
                    deadline,
                )?;
                read_init_event_ack(&mut ev_io, deadline)?;
            }

            let generation = self.generation;
            {
                let mut link = self.shared.link.lock().unwrap();
                if link.cancelled {
                    return Err(cancelled());
                }
                link.sockets = std::mem::take(&mut link.pending);
                link.live = Some(generation);
            }
            drop(io);
            self.command = Some(command);
            let shared = self.shared.clone();
            self.reader = Some(
                std::thread::Builder::new()
                    .name("photocull-ptpip-events".into())
                    .spawn(move || read_events(events, shared, generation))
                    .map_err(io_error)?,
            );
        }

        let reply = self.exchange(
            Operation {
                opcode: op::OPEN_SESSION,
                params: &[SESSION_ID],
            },
            DataPhase::None,
            deadline,
            0,
        )?;
        match reply.code {
            resp::OK => {}
            resp::SESSION_ALREADY_OPEN => return Err(TransportError::InUse),
            code => {
                return Err(TransportError::Native {
                    domain: "PTP".into(),
                    code: code as i64,
                    message: format!("the camera refused to open a session (0x{code:04X})"),
                })
            }
        }
        self.next_tid = 1;
        self.session_open = true;
        Ok(())
    }

    /// One transaction; any failure leaves the stream position unknown, so the pair is retired.
    fn exchange(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        deadline: Instant,
        tid: u32,
    ) -> Result<Reply, TransportError> {
        let generation = self.generation;
        let result = match self.command.as_mut() {
            Some(command) => {
                let mut io = Io::live(command, &self.shared, generation);
                run(&mut io, &mut self.scratch, request, phase, deadline, tid)
            }
            None => Err(lost()),
        };
        if result.is_err() {
            self.shared.retire(generation);
            if let Some(command) = self.command.take() {
                let _ = command.shutdown(Shutdown::Both);
            }
            self.session_open = false;
        }
        result
    }
}

impl PtpTransport for PtpIpTransport {
    fn open(&mut self, deadline: Instant) -> Result<(), TransportError> {
        self.abort();
        self.generation = self.config.generation.wrapping_add(self.opens);
        self.opens += 1;
        self.next_tid = 0;
        self.responder_guid = None;
        self.responder_name = None;
        {
            let mut link = self.shared.link.lock().unwrap();
            link.deliberate = false;
            link.events.clear();
        }
        let result = self.establish(deadline);
        if result.is_err() {
            self.abort();
            if self.shared.cancelled() {
                return Err(cancelled());
            }
        }
        result
    }

    fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        deadline: Instant,
    ) -> Result<Reply, TransportError> {
        if request.params.len() > MAX_PARAMS {
            return Err(TransportError::Framing(format!(
                "{} parameters exceed the PTP limit of {MAX_PARAMS}",
                request.params.len()
            )));
        }
        if !self.session_open || !self.shared.is_live(self.generation) {
            return Err(lost());
        }
        let tid = self.take_tid();
        self.exchange(request, phase, deadline, tid)
    }

    fn close(&mut self, deadline: Instant) -> Result<(), TransportError> {
        self.shared.link.lock().unwrap().deliberate = true;
        let mut result = Ok(());
        if self.session_open && self.shared.is_live(self.generation) {
            let tid = self.take_tid();
            result = self
                .exchange(
                    Operation {
                        opcode: op::CLOSE_SESSION,
                        params: &[],
                    },
                    DataPhase::None,
                    deadline,
                    tid,
                )
                .map(|_| ());
        }
        self.abort();
        result
    }

    fn poll_event(&mut self) -> Option<TransportEvent> {
        self.shared.link.lock().unwrap().events.pop_front()
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn wait_event(&mut self, until: Instant) -> Option<TransportEvent> {
        let mut link = self.shared.link.lock().unwrap();
        loop {
            if let Some(event) = link.events.pop_front() {
                return Some(event);
            }
            let left = until
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())?;
            link = self.shared.ready.wait_timeout(link, left).unwrap().0;
        }
    }
}

impl Drop for PtpIpTransport {
    fn drop(&mut self) {
        self.abort();
    }
}

fn lost() -> TransportError {
    TransportError::Native {
        domain: "PTP/IP".into(),
        code: 0,
        message: "the camera connection was lost".into(),
    }
}

fn closed() -> TransportError {
    TransportError::Native {
        domain: "PTP/IP".into(),
        code: 0,
        message: "the camera closed the connection".into(),
    }
}

fn cancelled() -> TransportError {
    TransportError::Native {
        domain: "PTP/IP".into(),
        code: 0,
        message: "connecting was cancelled".into(),
    }
}

fn framing(message: impl Into<String>) -> TransportError {
    TransportError::Framing(message.into())
}

fn io_error(e: io::Error) -> TransportError {
    match e.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => TransportError::TimedOut,
        // Permission is the camera's Init_Fail refusal; a local denial keeps its OS error.
        _ => TransportError::Native {
            domain: "PTP/IP".into(),
            code: e.raw_os_error().unwrap_or(0) as i64,
            message: e.to_string(),
        },
    }
}

/// The time left before `deadline`; never zero, which the socket setters reject.
fn budget(deadline: Instant) -> Result<Duration, TransportError> {
    match deadline.checked_duration_since(Instant::now()) {
        Some(d) if !d.is_zero() => Ok(d),
        _ => Err(TransportError::TimedOut),
    }
}

fn dial(
    endpoint: SocketAddr,
    deadline: Instant,
    shared: &Shared,
) -> Result<TcpStream, TransportError> {
    loop {
        if shared.cancelled() {
            return Err(cancelled());
        }
        let left = budget(deadline)?;
        match TcpStream::connect_timeout(&endpoint, left.min(DIAL_SLICE)) {
            Ok(stream) => {
                shared.track(&stream)?;
                stream.set_nodelay(true).map_err(io_error)?;
                return Ok(stream);
            }
            Err(e) if e.kind() == ErrorKind::TimedOut && left > DIAL_SLICE => {}
            Err(e) => return Err(io_error(e)),
        }
    }
}

struct Io<'a> {
    stream: &'a mut TcpStream,
    shared: &'a Shared,
    generation: Option<u64>,
}

impl<'a> Io<'a> {
    fn connecting(stream: &'a mut TcpStream, shared: &'a Shared) -> Self {
        Io {
            stream,
            shared,
            generation: None,
        }
    }

    fn live(stream: &'a mut TcpStream, shared: &'a Shared, generation: u64) -> Self {
        Io {
            stream,
            shared,
            generation: Some(generation),
        }
    }

    fn check_alive(&self) -> Result<(), TransportError> {
        if self.shared.cancelled() {
            return Err(cancelled());
        }
        if let Some(generation) = self.generation {
            if !self.shared.is_live(generation) {
                return Err(closed());
            }
        }
        Ok(())
    }
}

/// One read of at least one byte. The timeout is reset from the absolute deadline in short slices
/// so cross-thread stream retirement and cancellation wake promptly on every platform.
fn read_some(io: &mut Io<'_>, buf: &mut [u8], deadline: Instant) -> Result<usize, TransportError> {
    loop {
        io.check_alive()?;
        let left = budget(deadline)?;
        io.stream
            .set_read_timeout(Some(left.min(IO_SLICE)))
            .map_err(io_error)?;
        match io.stream.read(buf) {
            Ok(n) => return Ok(n),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                io.check_alive()?;
                budget(deadline)?;
            }
            Err(e) => return Err(io_error(e)),
        }
    }
}

/// Fills `buf`. EOF before the first byte of a packet is a closed connection; anywhere else it
/// truncates a packet.
fn read_full(
    io: &mut Io<'_>,
    buf: &mut [u8],
    deadline: Instant,
    at_boundary: bool,
) -> Result<(), TransportError> {
    let mut done = 0;
    while done < buf.len() {
        match read_some(io, &mut buf[done..], deadline)? {
            0 if at_boundary && done == 0 => return Err(closed()),
            0 => return Err(framing("the camera closed the connection inside a packet")),
            n => done += n,
        }
    }
    Ok(())
}

fn write_full(io: &mut Io<'_>, mut buf: &[u8], deadline: Instant) -> Result<(), TransportError> {
    while !buf.is_empty() {
        io.check_alive()?;
        let left = budget(deadline)?;
        io.stream
            .set_write_timeout(Some(left.min(IO_SLICE)))
            .map_err(io_error)?;
        match io.stream.write(buf) {
            Ok(0) => return Err(closed()),
            Ok(n) => buf = &buf[n..],
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                io.check_alive()?;
                budget(deadline)?;
            }
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}

fn le16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

fn frame(kind: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + body.len());
    out.extend_from_slice(&((HEADER + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// UTF-16 code units with the final NUL, at most 40 in all.
fn encode_name(name: &str) -> Vec<u16> {
    let mut units: Vec<u16> = name.encode_utf16().filter(|u| *u != 0).collect();
    if units.len() > MAX_NAME_UNITS - 1 {
        units.truncate(MAX_NAME_UNITS - 1);
        if units.last().is_some_and(|u| (0xD800..0xDC00).contains(u)) {
            units.pop();
        }
    }
    units.push(0);
    units
}

fn decode_name(bytes: &[u8]) -> Result<String, TransportError> {
    if bytes.len() < 2 || bytes.len() % 2 != 0 || bytes.len() > MAX_NAME_UNITS * 2 {
        return Err(framing("the camera name has an invalid length"));
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let (last, text) = units.split_last().expect("at least one unit");
    if *last != 0 || text.contains(&0) {
        return Err(framing("the camera name is not NUL-terminated"));
    }
    String::from_utf16(text).map_err(|_| framing("the camera name is not valid UTF-16"))
}

pub fn init_command_request(guid: &[u8; 16], name: &str) -> Vec<u8> {
    let mut body = guid.to_vec();
    for unit in encode_name(name) {
        body.extend_from_slice(&unit.to_le_bytes());
    }
    body.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    frame(packet::INIT_COMMAND_REQUEST, &body)
}

fn operation_request(phase: u32, opcode: u16, tid: u32, params: &[u32]) -> Vec<u8> {
    let mut body = Vec::with_capacity(10 + 4 * params.len());
    body.extend_from_slice(&phase.to_le_bytes());
    body.extend_from_slice(&opcode.to_le_bytes());
    body.extend_from_slice(&tid.to_le_bytes());
    for p in params {
        body.extend_from_slice(&p.to_le_bytes());
    }
    frame(packet::OPERATION_REQUEST, &body)
}

fn data_header(kind: u32, tid: u32, payload: usize) -> [u8; DATA_HEADER] {
    let mut h = [0u8; DATA_HEADER];
    h[0..4].copy_from_slice(&((DATA_HEADER + payload) as u32).to_le_bytes());
    h[4..8].copy_from_slice(&kind.to_le_bytes());
    h[8..12].copy_from_slice(&tid.to_le_bytes());
    h
}

fn init_fail(reason: u32) -> TransportError {
    match reason {
        1 => TransportError::Permission,
        2 => TransportError::InUse,
        _ => TransportError::Native {
            domain: "PTP/IP".into(),
            code: reason as i64,
            message: "the camera refused the connection".into(),
        },
    }
}

/// A header with a defined 1.0 type and a length that includes itself.
fn read_header(io: &mut Io<'_>, deadline: Instant) -> Result<(u32, u32), TransportError> {
    let mut h = [0u8; HEADER];
    read_full(io, &mut h, deadline, true)?;
    let len = le32(&h, 0).unwrap_or(0);
    let kind = le32(&h, 4).unwrap_or(0);
    if !(packet::INIT_COMMAND_REQUEST..=packet::PROBE_RESPONSE).contains(&kind) {
        return Err(framing(format!("undefined packet type 0x{kind:02X}")));
    }
    if (len as usize) < HEADER {
        return Err(framing(format!(
            "packet length {len} is shorter than its header"
        )));
    }
    Ok((len, kind))
}

/// The body of a control packet whose total length must lie in `min..=max`.
fn read_control<'a>(
    io: &mut Io<'_>,
    buf: &'a mut [u8],
    len: u32,
    min: usize,
    max: usize,
    deadline: Instant,
) -> Result<&'a [u8], TransportError> {
    let len = len as usize;
    if len < min || len > max || len - HEADER > buf.len() {
        return Err(framing(format!(
            "control packet length {len} is out of range"
        )));
    }
    let body = &mut buf[..len - HEADER];
    read_full(io, body, deadline, false)?;
    Ok(body)
}

fn read_init_fail(
    io: &mut Io<'_>,
    len: u32,
    deadline: Instant,
) -> Result<TransportError, TransportError> {
    let mut buf = [0u8; 4];
    let body = read_control(io, &mut buf, len, 12, 12, deadline)?;
    Ok(init_fail(le32(body, 0).unwrap_or(0)))
}

struct InitAck {
    connection: u32,
    guid: [u8; 16],
    name: String,
}

fn read_init_ack(io: &mut Io<'_>, deadline: Instant) -> Result<InitAck, TransportError> {
    let (len, kind) = read_header(io, deadline)?;
    match kind {
        packet::INIT_COMMAND_ACK => {}
        packet::INIT_FAIL => return Err(read_init_fail(io, len, deadline)?),
        other => {
            return Err(framing(format!(
                "expected Init Command Ack, got 0x{other:02X}"
            )))
        }
    }
    let mut buf = [0u8; 24 + 2 * MAX_NAME_UNITS];
    let body = read_control(io, &mut buf, len, 34, 32 + 2 * MAX_NAME_UNITS, deadline)?;
    let connection = le32(body, 0).unwrap_or(0);
    let mut guid = [0u8; 16];
    guid.copy_from_slice(&body[4..20]);
    let name = decode_name(&body[20..body.len() - 4])?;
    let version = le32(body, body.len() - 4).unwrap_or(0);
    if version >> 16 != PROTOCOL_VERSION >> 16 {
        return Err(framing(format!(
            "unsupported PTP/IP version {}.{}",
            version >> 16,
            version & 0xFFFF
        )));
    }
    Ok(InitAck {
        connection,
        guid,
        name,
    })
}

fn read_init_event_ack(io: &mut Io<'_>, deadline: Instant) -> Result<(), TransportError> {
    let (len, kind) = read_header(io, deadline)?;
    match kind {
        packet::INIT_EVENT_ACK if len as usize == HEADER => Ok(()),
        packet::INIT_EVENT_ACK => Err(framing(format!("Init Event Ack length {len}"))),
        packet::INIT_FAIL => Err(read_init_fail(io, len, deadline)?),
        other => Err(framing(format!(
            "expected Init Event Ack, got 0x{other:02X}"
        ))),
    }
}

/// Response code and parameters, after checking the transaction ID.
fn read_response(
    io: &mut Io<'_>,
    len: u32,
    tid: u32,
    deadline: Instant,
) -> Result<(u16, Vec<u32>), TransportError> {
    let mut buf = [0u8; 6 + 4 * MAX_PARAMS];
    let body = read_control(io, &mut buf, len, 14, 14 + 4 * MAX_PARAMS, deadline)?;
    if (body.len() - 6) % 4 != 0 {
        return Err(framing(
            "operation response parameters are not whole u32 values",
        ));
    }
    let code = le16(body, 0).unwrap_or(0);
    let got = le32(body, 2).unwrap_or(0);
    if got != tid {
        return Err(framing(format!(
            "response for transaction {got} while waiting for {tid}"
        )));
    }
    let params = body[6..]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok((code, params))
}

fn unexpected(kind: u32, wanted: &str) -> TransportError {
    framing(format!(
        "packet type 0x{kind:02X} while waiting for {wanted}"
    ))
}

fn expect_response(
    io: &mut Io<'_>,
    tid: u32,
    deadline: Instant,
    bytes_in: u64,
) -> Result<Reply, TransportError> {
    let (len, kind) = read_header(io, deadline)?;
    if kind != packet::OPERATION_RESPONSE {
        return Err(unexpected(kind, "the operation response"));
    }
    let (code, params) = read_response(io, len, tid, deadline)?;
    Ok(Reply {
        code,
        params,
        bytes_in,
    })
}

fn run(
    io: &mut Io<'_>,
    scratch: &mut [u8],
    request: Operation<'_>,
    phase: DataPhase<'_>,
    deadline: Instant,
    tid: u32,
) -> Result<Reply, TransportError> {
    let info = match phase {
        DataPhase::Out(_) => PHASE_OUT,
        _ => PHASE_NONE_OR_IN,
    };
    write_full(
        io,
        &operation_request(info, request.opcode, tid, request.params),
        deadline,
    )?;
    match phase {
        DataPhase::None => expect_response(io, tid, deadline, 0),
        DataPhase::Out(bytes) => {
            send_data(io, tid, bytes, deadline)?;
            expect_response(io, tid, deadline, 0)
        }
        DataPhase::In { sink, limit } => receive(io, scratch, tid, sink, limit, deadline),
    }
}

/// Start, Data for all but the last chunk, then the last chunk (possibly empty) in End.
fn send_data(
    io: &mut Io<'_>,
    tid: u32,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), TransportError> {
    let mut start = tid.to_le_bytes().to_vec();
    start.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    write_full(io, &frame(packet::START_DATA, &start), deadline)?;
    let mut rest = bytes;
    loop {
        let n = rest.len().min(CHUNK);
        let last = n == rest.len();
        let kind = if last { packet::END_DATA } else { packet::DATA };
        write_full(io, &data_header(kind, tid, n), deadline)?;
        write_full(io, &rest[..n], deadline)?;
        rest = &rest[n..];
        if last {
            return Ok(());
        }
    }
}

/// Streams a data-in phase straight into `sink` through the fixed scratch buffer.
fn receive(
    io: &mut Io<'_>,
    scratch: &mut [u8],
    tid: u32,
    sink: &mut (dyn Write + Send),
    limit: u64,
    deadline: Instant,
) -> Result<Reply, TransportError> {
    let (len, kind) = read_header(io, deadline)?;
    match kind {
        // An immediate response: an early camera error, or an operation with no data.
        packet::OPERATION_RESPONSE => {
            let (code, params) = read_response(io, len, tid, deadline)?;
            return Ok(Reply {
                code,
                params,
                bytes_in: 0,
            });
        }
        packet::START_DATA => {}
        other => return Err(unexpected(other, "Start Data")),
    }
    let mut buf = [0u8; 12];
    let body = read_control(io, &mut buf, len, 20, 20, deadline)?;
    let got = le32(body, 0).unwrap_or(0);
    if got != tid {
        return Err(framing(format!(
            "data for transaction {got} while waiting for {tid}"
        )));
    }
    let total = le64(body, 4).unwrap_or(0);
    let known = total != UNKNOWN_LENGTH;
    if known && total > limit {
        return Err(TransportError::Limit);
    }
    let mut received: u64 = 0;
    loop {
        let (len, kind) = read_header(io, deadline)?;
        match kind {
            packet::DATA | packet::END_DATA => {}
            packet::OPERATION_RESPONSE => {
                let (code, params) = read_response(io, len, tid, deadline)?;
                if code == resp::OK {
                    return Err(framing(
                        "the camera reported success inside an unfinished data phase",
                    ));
                }
                return Ok(Reply {
                    code,
                    params,
                    bytes_in: received,
                });
            }
            packet::START_DATA => return Err(framing("a second Start Data inside one data phase")),
            other => return Err(unexpected(other, "Data or End Data")),
        }
        if (len as usize) < DATA_HEADER {
            return Err(framing(format!("data packet length {len}")));
        }
        let mut t = [0u8; 4];
        read_full(io, &mut t, deadline, false)?;
        let got = u32::from_le_bytes(t);
        if got != tid {
            return Err(framing(format!(
                "data for transaction {got} while waiting for {tid}"
            )));
        }
        let payload = (len as usize - DATA_HEADER) as u64;
        if payload > limit.saturating_sub(received) {
            return Err(TransportError::Limit);
        }
        if known && payload > total - received {
            return Err(framing(format!(
                "more data than the {total} bytes the camera announced"
            )));
        }
        let mut left = payload;
        while left > 0 {
            let want = left.min(scratch.len() as u64) as usize;
            let n = read_some(io, &mut scratch[..want], deadline)?;
            if n == 0 {
                return Err(framing("the camera closed the connection inside a packet"));
            }
            budget(deadline)?;
            sink.write_all(&scratch[..n])
                .map_err(TransportError::Sink)?;
            left -= n as u64;
            received += n as u64;
        }
        if kind == packet::END_DATA {
            break;
        }
    }
    if known && received != total {
        return Err(framing(format!(
            "the data phase ended after {received} of {total} bytes"
        )));
    }
    expect_response(io, tid, deadline, received)
}

enum EventPacket {
    Event(u16, Vec<u32>),
    Probe,
    Ignore,
}

/// Waits without a deadline for the next frame (an idle event stream is normal), then bounds its
/// completion. Polls `IO_SLICE` while idle so retiring the generation exits promptly on macOS and
/// Windows, dropping the socket and closing the peer stream.
fn next_event_packet(io: &mut Io<'_>) -> Result<EventPacket, TransportError> {
    let mut h = [0u8; HEADER];
    io.stream
        .set_read_timeout(Some(IO_SLICE))
        .map_err(io_error)?;
    let first = loop {
        io.check_alive()?;
        match io.stream.read(&mut h) {
            Ok(0) => return Err(closed()),
            Ok(n) => break n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Err(io_error(e)),
        }
    };
    let deadline = Instant::now() + EVENT_FRAME_BUDGET;
    read_full(io, &mut h[first..], deadline, false)?;
    let len = le32(&h, 0).unwrap_or(0);
    let kind = le32(&h, 4).unwrap_or(0);
    match kind {
        packet::EVENT => {
            let mut buf = [0u8; 6 + 4 * 3];
            let body = read_control(io, &mut buf, len, 14, 14 + 4 * 3, deadline)?;
            if (body.len() - 6) % 4 != 0 {
                return Err(framing("event parameters are not whole u32 values"));
            }
            let code = le16(body, 0).unwrap_or(0);
            // The transaction ID is decoded but never matched: events are asynchronous.
            let params = body[6..]
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            Ok(EventPacket::Event(code, params))
        }
        packet::PROBE_REQUEST if len as usize == HEADER => Ok(EventPacket::Probe),
        packet::PROBE_RESPONSE if len as usize == HEADER => Ok(EventPacket::Ignore),
        other => Err(framing(format!(
            "packet type 0x{other:02X} (length {len}) on the event stream"
        ))),
    }
}

fn read_events(mut stream: TcpStream, shared: Arc<Shared>, generation: u64) {
    let mut io = Io::live(&mut stream, &shared, generation);
    loop {
        match next_event_packet(&mut io) {
            Ok(EventPacket::Event(code, params)) => {
                if !shared.push_event(generation, code, params) {
                    break;
                }
            }
            Ok(EventPacket::Probe) => {
                let deadline = Instant::now() + EVENT_FRAME_BUDGET;
                if write_full(&mut io, &frame(packet::PROBE_RESPONSE, &[]), deadline).is_err() {
                    break;
                }
            }
            Ok(EventPacket::Ignore) => {}
            Err(_) => break,
        }
    }
    shared.retire(generation);
}

#[cfg(test)]
mod tests {
    use super::super::codec::{self, Grammar};
    use super::super::fixtures::*;
    use super::super::ptp::{format, handle};
    use super::super::session::{
        ConnectionState, DrainStep, SessionConfig, SessionError, SessionEvent, SonySession,
    };
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    const GUID: [u8; 16] = [
        0x4f, 0x2a, 0x91, 0x03, 0xc7, 0x55, 0x4e, 0x10, 0x8b, 0x61, 0x02, 0xd4, 0xee, 0x37, 0x9a,
        0x18,
    ];
    const CAMERA_GUID: [u8; 16] = [
        0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
        0xe0,
    ];
    const CONNECTION: u32 = 0x7856_3412;
    const WATCHDOG: Duration = Duration::from_secs(10);
    const OPEN_SESSION_TID0: [u8; 22] = [
        0x16, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x10, 0x00,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    ];
    const OK_TID0: [u8; 14] = [
        0x0e, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x01, 0x20, 0x00, 0x00, 0x00, 0x00,
    ];
    const SONY_OBJECT_ADDED: [u8; 18] = [
        0x12, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0xc2, 0xff, 0xff, 0xff, 0xff, 0x01,
        0xc0, 0xff, 0xff,
    ];

    // The peer encodes and decodes on its own, independently of the transport's codec.

    fn u16le(v: u16) -> [u8; 2] {
        [v as u8, (v >> 8) as u8]
    }

    fn u32le(v: u32) -> [u8; 4] {
        [v as u8, (v >> 8) as u8, (v >> 16) as u8, (v >> 24) as u8]
    }

    fn u64le(v: u64) -> [u8; 8] {
        let mut b = [0u8; 8];
        for (i, x) in b.iter_mut().enumerate() {
            *x = (v >> (8 * i)) as u8;
        }
        b
    }

    fn get32(b: &[u8], at: usize) -> u32 {
        b[at] as u32 | (b[at + 1] as u32) << 8 | (b[at + 2] as u32) << 16 | (b[at + 3] as u32) << 24
    }

    fn pkt(kind: u32, parts: &[&[u8]]) -> Vec<u8> {
        let body: Vec<u8> = parts.concat();
        let mut out = u32le(8 + body.len() as u32).to_vec();
        out.extend_from_slice(&u32le(kind));
        out.extend_from_slice(&body);
        out
    }

    fn utf16z(s: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for u in s.encode_utf16().chain([0]) {
            out.extend_from_slice(&u16le(u));
        }
        out
    }

    fn response(code: u16, tid: u32, params: &[u32]) -> Vec<u8> {
        let p: Vec<u8> = params.iter().flat_map(|p| u32le(*p)).collect();
        pkt(0x07, &[&u16le(code), &u32le(tid), &p])
    }

    fn event_pkt(code: u16, params: &[u32]) -> Vec<u8> {
        let p: Vec<u8> = params.iter().flat_map(|p| u32le(*p)).collect();
        pkt(0x08, &[&u16le(code), &u32le(0xFFFF_FFFF), &p])
    }

    fn start(tid: u32, total: u64) -> Vec<u8> {
        pkt(0x09, &[&u32le(tid), &u64le(total)])
    }

    fn data(kind: u32, tid: u32, bytes: &[u8]) -> Vec<u8> {
        pkt(kind, &[&u32le(tid), bytes])
    }

    /// Deterministic TIFF-shaped RAW bytes, independent of the fixtures' fill pattern.
    fn raw_byte(i: usize) -> u8 {
        const HEAD: &[u8] = b"II*\0\x08\0\0\0";
        if i < HEAD.len() {
            HEAD[i]
        } else {
            (i.wrapping_mul(2_654_435_761) >> 11) as u8 ^ (i >> 16) as u8
        }
    }

    fn raw_block(from: usize, len: usize) -> Vec<u8> {
        (from..from + len).map(raw_byte).collect()
    }

    struct Wire(TcpStream);

    impl Wire {
        fn new(s: TcpStream) -> Wire {
            s.set_read_timeout(Some(WATCHDOG)).unwrap();
            s.set_write_timeout(Some(WATCHDOG)).unwrap();
            s.set_nodelay(true).unwrap();
            Wire(s)
        }

        fn send(&mut self, bytes: &[u8]) {
            self.0.write_all(bytes).unwrap();
        }

        /// Writes one byte at a time, splitting every header and field across TCP segments.
        fn trickle(&mut self, bytes: &[u8], gap: Duration) {
            for b in bytes {
                self.0.write_all(&[*b]).unwrap();
                thread::sleep(gap);
            }
        }

        fn exact(&mut self, n: usize) -> Vec<u8> {
            let mut buf = vec![0; n];
            self.0.read_exact(&mut buf).unwrap();
            buf
        }

        fn packet(&mut self) -> (u32, Vec<u8>) {
            let h = self.exact(8);
            let len = get32(&h, 0) as usize;
            assert!(len >= 8, "peer read length {len}");
            (get32(&h, 4), self.exact(len - 8))
        }

        /// Both directions closed by the transport, after any trailing bytes.
        fn expect_eof(&mut self) {
            let until = Instant::now() + WATCHDOG;
            let mut buf = [0u8; 256];
            loop {
                assert!(Instant::now() < until, "socket still open");
                match self.0.read(&mut buf) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::ConnectionReset => return,
                    Err(e) => panic!("waiting for EOF: {e}"),
                }
            }
        }
    }

    struct Op {
        phase: u32,
        opcode: u16,
        tid: u32,
        params: Vec<u32>,
    }

    struct Camera {
        c: Wire,
        e: Wire,
        tid: u32,
    }

    impl Camera {
        fn op(&mut self) -> Op {
            let (kind, body) = self.c.packet();
            assert_eq!(kind, 0x06, "expected an operation request");
            assert!(body.len() >= 10 && (body.len() - 10) % 4 == 0);
            Op {
                phase: get32(&body, 0),
                opcode: body[4] as u16 | (body[5] as u16) << 8,
                tid: get32(&body, 6),
                params: body[10..].chunks(4).map(|c| get32(c, 0)).collect(),
            }
        }

        /// Reads an operation and checks it continues the transaction sequence.
        fn expect(&mut self, opcode: u16, params: &[u32]) -> Op {
            let op = self.op();
            assert_eq!(op.opcode, opcode, "opcode {:04X}", op.opcode);
            assert_eq!(op.params, params, "params for {opcode:04X}");
            assert_eq!(op.tid, self.tid, "transaction ID for {opcode:04X}");
            self.tid += 1;
            op
        }

        fn reply_in(&mut self, op: &Op, bytes: &[u8]) {
            assert_eq!(op.phase, 1);
            let mut all = start(op.tid, bytes.len() as u64);
            all.extend(data(0x0C, op.tid, bytes));
            all.extend(response(0x2001, op.tid, &[]));
            self.c.send(&all);
        }

        fn ok(&mut self, op: &Op) {
            self.c.send(&response(0x2001, op.tid, &[]));
        }

        /// Reads Start, Data*, End and returns the dataset.
        fn data_out(&mut self, tid: u32) -> Vec<u8> {
            let (kind, body) = self.c.packet();
            assert_eq!((kind, body.len()), (0x09, 12));
            assert_eq!(get32(&body, 0), tid);
            let total = get32(&body, 4) as usize;
            let mut out = Vec::new();
            loop {
                let (kind, body) = self.c.packet();
                assert_eq!(get32(&body, 0), tid);
                out.extend_from_slice(&body[4..]);
                match kind {
                    0x0A => {}
                    0x0C => break,
                    k => panic!("packet {k:02X} in data-out"),
                }
            }
            assert_eq!(out.len(), total);
            out
        }
    }

    fn listen() -> (TcpListener, SocketAddr) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        (l, addr)
    }

    fn accept_one(l: &TcpListener) -> Wire {
        l.set_nonblocking(true).unwrap();
        let until = Instant::now() + WATCHDOG;
        loop {
            match l.accept() {
                Ok((s, _)) => {
                    s.set_nonblocking(false).unwrap();
                    return Wire::new(s);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "no connection");
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("accept: {e}"),
            }
        }
    }

    fn config(addr: SocketAddr) -> PtpIpConfig {
        PtpIpConfig {
            endpoint: addr,
            initiator_guid: GUID,
            friendly_name: "PhotoCull".into(),
            generation: 100,
        }
    }

    fn init_ack() -> Vec<u8> {
        pkt(
            0x02,
            &[
                &u32le(CONNECTION),
                &CAMERA_GUID,
                &utf16z("ILCE-7CM2"),
                &u32le(0x0001_0000),
            ],
        )
    }

    /// Accepts C, checks Init Command Request, answers it and returns C.
    fn accept_command(l: &TcpListener, ack_delay: Duration) -> Wire {
        let mut c = accept_one(l);
        let (kind, body) = c.packet();
        assert_eq!(kind, 0x01, "the first connection is the command stream");
        assert_eq!(&body[..16], &GUID);
        assert_eq!(&body[16..body.len() - 4], utf16z("PhotoCull").as_slice());
        assert_eq!(&body[body.len() - 4..], &[0x00, 0x00, 0x01, 0x00]);
        thread::sleep(ack_delay);
        c.send(&init_ack());
        c
    }

    /// The full init handshake plus OpenSession, compared byte for byte.
    fn accept_camera(l: &TcpListener) -> Camera {
        let mut c = accept_command(l, Duration::ZERO);
        let mut e = accept_one(l);
        let (kind, body) = e.packet();
        assert_eq!(kind, 0x03);
        assert_eq!(body, [0x12, 0x34, 0x56, 0x78]);
        e.send(&pkt(0x04, &[]));
        assert_eq!(c.exact(22), OPEN_SESSION_TID0);
        c.send(&OK_TID0);
        Camera { c, e, tid: 1 }
    }

    fn deadline(secs: u64) -> Instant {
        Instant::now() + Duration::from_secs(secs)
    }

    fn opened(addr: SocketAddr) -> PtpIpTransport {
        let mut t = PtpIpTransport::new(config(addr));
        t.open(deadline(5)).unwrap();
        t
    }

    /// Serves the α7C II negotiation and first snapshot.
    fn serve_handshake(cam: &mut Camera, busy_first: bool) {
        if busy_first {
            let op = cam.expect(op::GET_DEVICE_INFO, &[]);
            cam.c.send(&response(0x2019, op.tid, &[]));
        }
        let op = cam.expect(op::GET_DEVICE_INFO, &[]);
        cam.reply_in(&op, &device_info("ILCE-7CM2").encode());
        for phase in [1, 2] {
            let op = cam.expect(op::SDIO_CONNECT, &[phase, 0, 0]);
            cam.reply_in(&op, &[0; 8]);
        }
        let op = cam.expect(op::SDIO_GET_EXT_DEVICE_INFO, &[0x12C, 1]);
        cam.reply_in(&op, &cm2_ext_device_info());
        let op = cam.expect(op::SDIO_CONNECT, &[3, 0, 0]);
        cam.reply_in(&op, &[0; 8]);
        let op = cam.expect(op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO, &[]);
        cam.reply_in(
            &op,
            &codec::encode_snapshot(&cm2_descriptors(), Grammar::TwoList),
        );
    }

    fn serve_close(cam: &mut Camera) {
        let tid = cam.tid;
        let close = cam.c.exact(18);
        let mut want = vec![0x12, 0, 0, 0, 0x06, 0, 0, 0, 0x01, 0, 0, 0, 0x03, 0x10];
        want.extend_from_slice(&u32le(tid));
        assert_eq!(close, want, "CloseSession bytes");
        cam.c.send(&response(0x2001, tid, &[]));
        cam.c.expect_eof();
        cam.e.expect_eof();
    }

    fn session(addr: SocketAddr) -> SonySession<PtpIpTransport> {
        SonySession::new(
            PtpIpTransport::new(config(addr)),
            SessionConfig {
                open_timeout: Duration::from_secs(5),
                command_timeout: Duration::from_secs(5),
                transfer_timeout: Duration::from_secs(20),
                ..SessionConfig::default()
            },
        )
    }

    fn assert_lost_once(t: &mut PtpIpTransport) {
        let generation = t.generation();
        assert_eq!(
            t.wait_event(deadline(5)),
            Some(TransportEvent::SessionLost { generation })
        );
        assert_eq!(t.poll_event(), None, "exactly one terminal event");
    }

    #[test]
    fn sony_session_connects_negotiates_and_closes_over_two_streams() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            for _ in 0..2 {
                let mut cam = accept_camera(&l);
                serve_handshake(&mut cam, false);
                serve_close(&mut cam);
            }
        });
        let mut s = session(addr);
        s.connect().unwrap();
        assert_eq!(s.state(), ConnectionState::Ready);
        assert_eq!(s.sdi_version(), 300);
        assert!(s.extended_codes());
        assert_eq!(s.device().unwrap().model, "ILCE-7CM2");
        assert_eq!(s.transport().responder_guid(), Some(CAMERA_GUID));
        assert_eq!(s.transport().responder_name(), Some("ILCE-7CM2"));
        let first = s.transport().generation();
        assert_eq!(first, 100);
        s.close().unwrap();
        assert_eq!(
            s.transport_mut().poll_event(),
            None,
            "a deliberate close is not a loss"
        );

        s.connect().unwrap();
        assert_eq!(s.state(), ConnectionState::Ready);
        assert_eq!(s.transport().generation(), first + 1);
        s.close().unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn device_busy_reaches_the_session_and_the_retry_takes_a_fresh_transaction() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            serve_handshake(&mut cam, true);
            serve_close(&mut cam);
        });
        let mut s = session(addr);
        s.connect().unwrap();
        assert_eq!(s.state(), ConnectionState::Ready);
        s.close().unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn split_and_coalesced_frames_parameters_and_data_out() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            let gap = Duration::from_millis(1);

            // Zero parameters, response trickled byte by byte with three parameters.
            let raw = cam.c.exact(18);
            assert_eq!(
                raw,
                [0x12, 0, 0, 0, 0x06, 0, 0, 0, 0x01, 0, 0, 0, 0x16, 0x10, 0x01, 0, 0, 0]
            );
            cam.c
                .trickle(&response(0x2001, 1, &[7, 8, 0xFFFF_FFFF]), gap);

            // Five parameters, the request's exact bytes.
            let raw = cam.c.exact(38);
            let mut want = vec![0x26, 0, 0, 0, 0x06, 0, 0, 0, 0x01, 0, 0, 0, 0x34, 0x12];
            want.extend_from_slice(&u32le(2));
            for p in [1u32, 2, 3, 4, 0xA1B2_C3D4] {
                want.extend_from_slice(&u32le(p));
            }
            assert_eq!(raw, want);
            cam.c.send(&response(0x2001, 2, &[]));

            // Data-in, every packet coalesced into one write.
            cam.tid = 3;
            let op = cam.expect(0x9202, &[0x12C, 1]);
            let mut all = start(op.tid, 6);
            all.extend(data(0x0A, op.tid, b"abc"));
            all.extend(data(0x0A, op.tid, b""));
            all.extend(data(0x0C, op.tid, b"def"));
            all.extend(response(0x2001, op.tid, &[]));
            cam.c.send(&all);

            // Data-in, trickled.
            let op = cam.expect(0x9202, &[0x12C, 1]);
            let mut all = start(op.tid, 4);
            all.extend(data(0x0C, op.tid, b"wxyz"));
            all.extend(response(0x2001, op.tid, &[]));
            cam.c.trickle(&all, gap);

            // Data-out, populated: phase 2 and the exact Start/End vectors.
            let raw = cam.c.exact(22);
            let mut want = vec![0x16, 0, 0, 0, 0x06, 0, 0, 0, 0x02, 0, 0, 0, 0x07, 0x92];
            want.extend_from_slice(&u32le(5));
            want.extend_from_slice(&u32le(0xD2C1));
            assert_eq!(raw, want);
            let mut want = start(5, 2);
            want.extend(data(0x0C, 5, &[0x02, 0x00]));
            assert_eq!(cam.c.exact(want.len()), want);
            cam.c.send(&response(0x2001, 5, &[]));

            // Data-out, empty: Start(0) and a bare 12-byte End.
            let op = {
                cam.tid = 6;
                cam.expect(0x9207, &[0xD2C2])
            };
            assert_eq!(op.phase, 2);
            let mut want = start(6, 0);
            want.extend([0x0C, 0, 0, 0, 0x0C, 0, 0, 0, 6, 0, 0, 0]);
            assert_eq!(cam.c.exact(want.len()), want);
            cam.c.send(&response(0x2001, 6, &[]));

            // Data-out across several Data packets.
            let op = cam.expect(0x9205, &[0x5007]);
            let big = raw_block(0, 150_000);
            assert_eq!(cam.data_out(op.tid), big);
            cam.ok(&op);

            // A camera error before Start: the transaction completes with no bytes.
            let op = cam.expect(0x1009, &[0xFFFF_C001]);
            cam.c.send(&response(0x2002, op.tid, &[0x55]));
            // Busy is a complete response, not a failure.
            let op = cam.expect(0x9207, &[0xD2C1]);
            assert_eq!(cam.data_out(op.tid), [0x01, 0x00]);
            cam.c.send(&response(0x2019, op.tid, &[]));
            // Empty dataset: Start(0) + empty End.
            let op = cam.expect(0x9202, &[0x12C, 1]);
            let mut all = start(op.tid, 0);
            all.extend(data(0x0C, op.tid, b""));
            all.extend(response(0x2001, op.tid, &[]));
            cam.c.send(&all);

            // Events with zero and three parameters.
            cam.e.send(&event_pkt(0xC203, &[]));
            cam.e.trickle(&event_pkt(0x4002, &[1, 2, 3]), gap);
            serve_close(&mut cam);
        });

        let mut t = opened(addr);
        let reply = t
            .transact(
                Operation {
                    opcode: 0x1016,
                    params: &[],
                },
                DataPhase::None,
                deadline(5),
            )
            .unwrap();
        assert_eq!(reply.code, resp::OK);
        assert_eq!(reply.params, [7, 8, 0xFFFF_FFFF]);
        let reply = t
            .transact(
                Operation {
                    opcode: 0x1234,
                    params: &[1, 2, 3, 4, 0xA1B2_C3D4],
                },
                DataPhase::None,
                deadline(5),
            )
            .unwrap();
        assert_eq!(reply, Reply::ok(0));
        assert!(matches!(
            t.transact(
                Operation {
                    opcode: 0x1234,
                    params: &[1, 2, 3, 4, 5, 6],
                },
                DataPhase::None,
                deadline(5),
            ),
            Err(TransportError::Framing(_))
        ));

        for want in [&b"abcdef"[..], b"wxyz"] {
            let mut sink = Vec::new();
            let reply = t
                .transact(
                    Operation {
                        opcode: 0x9202,
                        params: &[0x12C, 1],
                    },
                    DataPhase::In {
                        sink: &mut sink,
                        limit: 64,
                    },
                    deadline(5),
                )
                .unwrap();
            assert_eq!((reply.code, reply.bytes_in), (resp::OK, want.len() as u64));
            assert_eq!(sink, want);
        }

        for (opcode, param, bytes) in [
            (0x9207u16, 0xD2C1u32, &[0x02u8, 0x00][..]),
            (0x9207, 0xD2C2, &[]),
        ] {
            let reply = t
                .transact(
                    Operation {
                        opcode,
                        params: &[param],
                    },
                    DataPhase::Out(bytes),
                    deadline(5),
                )
                .unwrap();
            assert_eq!(reply.code, resp::OK);
        }
        let big = raw_block(0, 150_000);
        t.transact(
            Operation {
                opcode: 0x9205,
                params: &[0x5007],
            },
            DataPhase::Out(&big),
            deadline(5),
        )
        .unwrap();

        let mut sink = Vec::new();
        let reply = t
            .transact(
                Operation {
                    opcode: 0x1009,
                    params: &[0xFFFF_C001],
                },
                DataPhase::In {
                    sink: &mut sink,
                    limit: 1 << 20,
                },
                deadline(5),
            )
            .unwrap();
        assert_eq!(
            reply,
            Reply {
                code: 0x2002,
                params: vec![0x55],
                bytes_in: 0
            }
        );
        assert!(sink.is_empty());
        let reply = t
            .transact(
                Operation {
                    opcode: 0x9207,
                    params: &[0xD2C1],
                },
                DataPhase::Out(&[0x01, 0x00]),
                deadline(5),
            )
            .unwrap();
        assert_eq!(reply.code, resp::DEVICE_BUSY);
        let mut sink = Vec::new();
        let reply = t
            .transact(
                Operation {
                    opcode: 0x9202,
                    params: &[0x12C, 1],
                },
                DataPhase::In {
                    sink: &mut sink,
                    limit: 64,
                },
                deadline(5),
            )
            .unwrap();
        assert_eq!((reply.code, reply.bytes_in), (resp::OK, 0));

        let generation = t.generation();
        assert_eq!(
            t.wait_event(deadline(5)),
            Some(TransportEvent::Ptp {
                generation,
                code: 0xC203,
                params: vec![]
            })
        );
        assert_eq!(
            t.wait_event(deadline(5)),
            Some(TransportEvent::Ptp {
                generation,
                code: 0x4002,
                params: vec![1, 2, 3]
            })
        );
        t.close(deadline(5)).unwrap();
        peer.join().unwrap();
    }

    /// Records every write; the first one is reported over `first`.
    struct ProbeSink {
        data: Vec<u8>,
        largest: usize,
        first: Option<mpsc::Sender<()>>,
    }

    impl Write for ProbeSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if let Some(tx) = self.first.take() {
                let _ = tx.send(());
            }
            self.largest = self.largest.max(buf.len());
            self.data.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum Shape {
        /// One huge End packet, the second half held back until the sink has seen bytes.
        PausedEnd,
        DataThenEmptyEnd,
        UnknownTotal,
        SmallEnd,
    }

    fn serve_capture(cam: &mut Camera, shape: Shape, len: usize, first: &mpsc::Receiver<()>) {
        cam.e.send(&SONY_OBJECT_ADDED);
        let op = cam.expect(op::GET_OBJECT_INFO, &[handle::CAPTURE]);
        cam.reply_in(
            &op,
            &object_info(format::SONY_ARW, "DSC00001.ARW", len as u32, 1),
        );
        let op = cam.expect(op::GET_OBJECT, &[handle::CAPTURE]);
        let tid = op.tid;
        match shape {
            Shape::PausedEnd => {
                let half = len / 2;
                let mut head = start(tid, len as u64);
                head.extend(&u32le(12 + len as u32));
                head.extend(&u32le(0x0C));
                head.extend(&u32le(tid));
                head.extend(raw_block(0, half));
                cam.c.send(&head);
                first
                    .recv_timeout(Duration::from_secs(5))
                    .expect("the sink saw no bytes before the rest of the End packet was sent");
                // While the command stream is paused mid-packet, the event stream stays live.
                cam.e.send(&pkt(0x0D, &[]));
                let (kind, body) = cam.e.packet();
                assert_eq!((kind, body.len()), (0x0E, 0), "probe answered");
                cam.e.send(&event_pkt(0xC203, &[]));
                for at in (half..len).step_by(1 << 20) {
                    cam.c.send(&raw_block(at, (1 << 20).min(len - at)));
                }
            }
            Shape::DataThenEmptyEnd | Shape::UnknownTotal => {
                let total = match shape {
                    Shape::UnknownTotal => u64::MAX,
                    _ => len as u64,
                };
                cam.c.send(&start(tid, total));
                let tail = if matches!(shape, Shape::UnknownTotal) {
                    1000
                } else {
                    0
                };
                let body = len - tail;
                for at in (0..body).step_by(100_000) {
                    cam.c
                        .send(&data(0x0A, tid, &raw_block(at, 100_000.min(body - at))));
                }
                cam.c.send(&data(0x0C, tid, &raw_block(body, tail)));
            }
            Shape::SmallEnd => {
                let mut all = start(tid, len as u64);
                all.extend(data(0x0C, tid, &raw_block(0, len)));
                cam.c.send(&all);
            }
        }
        cam.c.send(&response(0x2001, tid, &[]));
    }

    #[test]
    fn captured_raw_streams_to_the_sink_while_events_and_probes_arrive() {
        let (l, addr) = listen();
        let shapes = [
            (Shape::PausedEnd, 4 << 20),
            (Shape::DataThenEmptyEnd, 300_000),
            (Shape::UnknownTotal, 250_001),
            (Shape::SmallEnd, 777),
        ];
        let (tx, rx) = mpsc::channel();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            serve_handshake(&mut cam, false);
            for (shape, len) in shapes {
                serve_capture(&mut cam, shape, len, &rx);
            }
            serve_close(&mut cam);
        });
        let mut s = session(addr);
        s.connect().unwrap();
        for (i, (shape, len)) in shapes.into_iter().enumerate() {
            while !s.object_announced() {
                let event = s.transport_mut().wait_event(deadline(5)).unwrap();
                s.apply_event(event);
            }
            let first = (i == 0).then(|| tx.clone());
            let step = s
                .drain_one(|info, _| {
                    assert_eq!(info.compressed_size as usize, len);
                    Ok(ProbeSink {
                        data: Vec::new(),
                        largest: 0,
                        first,
                    })
                })
                .unwrap();
            let DrainStep::Object(object, sink) = step else {
                panic!("no object for shape {i}");
            };
            assert_eq!(object.bytes, len as u64);
            assert_eq!(sink.data.len(), len);
            assert!(sink.data == raw_block(0, len), "bytes differ for shape {i}");
            assert!(sink.largest <= CHUNK, "a {} byte write", sink.largest);
            if matches!(shape, Shape::PausedEnd) {
                let mut dirty = s.process_events().contains(&SessionEvent::PropertiesDirty);
                while !dirty {
                    let event = s.transport_mut().wait_event(deadline(5)).unwrap();
                    dirty = s.apply_event(event) == Some(SessionEvent::PropertiesDirty);
                }
            }
        }
        s.close().unwrap();
        peer.join().unwrap();
    }

    struct FailingSink(usize);

    impl Write for FailingSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.0 == 0 {
                return Err(io::Error::new(ErrorKind::Other, "disk refused"));
            }
            let n = buf.len().min(self.0);
            self.0 -= n;
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug, PartialEq)]
    enum Family {
        Framing,
        Limit,
        Closed,
        Sink,
        TimedOut,
    }

    fn family(e: &TransportError) -> Family {
        match e {
            TransportError::Framing(_) => Family::Framing,
            TransportError::Limit => Family::Limit,
            TransportError::Native { domain, .. } if domain == "PTP/IP" => Family::Closed,
            TransportError::Sink(_) => Family::Sink,
            TransportError::TimedOut => Family::TimedOut,
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn malformed_or_partial_transfers_poison_both_streams_once() {
        type Script = fn(&mut Wire, u32);
        let cases: Vec<(&str, Script, Family)> = vec![
            (
                "short response",
                |c, tid| {
                    let mut r = response(0x2001, tid, &[]);
                    r.truncate(13);
                    r[0] = 13;
                    c.send(&r);
                },
                Family::Framing,
            ),
            (
                "oversized response",
                |c, tid| {
                    c.send(&response(0x2001, tid, &[0; 6]));
                },
                Family::Framing,
            ),
            (
                "unaligned parameter tail",
                |c, tid| {
                    c.send(&pkt(0x07, &[&u16le(0x2001), &u32le(tid), &[1, 2]]));
                },
                Family::Framing,
            ),
            (
                "wrong transaction",
                |c, tid| {
                    c.send(&response(0x2001, tid + 1, &[]));
                },
                Family::Framing,
            ),
            (
                "reserved type",
                |c, tid| {
                    c.send(&pkt(0x0F, &[&u32le(tid)]));
                },
                Family::Framing,
            ),
            (
                "probe on the command stream",
                |c, _| {
                    c.send(&pkt(0x0D, &[]));
                },
                Family::Framing,
            ),
            (
                "End before Start",
                |c, tid| {
                    c.send(&data(0x0C, tid, b"abc"));
                },
                Family::Framing,
            ),
            (
                "duplicate Start",
                |c, tid| {
                    let mut all = start(tid, 3);
                    all.extend(start(tid, 3));
                    c.send(&all);
                },
                Family::Framing,
            ),
            (
                "Data for another transaction",
                |c, tid| {
                    let mut all = start(tid, 3);
                    all.extend(data(0x0C, tid + 1, b"abc"));
                    c.send(&all);
                },
                Family::Framing,
            ),
            (
                "more than announced",
                |c, tid| {
                    let mut all = start(tid, 3);
                    all.extend(data(0x0C, tid, b"abcdef"));
                    c.send(&all);
                },
                Family::Framing,
            ),
            (
                "less than announced",
                |c, tid| {
                    let mut all = start(tid, 9);
                    all.extend(data(0x0C, tid, b"abc"));
                    all.extend(response(0x2001, tid, &[]));
                    c.send(&all);
                },
                Family::Framing,
            ),
            (
                "announced over the limit",
                |c, tid| {
                    c.send(&start(tid, 101));
                },
                Family::Limit,
            ),
            (
                "unknown total over the limit",
                |c, tid| {
                    let mut all = start(tid, u64::MAX);
                    all.extend(data(0x0A, tid, &[0; 60]));
                    all.extend(data(0x0A, tid, &[0; 60]));
                    c.send(&all);
                },
                Family::Limit,
            ),
            (
                "success inside the data phase",
                |c, tid| {
                    let mut all = start(tid, 6);
                    all.extend(data(0x0A, tid, b"abc"));
                    all.extend(response(0x2001, tid, &[]));
                    c.send(&all);
                },
                Family::Framing,
            ),
            (
                "short EOF",
                |c, tid| {
                    let mut all = start(tid, 50);
                    all.extend(&u32le(62));
                    all.extend(&u32le(0x0C));
                    all.extend(&u32le(tid));
                    all.extend(&[0; 10]);
                    c.send(&all);
                    c.0.shutdown(Shutdown::Write).unwrap();
                },
                Family::Framing,
            ),
            (
                "missing final response",
                |c, tid| {
                    let mut all = start(tid, 3);
                    all.extend(data(0x0C, tid, b"abc"));
                    c.send(&all);
                    c.0.shutdown(Shutdown::Write).unwrap();
                },
                Family::Closed,
            ),
        ];
        for (name, script, want) in cases {
            let (l, addr) = listen();
            let peer = thread::spawn(move || {
                let mut cam = accept_camera(&l);
                let op = cam.expect(0x1009, &[0xFFFF_C001]);
                script(&mut cam.c, op.tid);
                cam.e.expect_eof();
                cam.c.expect_eof();
            });
            let mut t = opened(addr);
            let mut sink = Vec::new();
            let err = t
                .transact(
                    Operation {
                        opcode: 0x1009,
                        params: &[0xFFFF_C001],
                    },
                    DataPhase::In {
                        sink: &mut sink,
                        limit: 100,
                    },
                    deadline(5),
                )
                .expect_err(name);
            assert_eq!(family(&err), want, "{name}: {err:?}");
            assert_lost_once(&mut t);
            assert!(
                t.transact(
                    Operation {
                        opcode: 0x1001,
                        params: &[]
                    },
                    DataPhase::None,
                    deadline(1)
                )
                .is_err(),
                "{name}: a poisoned stream is never reused"
            );
            peer.join()
                .unwrap_or_else(|_| panic!("{name}: peer failed"));
        }
    }

    #[test]
    fn a_refusing_sink_keeps_its_error_and_retires_the_pair() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            let op = cam.expect(0x1009, &[0xFFFF_C001]);
            let mut all = start(op.tid, 200_000);
            all.extend(data(0x0C, op.tid, &raw_block(0, 200_000)));
            all.extend(response(0x2001, op.tid, &[]));
            let _ = cam.c.0.write_all(&all);
            cam.e.expect_eof();
            cam.c.expect_eof();
        });
        let mut t = opened(addr);
        let mut sink = FailingSink(1000);
        let err = t
            .transact(
                Operation {
                    opcode: 0x1009,
                    params: &[0xFFFF_C001],
                },
                DataPhase::In {
                    sink: &mut sink,
                    limit: 1 << 20,
                },
                deadline(5),
            )
            .unwrap_err();
        match err {
            TransportError::Sink(e) => assert_eq!(e.to_string(), "disk refused"),
            other => panic!("{other:?}"),
        }
        assert_lost_once(&mut t);
        peer.join().unwrap();
    }

    #[test]
    fn init_failures_and_malformed_acks_free_both_sockets() {
        // (on the event stream, reason, expected)
        let cases = [
            (false, 1u32, "permission"),
            (false, 2, "busy"),
            (false, 3, "native"),
            (true, 1, "permission"),
            (true, 2, "busy"),
            (true, 3, "native"),
        ];
        for (on_event, reason, want) in cases {
            let (l, addr) = listen();
            let peer = thread::spawn(move || {
                let mut c = accept_one(&l);
                let (kind, _) = c.packet();
                assert_eq!(kind, 0x01);
                if !on_event {
                    c.send(&pkt(0x05, &[&u32le(reason)]));
                    c.expect_eof();
                    return;
                }
                c.send(&init_ack());
                let mut e = accept_one(&l);
                let (kind, _) = e.packet();
                assert_eq!(kind, 0x03);
                e.send(&pkt(0x05, &[&u32le(reason)]));
                e.expect_eof();
                c.expect_eof();
            });
            let mut t = PtpIpTransport::new(config(addr));
            let err = t.open(deadline(5)).unwrap_err();
            let got = match err {
                TransportError::Permission => "permission",
                TransportError::InUse => "busy",
                TransportError::Native { code, .. } if code == reason as i64 => "native",
                other => panic!("{other:?}"),
            };
            assert_eq!(got, want);
            assert_eq!(t.poll_event(), None, "a failed open is not a lost session");
            peer.join().unwrap();
        }

        // A camera name without its terminator, and an event stream closed during init.
        for case in ["no terminator", "event refused"] {
            let (l, addr) = listen();
            let peer = thread::spawn(move || {
                let mut c = accept_one(&l);
                c.packet();
                if case == "no terminator" {
                    let mut name = utf16z("ILCE-7CM2");
                    name.truncate(name.len() - 2);
                    c.send(&pkt(
                        0x02,
                        &[&u32le(CONNECTION), &CAMERA_GUID, &name, &u32le(0x0001_0000)],
                    ));
                } else {
                    c.send(&init_ack());
                    drop(accept_one(&l));
                }
                c.expect_eof();
            });
            let mut t = PtpIpTransport::new(config(addr));
            let err = t.open(deadline(5)).unwrap_err();
            match case {
                "no terminator" => assert!(matches!(err, TransportError::Framing(_)), "{err:?}"),
                _ => assert_eq!(family(&err), Family::Closed, "{err:?}"),
            }
            peer.join().unwrap();
        }
    }

    #[test]
    fn an_abort_ends_pairing_at_once_and_every_later_open() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut c = accept_one(&l);
            assert_eq!(c.packet().0, 0x01);
            // The photographer never confirms; only the abort ends the wait.
            c.expect_eof();
        });
        let mut t = PtpIpTransport::new(config(addr));
        let abort = t.abort_handle();
        let aborter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            abort.abort();
        });
        let began = Instant::now();
        let err = t.open(deadline(30)).unwrap_err();
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "{:?}",
            began.elapsed()
        );
        assert!(
            matches!(&err, TransportError::Native { message, .. } if message.contains("cancelled")),
            "{err:?}"
        );
        assert_eq!(t.poll_event(), None);
        aborter.join().unwrap();
        peer.join().unwrap();

        let began = Instant::now();
        assert!(t.open(deadline(30)).is_err());
        assert!(began.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_local_permission_error_is_not_the_camera_refusing_pairing() {
        let err = io_error(io::Error::from(ErrorKind::PermissionDenied));
        assert!(matches!(err, TransportError::Native { .. }), "{err:?}");
    }

    #[test]
    fn deadlines_are_absolute_and_pairing_uses_the_open_budget() {
        // A response trickled slower than the absolute deadline, every gap well under it.
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            let op = cam.expect(0x1001, &[]);
            let bytes = response(0x2001, op.tid, &[]);
            for b in bytes {
                if cam.c.0.write_all(&[b]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            cam.e.expect_eof();
        });
        let mut t = opened(addr);
        let began = Instant::now();
        let err = t
            .transact(
                Operation {
                    opcode: 0x1001,
                    params: &[],
                },
                DataPhase::None,
                Instant::now() + Duration::from_millis(450),
            )
            .unwrap_err();
        assert!(matches!(err, TransportError::TimedOut), "{err:?}");
        assert!(began.elapsed() < Duration::from_millis(1000));
        assert_lost_once(&mut t);
        peer.join().unwrap();

        // A missing OpenSession reply ends the open at its deadline and frees both sockets.
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut c = accept_command(&l, Duration::ZERO);
            let mut e = accept_one(&l);
            e.packet();
            e.send(&pkt(0x04, &[]));
            assert_eq!(c.exact(22), OPEN_SESSION_TID0);
            c.expect_eof();
            e.expect_eof();
        });
        let mut t = PtpIpTransport::new(config(addr));
        let err = t
            .open(Instant::now() + Duration::from_millis(400))
            .unwrap_err();
        assert!(matches!(err, TransportError::TimedOut), "{err:?}");
        peer.join().unwrap();

        // First pairing: the Ack waits on the photographer beyond the command timeout.
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut c = accept_command(&l, Duration::from_millis(1500));
            let mut e = accept_one(&l);
            e.packet();
            e.send(&pkt(0x04, &[]));
            assert_eq!(c.exact(22), OPEN_SESSION_TID0);
            c.send(&OK_TID0);
            let mut cam = Camera { c, e, tid: 1 };
            serve_handshake(&mut cam, false);
            serve_close(&mut cam);
        });
        let mut s = SonySession::new(
            PtpIpTransport::new(config(addr)),
            SessionConfig {
                open_timeout: Duration::from_secs(6),
                command_timeout: Duration::from_millis(1000),
                ..SessionConfig::default()
            },
        );
        s.connect().unwrap();
        assert_eq!(s.state(), ConnectionState::Ready);
        s.close().unwrap();
        peer.join().unwrap();

        // The same delay with only the command budget for opening fails.
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut c = accept_one(&l);
            assert_eq!(c.packet().0, 0x01);
            c.expect_eof();
        });
        let mut s = SonySession::new(
            PtpIpTransport::new(config(addr)),
            SessionConfig {
                open_timeout: Duration::from_millis(1000),
                ..SessionConfig::default()
            },
        );
        assert!(matches!(
            s.connect(),
            Err(SessionError::Transport(TransportError::TimedOut))
        ));
        peer.join().unwrap();
    }

    #[test]
    fn a_lost_event_stream_wakes_waiters_and_reconnects_cleanly() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            // A transaction blocked on the command stream while the event stream dies.
            let op = cam.expect(0x1001, &[]);
            assert_eq!(op.tid, 1);
            cam.e.send(&event_pkt(0xC203, &[]));
            thread::sleep(Duration::from_millis(100));
            cam.e.0.shutdown(Shutdown::Both).unwrap();
            cam.c.expect_eof();
            // A fresh handshake; nothing of the old generation survives.
            let mut cam = accept_camera(&l);
            cam.e.send(&event_pkt(0xC201, &[handle::CAPTURE]));
            serve_close(&mut cam);
        });
        let mut t = opened(addr);
        let old = t.generation();
        let began = Instant::now();
        let err = t
            .transact(
                Operation {
                    opcode: 0x1001,
                    params: &[],
                },
                DataPhase::None,
                deadline(8),
            )
            .unwrap_err();
        assert_eq!(family(&err), Family::Closed, "{err:?}");
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "blocked read woke"
        );
        assert_eq!(
            t.wait_event(deadline(5)),
            Some(TransportEvent::Ptp {
                generation: old,
                code: 0xC203,
                params: vec![]
            })
        );
        assert_lost_once(&mut t);

        t.open(deadline(5)).unwrap();
        assert_eq!(t.generation(), old + 1);
        assert_eq!(
            t.wait_event(deadline(5)),
            Some(TransportEvent::Ptp {
                generation: old + 1,
                code: 0xC201,
                params: vec![handle::CAPTURE]
            })
        );
        t.close(deadline(5)).unwrap();
        assert_eq!(t.poll_event(), None);
        // Repeated cleanup is harmless.
        t.close(deadline(1)).unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn a_waiter_blocked_on_an_idle_event_stream_wakes_on_disconnect() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            thread::sleep(Duration::from_millis(300));
            drop(cam.e);
            cam.c.expect_eof();
        });
        let mut t = opened(addr);
        let began = Instant::now();
        let generation = t.generation();
        assert_eq!(
            t.wait_event(deadline(8)),
            Some(TransportEvent::SessionLost { generation })
        );
        assert!(began.elapsed() < Duration::from_secs(3));
        peer.join().unwrap();
    }

    #[test]
    fn property_events_coalesce_while_object_events_keep_their_order() {
        let (l, addr) = listen();
        let peer = thread::spawn(move || {
            let mut cam = accept_camera(&l);
            let mut all = Vec::new();
            for _ in 0..50 {
                all.extend(event_pkt(0xC203, &[]));
            }
            all.extend(event_pkt(0xC201, &[handle::CAPTURE]));
            all.extend(event_pkt(0xC203, &[]));
            all.extend(event_pkt(0xC202, &[handle::CAPTURE]));
            all.extend(SONY_OBJECT_ADDED);
            cam.e.send(&all);
            serve_close(&mut cam);
        });
        let mut t = opened(addr);
        thread::sleep(Duration::from_millis(300));
        let mut codes = Vec::new();
        while codes.len() < 4 {
            match t.wait_event(deadline(5)) {
                Some(TransportEvent::Ptp { code, .. }) => codes.push(code),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(codes, [0xC203, 0xC201, 0xC202, 0xC201]);
        thread::sleep(Duration::from_millis(50));
        assert_eq!(t.poll_event(), None);
        t.close(deadline(5)).unwrap();
        peer.join().unwrap();
    }

    #[test]
    fn friendly_names_are_bounded_and_terminated() {
        let packet = init_command_request(&GUID, &"é".repeat(60));
        assert_eq!(get32(&packet, 0) as usize, packet.len());
        assert_eq!(packet.len(), 28 + 2 * 40);
        assert_eq!(&packet[packet.len() - 6..], &[0, 0, 0x00, 0x00, 0x01, 0x00]);
        let packet = init_command_request(&GUID, "");
        assert_eq!(packet.len(), 30);
        assert!(decode_name(&[0x41, 0x00]).is_err());
        assert_eq!(decode_name(&utf16z("PhotoCull")).unwrap(), "PhotoCull");
    }
}
