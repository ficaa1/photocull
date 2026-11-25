//! USB cameras through ImageCaptureCore on macOS; a stub that reports the platform elsewhere.

use super::protocol::transport::{
    DataPhase, Operation, PtpTransport, Reply, TransportError, TransportEvent,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IccDevice {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub usb_vendor_id: u32,
    #[serde(default)]
    pub usb_product_id: u32,
    #[serde(default, deserialize_with = "flag")]
    pub can_send_ptp: bool,
    #[serde(default, deserialize_with = "flag")]
    pub active: bool,
}

/// Foundation boxes a BOOL as a number on some architectures; both spellings are flags.
fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Flag {
        Bool(bool),
        Number(f64),
    }
    Ok(match Flag::deserialize(d)? {
        Flag::Bool(b) => b,
        Flag::Number(n) => n != 0.0,
    })
}

pub const SONY_USB_VENDOR: u32 = 0x054C;

/// Camera events from native callbacks. Property-dirty notifications are coalesced; removal is
/// always queued so the worker wakes even under event pressure.
#[derive(Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct EventQueue {
    events: Mutex<VecDeque<TransportEvent>>,
    ready: Condvar,
    topology: AtomicU64,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_QUEUED_EVENTS: usize = 256;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl EventQueue {
    pub fn push(&self, event: TransportEvent) {
        let mut q = self.events.lock().unwrap();
        if let TransportEvent::Ptp {
            code: 0xC203 | 0x4006,
            generation,
            ..
        } = &event
        {
            let duplicate = q.iter().any(|e| {
                matches!(e, TransportEvent::Ptp { code: 0xC203 | 0x4006, generation: g, .. } if g == generation)
            });
            if duplicate {
                return;
            }
        }
        if q.len() >= MAX_QUEUED_EVENTS && matches!(event, TransportEvent::Ptp { .. }) {
            return;
        }
        q.push_back(event);
        self.ready.notify_all();
    }

    pub fn pop(&self) -> Option<TransportEvent> {
        self.events.lock().unwrap().pop_front()
    }

    pub fn wait(&self, until: Instant) -> Option<TransportEvent> {
        let mut q = self.events.lock().unwrap();
        loop {
            if let Some(e) = q.pop_front() {
                return Some(e);
            }
            let now = Instant::now();
            if now >= until {
                return None;
            }
            q = self.ready.wait_timeout(q, until - now).unwrap().0;
        }
    }

    pub fn topology_changed(&self) {
        self.topology.fetch_add(1, Ordering::SeqCst);
        self.ready.notify_all();
    }

    /// Increases whenever devices are added or removed.
    pub fn topology(&self) -> u64 {
        self.topology.load(Ordering::SeqCst)
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// A command the camera completed with data after its caller had timed out. For GetObject the
/// camera has already handed the photo over and may hold no other copy.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct LateObject {
    pub generation: u64,
    pub opcode: u16,
    pub param1: u32,
    pub payload: Orphan,
}

static LATE: Mutex<Vec<LateObject>> = Mutex::new(Vec::new());

/// Late payloads in arrival order; each is handed out once.
pub fn take_late_objects() -> Vec<LateObject> {
    std::mem::take(&mut *LATE.lock().unwrap())
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use crate::tether::protocol::ptp;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::{Arc, OnceLock};

    #[repr(C)]
    pub struct IccError {
        pub code: i64,
        pub domain: [c_char; 128],
        pub message: [c_char; 512],
    }

    impl IccError {
        fn new() -> Self {
            IccError {
                code: 0,
                domain: [0; 128],
                message: [0; 512],
            }
        }
        fn text(buf: &[c_char]) -> String {
            // SAFETY: the bridge always NUL-terminates within the buffer (strlcpy).
            unsafe { CStr::from_ptr(buf.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        }
    }

    type Callback = extern "C" fn(*mut c_void, u64, u32, *const u8, usize);
    type LateCallback = extern "C" fn(*mut c_void, u64, u16, u32, *mut c_void, *const u8, usize);

    extern "C" {
        fn photocull_icc_start(callback: Callback, late: LateCallback, context: *mut c_void)
            -> i32;
        fn photocull_icc_list_devices(out: *mut *mut u8, out_len: *mut usize) -> i32;
        fn photocull_icc_open_session(
            device_id: *const c_char,
            generation: u64,
            timeout: f64,
            error: *mut IccError,
        ) -> i32;
        #[allow(clippy::too_many_arguments)]
        fn photocull_icc_send_ptp(
            generation: u64,
            command: *const u8,
            command_len: usize,
            out_data: *const u8,
            out_len: usize,
            timeout: f64,
            payload_handle: *mut *mut c_void,
            payload: *mut *const u8,
            payload_len: *mut usize,
            response: *mut u8,
            response_cap: usize,
            response_len: *mut usize,
            error: *mut IccError,
        ) -> i32;
        fn photocull_icc_release_data(handle: *mut c_void);
        fn photocull_icc_close_session(generation: u64, timeout: f64, error: *mut IccError) -> i32;
        fn photocull_icc_stop();
        fn photocull_icc_pump(seconds: f64);
        fn photocull_icc_free_bytes(bytes: *mut u8, length: usize);
    }

    const EVENT_PTP: u32 = 0;
    const EVENT_REMOVED: u32 = 1;
    const EVENT_SESSION_CLOSED: u32 = 2;
    const EVENT_DEVICES: u32 = 3;

    static QUEUE: OnceLock<Arc<EventQueue>> = OnceLock::new();

    pub fn queue() -> Arc<EventQueue> {
        QUEUE.get_or_init(Default::default).clone()
    }

    extern "C" fn on_event(
        _context: *mut c_void,
        generation: u64,
        kind: u32,
        data: *const u8,
        length: usize,
    ) {
        let queue = queue();
        match kind {
            EVENT_PTP => {
                if data.is_null() || length == 0 {
                    return;
                }
                // SAFETY: the bridge passes a buffer valid for `length` bytes during this call.
                let bytes = unsafe { std::slice::from_raw_parts(data, length) };
                if let Ok(event) = ptp::parse_event(bytes) {
                    queue.push(TransportEvent::Ptp {
                        generation,
                        code: event.code,
                        params: event.params,
                    });
                }
            }
            EVENT_REMOVED => {
                queue.push(TransportEvent::Removed { generation });
                queue.topology_changed();
            }
            EVENT_SESSION_CLOSED => queue.push(TransportEvent::SessionLost { generation }),
            EVENT_DEVICES => queue.topology_changed(),
            _ => {}
        }
    }

    /// Takes ownership of the retained NSData the bridge passes for a late completion.
    extern "C" fn on_late_object(
        _context: *mut c_void,
        generation: u64,
        opcode: u16,
        param1: u32,
        handle: *mut c_void,
        bytes: *const u8,
        length: usize,
    ) {
        if handle.is_null() {
            return;
        }
        let payload = Orphan(Payload {
            handle,
            bytes,
            len: length,
        });
        if !ptp::holds_captured_photo(opcode, &[param1], ptp::resp::OK) {
            return;
        }
        LATE.lock().unwrap().push(LateObject {
            generation,
            opcode,
            param1,
            payload,
        });
    }

    fn status_error(status: i32, error: &IccError) -> TransportError {
        match status {
            1 => TransportError::Removed,
            2 => TransportError::InUse,
            3 => TransportError::Permission,
            4 => TransportError::TimedOut,
            5 => TransportError::Removed,
            6 => TransportError::native(
                "The camera does not accept PTP commands. Set USB Connection to PC Remote.",
            ),
            8 => TransportError::native("Camera discovery has not started."),
            9 => TransportError::native("Camera commands cannot run on the main thread."),
            _ => {
                let domain = IccError::text(&error.domain);
                let message = IccError::text(&error.message);
                let lower = message.to_lowercase();
                if lower.contains("not authorized") || lower.contains("denied") {
                    TransportError::Permission
                } else if lower.contains("in use") || lower.contains("busy") {
                    TransportError::InUse
                } else {
                    TransportError::Native {
                        domain,
                        code: error.code,
                        message,
                    }
                }
            }
        }
    }

    fn seconds_until(deadline: Instant) -> f64 {
        deadline
            .saturating_duration_since(Instant::now())
            .as_secs_f64()
            .max(0.05)
    }

    pub fn start() -> Result<(), TransportError> {
        let _ = queue();
        // SAFETY: both callbacks are plain functions with the expected ABI and need no context.
        let status = unsafe { photocull_icc_start(on_event, on_late_object, std::ptr::null_mut()) };
        if status == 0 {
            Ok(())
        } else {
            Err(status_error(status, &IccError::new()))
        }
    }

    pub fn stop() {
        // SAFETY: no arguments; the bridge tolerates repeated calls.
        unsafe { photocull_icc_stop() }
    }

    pub fn pump(seconds: f64) {
        // SAFETY: only runs the run loop when called on the main thread.
        unsafe { photocull_icc_pump(seconds) }
    }

    pub fn devices() -> Result<Vec<IccDevice>, TransportError> {
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut len = 0usize;
        // SAFETY: out-pointers are valid; ownership of the buffer is returned to us.
        let status = unsafe { photocull_icc_list_devices(&mut ptr, &mut len) };
        if status != 0 {
            return Err(status_error(status, &IccError::new()));
        }
        // SAFETY: the bridge allocated `len` bytes at `ptr`.
        let json = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        // SAFETY: frees the buffer allocated by the bridge exactly once.
        unsafe { photocull_icc_free_bytes(ptr, len) };
        serde_json::from_slice(&json)
            .map_err(|e| TransportError::Framing(format!("device list: {e}")))
    }

    /// Owns one retained NSData until dropped.
    struct Payload {
        handle: *mut c_void,
        bytes: *const u8,
        len: usize,
    }

    impl Payload {
        fn as_slice(&self) -> &[u8] {
            if self.bytes.is_null() || self.len == 0 {
                &[]
            } else {
                // SAFETY: the retained NSData keeps `bytes` valid for `len` bytes until drop.
                unsafe { std::slice::from_raw_parts(self.bytes, self.len) }
            }
        }
    }

    impl Drop for Payload {
        fn drop(&mut self) {
            // SAFETY: releases the reference retained by the bridge exactly once.
            unsafe { photocull_icc_release_data(self.handle) }
        }
    }

    // SAFETY: the handle is an immutable NSData, which may be read and released on any thread.
    unsafe impl Send for Payload {}

    /// A complete object the camera delivered but the sink could not store.
    pub struct Orphan(Payload);

    impl Orphan {
        pub fn bytes(&self) -> &[u8] {
            self.0.as_slice()
        }
    }

    pub struct IccTransport {
        device_id: CString,
        generation: u64,
        queue: Arc<EventQueue>,
        orphan: Option<Orphan>,
    }

    impl IccTransport {
        pub fn new(device_id: &str) -> Result<Self, TransportError> {
            Ok(IccTransport {
                device_id: CString::new(device_id)
                    .map_err(|_| TransportError::native("Invalid camera identifier."))?,
                generation: 0,
                queue: queue(),
                orphan: None,
            })
        }

        /// The payload of the last object whose sink failed, kept so the photo is not lost.
        pub fn take_orphan(&mut self) -> Option<Orphan> {
            self.orphan.take()
        }
    }

    impl PtpTransport for IccTransport {
        fn open(&mut self, deadline: Instant) -> Result<(), TransportError> {
            self.generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
            let mut error = IccError::new();
            // SAFETY: the identifier is NUL-terminated and `error` is writable.
            let status = unsafe {
                photocull_icc_open_session(
                    self.device_id.as_ptr(),
                    self.generation,
                    seconds_until(deadline),
                    &mut error,
                )
            };
            if status == 0 {
                Ok(())
            } else {
                Err(status_error(status, &error))
            }
        }

        fn transact(
            &mut self,
            request: Operation<'_>,
            phase: DataPhase<'_>,
            deadline: Instant,
        ) -> Result<Reply, TransportError> {
            let command = ptp::build_command(request.opcode, 0, request.params)
                .map_err(|e| TransportError::Framing(e.to_string()))?;
            let (out_ptr, out_len) = match &phase {
                DataPhase::Out(bytes) => (bytes.as_ptr(), bytes.len()),
                _ => (std::ptr::null(), 0),
            };
            let mut handle: *mut c_void = std::ptr::null_mut();
            let mut bytes: *const u8 = std::ptr::null();
            let mut len = 0usize;
            let mut response = [0u8; 64];
            let mut response_len = 0usize;
            let mut error = IccError::new();
            // SAFETY: all buffers are valid for the stated lengths; ownership of the payload
            // handle is transferred to `Payload` below.
            let status = unsafe {
                photocull_icc_send_ptp(
                    self.generation,
                    command.as_ptr(),
                    command.len(),
                    out_ptr,
                    out_len,
                    seconds_until(deadline),
                    &mut handle,
                    &mut bytes,
                    &mut len,
                    response.as_mut_ptr(),
                    response.len(),
                    &mut response_len,
                    &mut error,
                )
            };
            let payload = (!handle.is_null()).then_some(Payload { handle, bytes, len });
            if status != 0 {
                return Err(status_error(status, &error));
            }
            if response_len == 0 || response_len > response.len() {
                return Err(TransportError::Framing(format!(
                    "response container of {response_len} bytes"
                )));
            }
            let parsed = ptp::parse_response(&response[..response_len])
                .map_err(|e| TransportError::Framing(e.to_string()))?;
            let mut bytes_in = 0u64;
            // The camera has already handed a captured photo over and may not resend it.
            let keep = ptp::holds_captured_photo(request.opcode, request.params, parsed.code);
            if let (DataPhase::In { sink, limit }, Some(payload)) = (phase, payload) {
                let data = payload.as_slice();
                if data.len() as u64 > limit {
                    self.orphan = keep.then_some(Orphan(payload));
                    return Err(TransportError::Limit);
                }
                if let Some(e) = data
                    .chunks(1 << 20)
                    .find_map(|chunk| sink.write_all(chunk).err())
                {
                    self.orphan = keep.then_some(Orphan(payload));
                    return Err(TransportError::Sink(e));
                }
                bytes_in = data.len() as u64;
            }
            Ok(Reply {
                code: parsed.code,
                params: parsed.params,
                bytes_in,
            })
        }

        fn close(&mut self, deadline: Instant) -> Result<(), TransportError> {
            let mut error = IccError::new();
            // SAFETY: `error` is writable; the generation retires this attachment.
            let status = unsafe {
                photocull_icc_close_session(self.generation, seconds_until(deadline), &mut error)
            };
            if status == 0 {
                Ok(())
            } else {
                Err(status_error(status, &error))
            }
        }

        fn poll_event(&mut self) -> Option<TransportEvent> {
            self.queue.pop()
        }

        fn generation(&self) -> u64 {
            self.generation
        }

        fn wait_event(&mut self, until: Instant) -> Option<TransportEvent> {
            self.queue.wait(until)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::*;
    use std::sync::{Arc, OnceLock};

    pub const UNAVAILABLE: &str = "ImageCaptureCore USB tethering runs on macOS";

    static QUEUE: OnceLock<Arc<EventQueue>> = OnceLock::new();

    pub fn queue() -> Arc<EventQueue> {
        QUEUE.get_or_init(Default::default).clone()
    }

    pub fn start() -> Result<(), TransportError> {
        Err(TransportError::native(UNAVAILABLE))
    }

    pub fn stop() {}

    pub fn pump(_seconds: f64) {}

    pub fn devices() -> Result<Vec<IccDevice>, TransportError> {
        Err(TransportError::native(UNAVAILABLE))
    }

    pub struct IccTransport;

    pub struct Orphan(Vec<u8>);

    impl Orphan {
        pub fn bytes(&self) -> &[u8] {
            &self.0
        }
    }

    impl IccTransport {
        pub fn new(_device_id: &str) -> Result<Self, TransportError> {
            Err(TransportError::native(UNAVAILABLE))
        }

        pub fn take_orphan(&mut self) -> Option<Orphan> {
            None
        }
    }

    impl PtpTransport for IccTransport {
        fn open(&mut self, _deadline: Instant) -> Result<(), TransportError> {
            Err(TransportError::native(UNAVAILABLE))
        }
        fn transact(
            &mut self,
            _request: Operation<'_>,
            _phase: DataPhase<'_>,
            _deadline: Instant,
        ) -> Result<Reply, TransportError> {
            Err(TransportError::native(UNAVAILABLE))
        }
        fn close(&mut self, _deadline: Instant) -> Result<(), TransportError> {
            Ok(())
        }
        fn poll_event(&mut self) -> Option<TransportEvent> {
            None
        }
    }
}

pub use native::{devices, pump, queue, start, stop, IccTransport, Orphan};

const STOPPED: u8 = 0;
const STARTING: u8 = 1;
const STARTED: u8 = 2;
const STOPPING: u8 = 3;

/// Start/stop bookkeeping that never holds a lock across native calls: those block on the main
/// queue, and the main thread may itself be waiting to ask for devices.
#[derive(Default)]
struct Lifecycle(AtomicU8);

impl Lifecycle {
    fn ensure(
        &self,
        start: impl Fn() -> Result<(), TransportError>,
        stop: impl Fn(),
    ) -> Result<(), TransportError> {
        match self
            .0
            .compare_exchange(STOPPED, STARTING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => {}
            Err(STARTED) => return Ok(()),
            // Native start is idempotent, so a concurrent caller simply starts too.
            Err(STARTING) => return start(),
            Err(_) => return Err(TransportError::native("Camera discovery is stopping.")),
        }
        if let Err(e) = start() {
            let _ = self
                .0
                .compare_exchange(STARTING, STOPPED, Ordering::SeqCst, Ordering::SeqCst);
            return Err(e);
        }
        if self
            .0
            .compare_exchange(STARTING, STARTED, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // Stopped while starting: leave the native side stopped too.
            stop();
            return Err(TransportError::native("Camera discovery was stopped."));
        }
        Ok(())
    }

    fn stop(&self, stop: impl Fn()) {
        let previous = self.0.swap(STOPPING, Ordering::SeqCst);
        if previous == STARTED || previous == STARTING {
            stop();
        }
        self.0.store(STOPPED, Ordering::SeqCst);
    }
}

/// Shared discovery for the manager: starts the browser once and lists cameras.
#[derive(Default)]
pub struct IccBrowser {
    lifecycle: Lifecycle,
}

impl IccBrowser {
    pub fn ensure_started(&self) -> Result<(), TransportError> {
        self.lifecycle.ensure(start, stop)
    }

    pub fn devices(&self) -> Result<Vec<IccDevice>, TransportError> {
        self.ensure_started()?;
        devices()
    }

    pub fn topology(&self) -> u64 {
        queue().topology()
    }

    pub fn stop(&self) {
        self.lifecycle.stop(stop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn device_flags_accept_booleans_and_boxed_numbers() {
        let list: Vec<IccDevice> = serde_json::from_str(
            r#"[{"id":"a","name":"ILCE-7M3","usbVendorId":1356,"canSendPtp":1,"active":0},
                {"id":"b","name":"ILCE-7CM2","canSendPtp":true,"active":true,"sessionOpen":1},
                {"id":"c","name":"Card"}]"#,
        )
        .unwrap();
        let flags: Vec<_> = list.iter().map(|d| (d.can_send_ptp, d.active)).collect();
        assert_eq!(flags, [(true, false), (true, true), (false, false)]);
    }

    #[test]
    fn discovery_start_holds_no_lock_across_native_calls() {
        let life = Arc::new(Lifecycle::default());
        let starts = Arc::new(AtomicUsize::new(0));
        // A native start that re-enters, as the main thread does when it asks for devices while
        // another thread waits on the main queue.
        let inner = life.clone();
        let counted = starts.clone();
        life.ensure(
            move || {
                counted.fetch_add(1, Ordering::SeqCst);
                inner.ensure(|| Ok(()), || {})
            },
            || {},
        )
        .unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        life.ensure(|| panic!("already started"), || {}).unwrap();

        let stops = AtomicUsize::new(0);
        life.stop(|| {
            stops.fetch_add(1, Ordering::SeqCst);
        });
        life.stop(|| panic!("already stopped"));
        assert_eq!(stops.load(Ordering::SeqCst), 1);

        // A failed start can be retried; a stop that lands mid-start wins.
        assert!(life
            .ensure(|| Err(TransportError::native("no")), || {})
            .is_err());
        let stopped = AtomicUsize::new(0);
        let racing = life.clone();
        assert!(life
            .ensure(
                move || {
                    racing.stop(|| {});
                    Ok(())
                },
                || {
                    stopped.fetch_add(1, Ordering::SeqCst);
                }
            )
            .is_err());
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        life.ensure(|| Ok(()), || {}).unwrap();
    }
}
