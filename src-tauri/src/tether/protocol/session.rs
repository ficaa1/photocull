//! The Sony remote session: handshake, descriptors, writes, shutter, queue drain and Live View.

use super::codec::{
    self, control, dtype, prop, DevicePropDesc, ExtDeviceInfo, FocusIndication, Form, Grammar, Iso,
    LiveLayout, PropValue, QueueSignal, Shutter, WriteRoute,
};
use super::ptp::{self, handle, op, resp, DeviceInfo, FileKind, ObjectInfo, ProtocolError};
use super::transport::{DataPhase, Operation, PtpTransport, Reply, TransportError, TransportEvent};
use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraProfile {
    Alpha7III,
    Alpha7CII,
    GenericSony,
}

impl CameraProfile {
    pub fn from_model(model: &str) -> Self {
        match model.trim() {
            "ILCE-7M3" => CameraProfile::Alpha7III,
            "ILCE-7CM2" => CameraProfile::Alpha7CII,
            _ => CameraProfile::GenericSony,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            CameraProfile::Alpha7III => "α7 III",
            CameraProfile::Alpha7CII => "α7C II",
            CameraProfile::GenericSony => "Sony camera",
        }
    }

    /// `(offered SDI version, request extended codes)` in trial order.
    fn negotiation(self) -> &'static [(u16, bool)] {
        match self {
            CameraProfile::Alpha7III => &[(codec::SDI_200, false)],
            CameraProfile::Alpha7CII => &[(codec::SDI_300, true), (codec::SDI_200, false)],
            CameraProfile::GenericSony => &[(codec::SDI_300, false)],
        }
    }

    /// The enumeration grammar qualified for this body and negotiated version.
    fn grammar(self, version: u16) -> Option<Grammar> {
        match (self, version) {
            (CameraProfile::Alpha7III, codec::SDI_200) => Some(Grammar::SingleList),
            (_, v) if v >= codec::SDI_300 => Some(Grammar::TwoList),
            _ => None,
        }
    }

    /// The α7C II uses the current Sony menu names.
    pub fn current_menu(self) -> bool {
        self != CameraProfile::Alpha7III
    }
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Budget for each transport open, including reopened negotiation trials. A first Wi-Fi
    /// pairing waits for approval on the camera body.
    pub open_timeout: Duration,
    pub command_timeout: Duration,
    pub transfer_timeout: Duration,
    pub busy_deadline: Duration,
    pub negotiate_retries: u32,
    pub negotiate_delay: Duration,
    pub af_budget: Duration,
    pub af_poll: Duration,
    pub press_hold: Duration,
    pub max_object_bytes: u64,
    pub max_live_bytes: u64,
    pub stall_after: Duration,
}

impl Default for SessionConfig {
    fn default() -> Self {
        SessionConfig {
            open_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(10),
            transfer_timeout: Duration::from_secs(120),
            busy_deadline: Duration::from_secs(3),
            negotiate_retries: 20,
            negotiate_delay: Duration::from_millis(50),
            af_budget: Duration::from_secs(1),
            af_poll: Duration::from_millis(50),
            press_hold: Duration::from_millis(100),
            max_object_bytes: 512 << 20,
            max_live_bytes: (8 << 20) + (64 << 10),
            stall_after: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
pub enum SessionError {
    Transport(TransportError),
    Response { opcode: u16, code: u16 },
    Protocol(ProtocolError),
    NotSonyRemote(String),
    Negotiation(String),
    Removed { shutter_uncertain: bool },
    SessionLost,
    StaleRevision { current: u64 },
    Locked(String),
    Unsupported(String),
    InvalidValue(String),
    NotApplied(String),
    Cancelled,
    QueueFault(String),
    Incomplete { expected: u64, received: u64 },
    LiveViewUnavailable(String),
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionError::Transport(e) => write!(f, "{e}"),
            SessionError::Response { opcode, code } => write!(
                f,
                "the camera answered {} ({code:04X}) to {opcode:04X}",
                resp::name(*code)
            ),
            SessionError::Protocol(e) => write!(f, "{e}"),
            SessionError::NotSonyRemote(model) => write!(
                f,
                "{model} is not in PC Remote mode. Set USB Connection to PC Remote and reconnect."
            ),
            SessionError::Negotiation(m) => write!(f, "Sony remote negotiation failed: {m}"),
            SessionError::Removed { shutter_uncertain } => {
                if *shutter_uncertain {
                    write!(f, "the camera was disconnected during a shutter press; whether it fired is unknown")
                } else {
                    write!(f, "the camera was disconnected")
                }
            }
            SessionError::SessionLost => write!(f, "the camera session ended"),
            SessionError::StaleRevision { .. } => write!(f, "the setting changed on the camera"),
            SessionError::Locked(m)
            | SessionError::Unsupported(m)
            | SessionError::InvalidValue(m)
            | SessionError::NotApplied(m)
            | SessionError::QueueFault(m)
            | SessionError::LiveViewUnavailable(m) => write!(f, "{m}"),
            SessionError::Cancelled => write!(f, "cancelled"),
            SessionError::Incomplete { expected, received } => {
                write!(f, "the camera sent {received} of {expected} bytes")
            }
        }
    }
}

impl From<TransportError> for SessionError {
    fn from(e: TransportError) -> Self {
        match e {
            TransportError::Removed => SessionError::Removed {
                shutter_uncertain: false,
            },
            e => SessionError::Transport(e),
        }
    }
}

impl From<ProtocolError> for SessionError {
    fn from(e: ProtocolError) -> Self {
        SessionError::Protocol(e)
    }
}

pub type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Closed,
    Ready,
    Removed,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    ObjectAdded,
    PropertiesDirty,
    Removed,
    SessionLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureOutcome {
    Released,
    FocusNotAcquired,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureOptions {
    pub wait_for_focus: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainedObject {
    pub info: ObjectInfo,
    pub kind: FileKind,
    pub bytes: u64,
}

#[derive(Debug)]
pub enum DrainStep<W> {
    Empty,
    Pending,
    Stalled,
    Object(DrainedObject, W),
    /// The camera sent a different size than it declared. The sink holds every byte it did send.
    Short {
        object: DrainedObject,
        sink: W,
        expected: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveImage {
    pub jpeg: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RangeSpec {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub unit: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyKind {
    Enum,
    Range,
    Boolean,
    Reading,
}

impl PropertyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PropertyKind::Enum => "enum",
            PropertyKind::Range => "range",
            PropertyKind::Boolean => "boolean",
            PropertyKind::Reading => "reading",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    ReadWrite,
    ReadOnly,
    Unsupported,
    Busy,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::ReadWrite => "rw",
            Access::ReadOnly => "ro",
            Access::Unsupported => "unsupported",
            Access::Busy => "busy",
        }
    }
}

/// A normalized panel property.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraProperty {
    pub key: &'static str,
    pub label: &'static str,
    pub code: u16,
    pub kind: PropertyKind,
    pub value: Option<String>,
    pub display: String,
    pub access: Access,
    pub choices: Vec<Choice>,
    pub range: Option<RangeSpec>,
    pub reason: Option<String>,
    pub prop_rev: u64,
    /// Writes move by camera detents (`inc`/`dec`, a signed step, or a choice reached step by
    /// step).
    pub relative: bool,
    /// The current value as a number, for ranges.
    pub number: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionCap {
    pub key: &'static str,
    pub available: bool,
    pub reason: Option<String>,
}

/// Exposure values for capture naming, normalized independently of labels.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExposureSnapshot {
    /// Numeric ISO; `None` while Auto ISO hides the metered value.
    pub iso: Option<u32>,
    /// Exposure time as `n/d` seconds.
    pub shutter: Option<String>,
    pub aperture: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRole {
    Raw,
    Jpeg,
}

impl HostRole {
    pub fn as_str(self) -> &'static str {
        match self {
            HostRole::Raw => "raw",
            HostRole::Jpeg => "jpeg",
        }
    }
}

const PANEL: [(&str, &str, u16); 26] = [
    ("program", "Mode", prop::EXPOSURE_PROGRAM),
    ("shutter", "Shutter", prop::SHUTTER_SPEED),
    ("aperture", "Aperture", prop::F_NUMBER),
    ("iso", "ISO", prop::ISO),
    ("evComp", "Exposure comp.", prop::EXPOSURE_BIAS),
    ("flashMode", "Flash mode", prop::FLASH_MODE),
    ("flashComp", "Flash comp.", prop::FLASH_COMPENSATION),
    ("felState", "Flash lock", prop::FEL_STATE),
    ("wbMode", "White balance", prop::WHITE_BALANCE),
    ("kelvin", "Color temperature", prop::COLOR_TEMPERATURE),
    ("wbGreenMagenta", "WB G–M", prop::WB_GREEN_MAGENTA),
    ("wbAmberBlue", "WB A–B", prop::WB_AMBER_BLUE),
    ("drive", "Drive", prop::DRIVE_MODE),
    ("focusMode", "Focus mode", prop::FOCUS_MODE),
    ("focusArea", "Focus area", prop::FOCUS_AREA),
    ("metering", "Metering", prop::METERING),
    ("quality", "Quality", prop::COMPRESSION),
    ("jpegQuality", "JPEG quality", prop::JPEG_QUALITY),
    ("rawCompression", "RAW file type", prop::RAW_FILE_TYPE),
    ("hostFileTypes", "PC save image", prop::PC_SAVE_FORMAT),
    ("hostImageSize", "PC save size", prop::PC_SAVE_SIZE),
    (
        "saveDestination",
        "Save destination",
        prop::SAVE_DESTINATION,
    ),
    ("aspect", "Aspect ratio", prop::ASPECT_RATIO),
    ("battery", "Battery", prop::BATTERY_REMAINING),
    ("focusIndication", "Focus", prop::FOCUS_INDICATION),
    ("focalPosition", "Focus position", prop::FOCAL_POSITION),
];

/// Panel key for a property code, with `quality` covering both the legacy and v3 file format.
pub fn code_for_key(key: &str, has_legacy_compression: bool) -> Option<u16> {
    if key == "quality" && !has_legacy_compression {
        return Some(prop::FILE_FORMAT);
    }
    PANEL.iter().find(|(k, _, _)| *k == key).map(|(_, _, c)| *c)
}

/// Captures the first bytes written for type detection.
struct HeadTee<'a, W: Write> {
    inner: &'a mut W,
    head: Vec<u8>,
}

impl<W: Write> Write for HeadTee<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        let room = 16usize.saturating_sub(self.head.len());
        self.head.extend_from_slice(&buf[..n.min(room)]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub struct SonySession<T: PtpTransport> {
    transport: T,
    config: SessionConfig,
    state: ConnectionState,
    profile: CameraProfile,
    device: Option<DeviceInfo>,
    ext: Option<ExtDeviceInfo>,
    version: u16,
    extended: bool,
    props: BTreeMap<u16, DevicePropDesc>,
    revs: BTreeMap<u16, u64>,
    prop_rev: u64,
    grammar: Option<Grammar>,
    ambiguous: bool,
    rejected_snapshot: Option<Vec<u8>>,
    held: Vec<u16>,
    /// S2 down may have reached the body during the current capture.
    s2_dispatched: bool,
    half_press: Option<String>,
    object_added: bool,
    props_dirty: bool,
    bare_msb_since: Option<Instant>,
    invalid_streak: u32,
    live: bool,
    live_info: bool,
    notch_up_increases: BTreeMap<u16, bool>,
}

/// Most detents one relative write may move.
pub const MAX_NOTCH_STEPS: i32 = 16;

/// `inc`/`dec` or an explicitly signed step such as `+2`; unsigned digits are choice IDs.
fn notch_steps(value_id: &str) -> Option<i32> {
    let steps = match value_id.trim() {
        "inc" => 1,
        "dec" => -1,
        v if v.starts_with(['+', '-']) => v.parse::<i32>().ok()?,
        _ => return None,
    };
    (steps != 0 && steps.unsigned_abs() <= MAX_NOTCH_STEPS as u32).then_some(steps)
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((50u64 << attempt.min(3)).min(500))
}

impl<T: PtpTransport> SonySession<T> {
    pub fn new(transport: T, config: SessionConfig) -> Self {
        SonySession {
            transport,
            config,
            state: ConnectionState::Closed,
            profile: CameraProfile::GenericSony,
            device: None,
            ext: None,
            version: 0,
            extended: false,
            props: BTreeMap::new(),
            revs: BTreeMap::new(),
            prop_rev: 0,
            grammar: None,
            ambiguous: false,
            rejected_snapshot: None,
            held: Vec::new(),
            s2_dispatched: false,
            half_press: None,
            object_added: false,
            props_dirty: false,
            bare_msb_since: None,
            invalid_streak: 0,
            live: false,
            live_info: false,
            notch_up_increases: BTreeMap::new(),
        }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }
    pub fn into_transport(self) -> T {
        self.transport
    }
    pub fn state(&self) -> ConnectionState {
        self.state
    }
    pub fn profile(&self) -> CameraProfile {
        self.profile
    }
    pub fn device(&self) -> Option<&DeviceInfo> {
        self.device.as_ref()
    }
    pub fn ext_info(&self) -> Option<&ExtDeviceInfo> {
        self.ext.as_ref()
    }
    pub fn sdi_version(&self) -> u16 {
        self.version
    }
    pub fn extended_codes(&self) -> bool {
        self.extended
    }
    pub fn grammar(&self) -> Option<Grammar> {
        self.grammar
    }
    pub fn is_ambiguous(&self) -> bool {
        self.ambiguous
    }
    pub fn rejected_snapshot(&self) -> Option<&[u8]> {
        self.rejected_snapshot.as_deref()
    }
    pub fn prop_rev(&self) -> u64 {
        self.prop_rev
    }
    pub fn rev_of(&self, code: u16) -> u64 {
        self.revs.get(&code).copied().unwrap_or(0)
    }
    pub fn property(&self, code: u16) -> Option<&DevicePropDesc> {
        self.props.get(&code)
    }
    pub fn descriptors(&self) -> impl Iterator<Item = &DevicePropDesc> {
        self.props.values()
    }
    pub fn held_controls(&self) -> &[u16] {
        &self.held
    }
    pub fn half_press_hold(&self) -> Option<&str> {
        self.half_press.as_deref()
    }
    pub fn is_live(&self) -> bool {
        self.live
    }
    pub fn object_announced(&self) -> bool {
        self.object_added
    }
    pub fn properties_dirty(&self) -> bool {
        self.props_dirty
    }

    fn value(&self, code: u16) -> Option<u64> {
        self.props.get(&code).and_then(|d| d.current_bits())
    }

    fn deadline(&self, d: Duration) -> Instant {
        self.transport.now() + d
    }

    fn has_control(&self, code: u16) -> bool {
        self.ext.as_ref().is_some_and(|e| e.has_control(code)) || self.props.contains_key(&code)
    }

    fn require_ready(&self) -> Result<()> {
        match self.state {
            ConnectionState::Ready => Ok(()),
            ConnectionState::Removed => Err(SessionError::Removed {
                shutter_uncertain: false,
            }),
            ConnectionState::Lost => Err(SessionError::SessionLost),
            ConnectionState::Closed => Err(SessionError::SessionLost),
        }
    }

    fn raw(
        &mut self,
        opcode: u16,
        params: &[u32],
        phase: DataPhase<'_>,
        timeout: Duration,
    ) -> Result<Reply> {
        if self.state == ConnectionState::Removed {
            return Err(SessionError::Removed {
                shutter_uncertain: false,
            });
        }
        let deadline = self.deadline(timeout);
        match self
            .transport
            .transact(Operation { opcode, params }, phase, deadline)
        {
            Ok(reply) => {
                if reply.code == resp::SESSION_NOT_OPEN {
                    self.state = ConnectionState::Lost;
                    return Err(SessionError::SessionLost);
                }
                Ok(reply)
            }
            Err(TransportError::Removed) => {
                self.mark_removed();
                Err(SessionError::Removed {
                    shutter_uncertain: false,
                })
            }
            Err(e) => Err(SessionError::Transport(e)),
        }
    }

    fn mark_removed(&mut self) {
        self.state = ConnectionState::Removed;
        self.held.clear();
        self.half_press = None;
        self.live = false;
    }

    fn ok(opcode: u16, reply: Reply) -> Result<Reply> {
        if reply.code == resp::OK {
            Ok(reply)
        } else {
            Err(SessionError::Response {
                opcode,
                code: reply.code,
            })
        }
    }

    /// A read-only data-in operation, backing off on DeviceBusy until the busy deadline.
    fn read_in(&mut self, opcode: u16, params: &[u32]) -> Result<Vec<u8>> {
        let until = self.deadline(self.config.busy_deadline);
        let mut attempt = 0;
        loop {
            let mut data = Vec::new();
            let limit = self.config.max_object_bytes;
            let reply = self.raw(
                opcode,
                params,
                DataPhase::In {
                    sink: &mut data,
                    limit,
                },
                self.config.command_timeout,
            )?;
            if reply.code == resp::DEVICE_BUSY && self.transport.now() < until {
                self.transport.sleep(backoff(attempt));
                attempt += 1;
                continue;
            }
            Self::ok(opcode, reply)?;
            return Ok(data);
        }
    }

    fn write_out(&mut self, opcode: u16, params: &[u32], data: &[u8]) -> Result<()> {
        let reply = self.raw(
            opcode,
            params,
            DataPhase::Out(data),
            self.config.command_timeout,
        )?;
        Self::ok(opcode, reply).map(|_| ())
    }

    /// Opens the session, verifies PC Remote, negotiates SDIO and reads the first snapshot.
    pub fn connect(&mut self) -> Result<()> {
        let deadline = self.deadline(self.config.open_timeout);
        self.transport.open(deadline)?;
        self.state = ConnectionState::Closed;
        let info = DeviceInfo::parse(&self.read_in(op::GET_DEVICE_INFO, &[])?)?;
        if !info.is_sony_remote() {
            return Err(SessionError::NotSonyRemote(info.model));
        }
        self.profile = CameraProfile::from_model(&info.model);
        self.device = Some(info);
        let trials = self.profile.negotiation();
        let mut last = None;
        for (i, (version, extended)) in trials.iter().enumerate() {
            if i > 0 {
                let deadline = self.deadline(self.config.command_timeout);
                let _ = self.transport.close(deadline);
                let deadline = self.deadline(self.config.open_timeout);
                self.transport.open(deadline)?;
            }
            match self.handshake(*version, *extended) {
                Ok(()) => {
                    last = None;
                    break;
                }
                Err(e @ SessionError::Removed { .. }) => return Err(e),
                Err(e) => last = Some(e),
            }
        }
        if let Some(e) = last {
            return Err(e);
        }
        self.state = ConnectionState::Ready;
        self.held.clear();
        self.half_press = None;
        self.object_added = false;
        self.invalid_streak = 0;
        self.bare_msb_since = None;
        self.live = false;
        self.live_info = false;
        self.refresh_properties()?;
        Ok(())
    }

    /// One SDIO_Connect phase; Sony defines its dataset as a single u64.
    fn sdio_connect(&mut self, phase: u32) -> Result<()> {
        let data = self.read_in(op::SDIO_CONNECT, &[phase, 0, 0])?;
        if data.len() != 8 {
            return Err(SessionError::Negotiation(format!(
                "SDIO_Connect phase {phase} returned {} bytes instead of 8",
                data.len()
            )));
        }
        Ok(())
    }

    fn handshake(&mut self, version: u16, extended: bool) -> Result<()> {
        self.sdio_connect(1)?;
        self.sdio_connect(2)?;
        let params: Vec<u32> = if extended {
            vec![version as u32, 1]
        } else {
            vec![version as u32]
        };
        let mut data = Vec::new();
        for attempt in 0..self.config.negotiate_retries.max(1) {
            data = self.read_in(op::SDIO_GET_EXT_DEVICE_INFO, &params)?;
            if !data.is_empty() {
                break;
            }
            if attempt + 1 < self.config.negotiate_retries {
                self.transport.sleep(self.config.negotiate_delay);
            }
        }
        if data.is_empty() {
            return Err(SessionError::Negotiation(
                "the camera returned no capability data".into(),
            ));
        }
        let ext = ExtDeviceInfo::parse(&data)?;
        if ext.version != codec::SDI_200 && ext.version != codec::SDI_300 {
            return Err(SessionError::Negotiation(format!(
                "unsupported SDI version {}",
                ext.version
            )));
        }
        self.version = ext.version;
        self.extended = extended && ext.version >= codec::SDI_300;
        self.ext = Some(ext);
        self.sdio_connect(3)?;
        Ok(())
    }

    /// Releases held controls, then closes the session.
    pub fn close(&mut self) -> Result<()> {
        if self.state == ConnectionState::Ready {
            let _ = self.release_to(0);
        }
        self.live = false;
        let deadline = self.deadline(self.config.command_timeout);
        let result = self.transport.close(deadline);
        if self.state != ConnectionState::Removed {
            self.state = ConnectionState::Closed;
        }
        result.map_err(SessionError::from)
    }

    /// Reads the full descriptor array. A malformed snapshot leaves the last good state intact.
    /// A closed session is reported, never reopened here: the owner replaces the session so the
    /// body identity is verified again.
    pub fn refresh_properties(&mut self) -> Result<Vec<u16>> {
        let data = self.read_in(op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO, &[])?;
        let preferred = self.profile.grammar(self.version);
        let snapshot = match codec::resolve_snapshot(&data, preferred) {
            Ok(s) => s,
            Err(e) => {
                self.rejected_snapshot = Some(data);
                return Err(e.into());
            }
        };
        self.rejected_snapshot = snapshot.ambiguous.then_some(data);
        self.ambiguous = snapshot.ambiguous;
        self.grammar = Some(snapshot.grammar);
        let next: BTreeMap<u16, DevicePropDesc> = snapshot
            .descriptors
            .into_iter()
            .map(|d| (d.code, d))
            .collect();
        let mut changed: Vec<u16> = next
            .iter()
            .filter(|(code, d)| self.props.get(code) != Some(d))
            .map(|(code, _)| *code)
            .collect();
        changed.extend(self.props.keys().filter(|c| !next.contains_key(c)));
        for code in &changed {
            self.prop_rev += 1;
            self.revs.insert(*code, self.prop_rev);
        }
        self.props = next;
        self.props_dirty = false;
        Ok(changed)
    }

    /// Applies pending transport events. Events from a retired generation are ignored.
    pub fn process_events(&mut self) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        while let Some(event) = self.transport.poll_event() {
            if let Some(e) = self.apply_event(event) {
                if !out.contains(&e) {
                    out.push(e);
                }
            }
        }
        out
    }

    pub fn apply_event(&mut self, event: TransportEvent) -> Option<SessionEvent> {
        if event.generation() != self.transport.generation() {
            return None;
        }
        match event {
            TransportEvent::Ptp { code, params, .. } => match code {
                // Only the capture pseudo-handle bypasses the D215 readiness check; any other
                // object event just asks for a fresh reading.
                ptp::event::SONY_OBJECT_ADDED if params.first() == Some(&handle::CAPTURE) => {
                    self.object_added = true;
                    Some(SessionEvent::ObjectAdded)
                }
                ptp::event::SONY_OBJECT_REMOVED if params.first() == Some(&handle::CAPTURE) => {
                    self.object_added = false;
                    None
                }
                ptp::event::SONY_OBJECT_ADDED
                | ptp::event::OBJECT_ADDED
                | ptp::event::SONY_OBJECT_REMOVED
                | ptp::event::OBJECT_REMOVED => {
                    self.props_dirty = true;
                    Some(SessionEvent::PropertiesDirty)
                }
                ptp::event::SONY_PROPERTY_CHANGED | ptp::event::DEVICE_PROP_CHANGED => {
                    self.props_dirty = true;
                    Some(SessionEvent::PropertiesDirty)
                }
                _ => None,
            },
            TransportEvent::Removed { .. } => {
                self.mark_removed();
                Some(SessionEvent::Removed)
            }
            TransportEvent::SessionLost { .. } => {
                self.state = ConnectionState::Lost;
                Some(SessionEvent::SessionLost)
            }
        }
    }

    fn press(&mut self, code: u16) -> Result<()> {
        // Release is owed as soon as the command can have reached the body.
        if !self.held.contains(&code) {
            self.held.push(code);
        }
        if code == control::S2 {
            self.s2_dispatched = true;
        }
        match self.write_out(
            op::SDIO_CONTROL_DEVICE,
            &[code as u32],
            &control::BUTTON_DOWN,
        ) {
            Ok(()) => Ok(()),
            Err(SessionError::Removed { .. }) => Err(SessionError::Removed {
                shutter_uncertain: self.s2_dispatched,
            }),
            Err(e @ SessionError::Response { .. }) => {
                // An explicit refusal: the button never went down.
                self.held.retain(|c| *c != code);
                if code == control::S2 {
                    self.s2_dispatched = false;
                }
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// Sends button-up, retrying while the camera is busy. The press stays owed until the camera
    /// acknowledges the release.
    fn release(&mut self, code: u16) -> Result<()> {
        let until = self.deadline(self.config.busy_deadline);
        let mut attempt = 0;
        loop {
            match self.write_out(op::SDIO_CONTROL_DEVICE, &[code as u32], &control::BUTTON_UP) {
                Ok(()) => {
                    self.held.retain(|c| *c != code);
                    return Ok(());
                }
                Err(SessionError::Response {
                    code: resp::DEVICE_BUSY,
                    ..
                }) if self.transport.now() < until => {
                    self.transport.sleep(backoff(attempt));
                    attempt += 1;
                }
                Err(SessionError::Removed { .. }) => {
                    return Err(SessionError::Removed {
                        shutter_uncertain: self.s2_dispatched,
                    })
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Releases presses above `mark` in reverse order, attempting every one. Presses the camera
    /// did not acknowledge stay owed.
    fn release_to(&mut self, mark: usize) -> Result<()> {
        let owed: Vec<u16> = self.held.iter().skip(mark).rev().copied().collect();
        let mut first = None;
        for code in owed {
            match self.release(code) {
                Ok(()) => {}
                Err(e @ SessionError::Removed { .. }) => return Err(e),
                Err(e) => {
                    first.get_or_insert(e);
                }
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// Focus priority applies in AF-S-like modes; MF and AF-C (balanced by default) release freely.
    pub fn should_wait_for_focus(&self) -> bool {
        matches!(
            self.value(prop::FOCUS_MODE).map(|v| v as u16),
            Some(0x0002 | 0x8005 | 0x8006)
        )
    }

    pub fn focus_indication(&self) -> Option<FocusIndication> {
        self.value(prop::FOCUS_INDICATION)
            .map(|v| FocusIndication::from_raw(v as u8))
    }

    fn wait_for_focus(&mut self, cancel: &AtomicBool) -> Result<bool> {
        let until = self.deadline(self.config.af_budget);
        loop {
            self.refresh_properties()?;
            match self.focus_indication() {
                Some(f) if f.is_focused() => return Ok(true),
                Some(f) if f.is_unfocused() => return Ok(false),
                _ => {}
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(SessionError::Cancelled);
            }
            if self.transport.now() >= until {
                return Ok(false);
            }
            let poll = self.config.af_poll;
            self.transport.sleep(poll);
        }
    }

    /// S1 down → optional focus wait → S2 down → S2 up → S1 up. Outstanding presses are always
    /// released in reverse order; a press held by AF-On stays held.
    pub fn capture(
        &mut self,
        options: CaptureOptions,
        cancel: &AtomicBool,
    ) -> Result<CaptureOutcome> {
        self.require_ready()?;
        if !self.has_control(control::S1) || !self.has_control(control::S2) {
            return Err(SessionError::Unsupported(
                "This camera does not offer remote shutter release.".into(),
            ));
        }
        // Presses an earlier capture still owes are settled first; a focus hold keeps S1.
        let owed: Vec<u16> = self.held.iter().rev().copied().collect();
        for code in owed {
            if code != control::S1 || self.half_press.is_none() {
                self.release(code)?;
            }
        }
        let mark = self.held.len();
        self.s2_dispatched = false;
        let result = self.capture_presses(options, cancel);
        let unwind = if self.state == ConnectionState::Removed {
            Ok(())
        } else {
            self.release_to(mark)
        };
        let fired = std::mem::take(&mut self.s2_dispatched);
        // Once S2 may have reached the body, a broken link cannot say whether the shutter fired.
        let uncertain = |e: SessionError| match e {
            SessionError::Removed { .. } => SessionError::Removed {
                shutter_uncertain: fired,
            },
            SessionError::Transport(_) | SessionError::Protocol(_) | SessionError::SessionLost
                if fired =>
            {
                SessionError::Removed {
                    shutter_uncertain: true,
                }
            }
            e => e,
        };
        match (result, unwind) {
            (Err(e), _) => Err(uncertain(e)),
            (Ok(_), Err(e @ SessionError::Removed { .. })) => Err(uncertain(e)),
            // The shutter released; an unacknowledged button-up stays owed and is retried.
            (Ok(CaptureOutcome::Released), Err(_)) => Ok(CaptureOutcome::Released),
            (Ok(_), Err(e)) => Err(e),
            (Ok(outcome), Ok(())) => Ok(outcome),
        }
    }

    fn capture_presses(
        &mut self,
        options: CaptureOptions,
        cancel: &AtomicBool,
    ) -> Result<CaptureOutcome> {
        if !self.held.contains(&control::S1) {
            self.press(control::S1)?;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(SessionError::Cancelled);
        }
        if options.wait_for_focus && !self.wait_for_focus(cancel)? {
            return Ok(CaptureOutcome::FocusNotAcquired);
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(SessionError::Cancelled);
        }
        self.press(control::S2)?;
        let hold = self.config.press_hold;
        self.transport.sleep(hold);
        Ok(CaptureOutcome::Released)
    }

    /// Momentary half-press tied to `hold_id`; repeating the same hold is a no-op.
    pub fn half_press(&mut self, hold_id: &str) -> Result<()> {
        self.require_ready()?;
        match &self.half_press {
            Some(h) if h == hold_id => return Ok(()),
            Some(_) => return Err(SessionError::Locked("Another focus hold is active.".into())),
            None => {}
        }
        if !self.has_control(control::S1) {
            return Err(SessionError::Unsupported(
                "This camera does not offer remote half-press.".into(),
            ));
        }
        self.press(control::S1)?;
        self.half_press = Some(hold_id.to_string());
        Ok(())
    }

    /// Releases the half-press if it belongs to `hold_id` (or any hold when `None`).
    pub fn half_release(&mut self, hold_id: Option<&str>) -> Result<bool> {
        match (&self.half_press, hold_id) {
            (None, _) => return Ok(false),
            (Some(h), Some(id)) if h != id => return Ok(false),
            _ => {}
        }
        self.half_press = None;
        if self.state != ConnectionState::Ready {
            self.held.clear();
            return Ok(true);
        }
        self.release(control::S1)?;
        Ok(true)
    }

    pub fn fel_supported(&self) -> bool {
        self.has_control(control::FEL)
    }

    pub fn pulse_fel(&mut self, cancel: &AtomicBool) -> Result<()> {
        self.require_ready()?;
        if !self.fel_supported() {
            return Err(SessionError::Unsupported(
                "This camera does not offer flash exposure lock.".into(),
            ));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(SessionError::Cancelled);
        }
        if self.held.contains(&control::FEL) {
            self.release(control::FEL)?;
        }
        let down = self.press(control::FEL);
        if down.is_ok() && !cancel.load(Ordering::SeqCst) {
            self.transport.sleep(self.config.press_hold);
        }
        let up = if self.state == ConnectionState::Removed {
            Ok(())
        } else {
            self.release(control::FEL)
        };
        down?;
        up?;
        if cancel.load(Ordering::SeqCst) {
            return Err(SessionError::Cancelled);
        }
        self.refresh_properties()?;
        Ok(())
    }

    fn near_far_range(&self) -> (i16, i16) {
        match self.props.get(&control::NEAR_FAR).map(|d| &d.form) {
            Some(Form::Range { min, max, .. }) => (
                min.as_i128().unwrap_or(-7).clamp(-7, 0) as i16,
                max.as_i128().unwrap_or(7).clamp(0, 7) as i16,
            ),
            _ => (-7, 7),
        }
    }

    pub fn focus_step_available(&self) -> std::result::Result<(), String> {
        if !self.has_control(control::NEAR_FAR) {
            return Err("This camera does not offer focus steps.".into());
        }
        if self.value(prop::NEAR_FAR_ENABLE) != Some(1) {
            return Err("Focus steps need an AF lens with the camera in AF or DMF.".into());
        }
        Ok(())
    }

    /// One near/far notch of `size` (1–3); near is negative.
    pub fn focus_step(&mut self, near: bool, size: u8) -> Result<()> {
        self.require_ready()?;
        self.focus_step_available().map_err(SessionError::Locked)?;
        let (min, max) = self.near_far_range();
        let notch = size.clamp(1, 3) as i16 * if near { -1 } else { 1 };
        let payload = codec::near_far_payload(notch, min, max)?;
        self.write_out(
            op::SDIO_CONTROL_DEVICE,
            &[control::NEAR_FAR as u32],
            &payload,
        )
    }

    /// Moves the AF point on the 640×480 control grid.
    pub fn set_af_position(&mut self, x: u16, y: u16) -> Result<()> {
        self.require_ready()?;
        if !self.has_control(control::AF_AREA_POSITION) {
            return Err(SessionError::Unsupported(
                "This camera does not offer AF point control.".into(),
            ));
        }
        let payload = codec::af_area_position_payload(x, y)?;
        self.write_out(
            op::SDIO_CONTROL_DEVICE,
            &[control::AF_AREA_POSITION as u32],
            &payload,
        )
    }

    fn lock_reason(&self, desc: &DevicePropDesc) -> String {
        if self.ambiguous {
            return "Camera settings could not be decoded unambiguously; changes are disabled."
                .into();
        }
        match desc.code {
            prop::EXPOSURE_PROGRAM => "Set with the camera's mode dial.".into(),
            prop::SAVE_DESTINATION => {
                if self.profile == CameraProfile::Alpha7III {
                    "Change Still Img. Save Dest. in the camera's PC Remote Settings before connecting."
                        .into()
                } else {
                    "Change Still Img. Save Dest. under Remote Shoot Setting on the camera.".into()
                }
            }
            _ if desc.is_enabled == 0 => "Not available in the camera's current mode.".into(),
            _ => "Read-only on this camera.".into(),
        }
    }

    /// Writes `value_id` after checking the expected revision: a choice ID for lists, a decimal
    /// number for ranges, or `inc`/`dec`/a signed step for detent controls. Reads back and
    /// returns the changed codes.
    pub fn set_property(
        &mut self,
        code: u16,
        value_id: &str,
        expected_rev: Option<u64>,
    ) -> Result<Vec<u16>> {
        self.require_ready()?;
        let desc = self.props.get(&code).cloned().ok_or_else(|| {
            SessionError::Unsupported("The camera does not report this setting.".into())
        })?;
        if let Some(rev) = expected_rev {
            let current = self.rev_of(code);
            if rev != current {
                return Err(SessionError::StaleRevision { current });
            }
        }
        if self.ambiguous {
            return Err(SessionError::Locked(self.lock_reason(&desc)));
        }
        match codec::write_route(&desc, self.version) {
            WriteRoute::ReadOnly => Err(SessionError::Locked(self.lock_reason(&desc))),
            WriteRoute::Absolute => {
                let parsed = match desc.form {
                    // Ranges are numbers; "5600" is 5600 K, never the hex ID 0x5600.
                    Form::Range { .. } => value_id
                        .trim()
                        .parse::<i128>()
                        .ok()
                        .and_then(|v| PropValue::from_i128(desc.data_type, v)),
                    _ => PropValue::from_id(desc.data_type, value_id),
                };
                let value = parsed.filter(|v| desc.accepts(v)).ok_or_else(|| {
                    SessionError::InvalidValue("The camera does not offer that value now.".into())
                })?;
                let mut params = vec![code as u32];
                if self.extended && code >= 0xE000 {
                    params.push(1);
                }
                self.write_out(op::SDIO_SET_EXT_DEVICE_PROP_VALUE, &params, &value.encode())?;
                let changed = self.refresh_properties()?;
                if self.props.get(&code).map(|d| &d.current) != Some(&value) {
                    return Err(SessionError::NotApplied(
                        "The camera kept its previous value.".into(),
                    ));
                }
                Ok(changed)
            }
            WriteRoute::RelativeNotch => self.notch_toward(&desc, value_id),
        }
    }

    fn send_notch(&mut self, code: u16, up: bool) -> Result<()> {
        let payload = if up {
            control::M3_NOTCH_UP
        } else {
            control::M3_NOTCH_DOWN
        };
        self.write_out(op::SDIO_CONTROL_DEVICE, &[code as u32], &payload)
    }

    fn notch_toward(&mut self, desc: &DevicePropDesc, value_id: &str) -> Result<Vec<u16>> {
        let code = desc.code;
        let mut changed = Vec::new();
        if let Some(steps) = notch_steps(value_id) {
            let position = |value: &PropValue| match &desc.form {
                Form::Enum { writable, .. } => {
                    writable.iter().position(|v| v == value).map(|i| i as i128)
                }
                _ => value.as_i128(),
            };
            let mut before = position(&desc.current);
            let up_increases = *self.notch_up_increases.get(&code).unwrap_or(&true);
            for _ in 0..steps.unsigned_abs() {
                self.send_notch(code, (steps > 0) == up_increases)?;
                changed.extend(self.refresh_properties()?);
                let after = self.props.get(&code).and_then(|p| position(&p.current));
                if !before
                    .zip(after)
                    .is_some_and(|(a, b)| if steps > 0 { b > a } else { b < a })
                {
                    return Err(SessionError::NotApplied(
                        "The camera did not move this setting in the requested direction.".into(),
                    ));
                }
                before = after;
            }
            return Ok(changed);
        }
        let Form::Enum { writable, .. } = &desc.form else {
            return Err(SessionError::InvalidValue(
                "This setting moves one step at a time.".into(),
            ));
        };
        let choices = writable.clone();
        let target = PropValue::from_id(desc.data_type, value_id)
            .and_then(|v| choices.iter().position(|c| *c == v))
            .ok_or_else(|| {
                SessionError::InvalidValue("The camera does not offer that value now.".into())
            })?;
        let index = |s: &Self| -> Option<usize> {
            let current = &s.props.get(&code)?.current;
            choices.iter().position(|c| c == current)
        };
        let mut position = index(self).ok_or_else(|| {
            SessionError::NotApplied("The current value is not among the camera's choices.".into())
        })?;
        let mut stalls = 0;
        let budget = choices.len() * 2 + 4;
        for _ in 0..budget.min(64) {
            if position == target {
                return Ok(changed);
            }
            let want_increase = target > position;
            let up_increases = *self.notch_up_increases.get(&code).unwrap_or(&true);
            self.send_notch(code, want_increase == up_increases)?;
            changed.extend(self.refresh_properties()?);
            let Some(now) = index(self) else {
                return Err(SessionError::NotApplied(
                    "The camera moved to a value outside its choices.".into(),
                ));
            };
            if now == position {
                stalls += 1;
                if stalls >= 2 {
                    return Err(SessionError::NotApplied(
                        "The camera did not change this setting.".into(),
                    ));
                }
                continue;
            }
            stalls = 0;
            // Learn the dial direction only from single steps; a jump may be a wrap.
            if now.abs_diff(position) == 1 && (now > position) != want_increase {
                self.notch_up_increases.insert(code, !up_increases);
            }
            position = now;
        }
        if position == target {
            Ok(changed)
        } else {
            Err(SessionError::NotApplied(
                "The camera did not reach the requested value.".into(),
            ))
        }
    }

    /// The transfer queue as currently known, without any camera I/O.
    pub fn queue_signal(&self) -> QueueSignal {
        codec::queue_signal(self.value(prop::OBJECT_IN_MEMORY).unwrap_or(0) as u16)
    }

    pub fn refresh_capture_pending(&mut self) -> Result<bool> {
        self.process_events();
        self.require_ready()?;
        self.refresh_properties()?;
        self.process_events();
        self.require_ready()?;
        Ok(self.object_announced() || self.queue_signal() != QueueSignal::Empty)
    }

    /// Reads at most one object from the capture queue into the sink `open` returns.
    pub fn drain_one<W, F>(&mut self, open: F) -> Result<DrainStep<W>>
    where
        W: Write + Send,
        F: FnOnce(&ObjectInfo, FileKind) -> std::io::Result<W>,
    {
        self.require_ready()?;
        self.process_events();
        self.require_ready()?;
        if !self.object_added {
            self.refresh_properties()?;
            match self.queue_signal() {
                QueueSignal::Ready => self.bare_msb_since = None,
                QueueSignal::Empty => {
                    self.bare_msb_since = None;
                    self.invalid_streak = 0;
                    return Ok(DrainStep::Empty);
                }
                QueueSignal::Pending => return Ok(DrainStep::Pending),
                QueueSignal::BareMsb => {
                    let now = self.transport.now();
                    let since = *self.bare_msb_since.get_or_insert(now);
                    return Ok(if now.duration_since(since) >= self.config.stall_after {
                        DrainStep::Stalled
                    } else {
                        DrainStep::Pending
                    });
                }
            }
        }
        let mut info_bytes = Vec::new();
        let reply = self.raw(
            op::GET_OBJECT_INFO,
            &[handle::CAPTURE],
            DataPhase::In {
                sink: &mut info_bytes,
                limit: 1 << 16,
            },
            self.config.command_timeout,
        )?;
        if reply.code == resp::INVALID_OBJECT_HANDLE {
            return self.invalid_head();
        }
        if reply.code == resp::DEVICE_BUSY {
            return Ok(DrainStep::Pending);
        }
        Self::ok(op::GET_OBJECT_INFO, reply)?;
        let info = ObjectInfo::parse(&info_bytes)?;
        if info.compressed_size == 0 {
            return Ok(DrainStep::Pending);
        }
        let expected = ptp::kind_from_info(info.object_format, &info.filename);
        let mut sink =
            open(&info, expected).map_err(|e| SessionError::Transport(TransportError::Sink(e)))?;
        let declared = info.compressed_size;
        // ObjectInfo sizes can under-report; a larger object is still staged and then reported.
        let limit = if declared == u32::MAX {
            self.config.max_object_bytes
        } else {
            self.config.max_object_bytes.max(declared as u64)
        };
        let mut tee = HeadTee {
            inner: &mut sink,
            head: Vec::with_capacity(16),
        };
        let reply = self.raw(
            op::GET_OBJECT,
            &[handle::CAPTURE],
            DataPhase::In {
                sink: &mut tee,
                limit,
            },
            self.config.transfer_timeout,
        )?;
        let head = std::mem::take(&mut tee.head);
        if reply.code == resp::INVALID_OBJECT_HANDLE {
            return self.invalid_head();
        }
        Self::ok(op::GET_OBJECT, reply.clone())?;
        self.object_added = false;
        self.invalid_streak = 0;
        self.bare_msb_since = None;
        let kind = ptp::classify(info.object_format, &info.filename, &head);
        let object = DrainedObject {
            info,
            kind,
            bytes: reply.bytes_in,
        };
        if declared != u32::MAX && reply.bytes_in != declared as u64 {
            return Ok(DrainStep::Short {
                object,
                sink,
                expected: declared as u64,
            });
        }
        Ok(DrainStep::Object(object, sink))
    }

    fn invalid_head<W>(&mut self) -> Result<DrainStep<W>> {
        self.object_added = false;
        self.invalid_streak += 1;
        self.refresh_properties()?;
        if self.invalid_streak >= 3 && self.queue_signal() == QueueSignal::Ready {
            return Err(SessionError::QueueFault(
                "The camera reports a ready photo it cannot deliver.".into(),
            ));
        }
        Ok(DrainStep::Empty)
    }

    pub fn live_view_supported(&self) -> std::result::Result<(), String> {
        match self.value(prop::LIVE_VIEW_STATUS) {
            Some(1) => Ok(()),
            Some(2) | None => Err("This camera does not offer Live View over USB.".into()),
            _ => Err("Live View is not available in the camera's current mode.".into()),
        }
    }

    /// Checks D221 and sends the single initial 1008(FFFFC002).
    pub fn start_live_view(&mut self) -> Result<()> {
        self.require_ready()?;
        self.refresh_properties()?;
        self.live_view_supported()
            .map_err(SessionError::LiveViewUnavailable)?;
        if !self.live_info {
            let mut attempt = 0;
            loop {
                let mut info = Vec::new();
                let reply = self.raw(
                    op::GET_OBJECT_INFO,
                    &[handle::LIVE_VIEW],
                    DataPhase::In {
                        sink: &mut info,
                        limit: 1 << 16,
                    },
                    self.config.command_timeout,
                )?;
                match reply.code {
                    resp::OK => break,
                    resp::ACCESS_DENIED | resp::DEVICE_BUSY | resp::INVALID_OBJECT_HANDLE
                        if attempt < 5 =>
                    {
                        self.transport.sleep(backoff(attempt));
                        attempt += 1;
                    }
                    code => {
                        return Err(SessionError::Response {
                            opcode: op::GET_OBJECT_INFO,
                            code,
                        })
                    }
                }
            }
            self.live_info = true;
        }
        self.live = true;
        Ok(())
    }

    pub fn stop_live_view(&mut self) {
        self.live = false;
    }

    /// One 1009(FFFFC002). `Ok(None)` when the frame is not ready yet.
    pub fn fetch_live_frame(&mut self) -> Result<Option<LiveImage>> {
        self.require_ready()?;
        if !self.live {
            return Err(SessionError::LiveViewUnavailable(
                "Live View is off.".into(),
            ));
        }
        let mut payload = Vec::new();
        for attempt in 0..5 {
            payload.clear();
            let limit = self.config.max_live_bytes;
            let reply = self.raw(
                op::GET_OBJECT,
                &[handle::LIVE_VIEW],
                DataPhase::In {
                    sink: &mut payload,
                    limit,
                },
                self.config.command_timeout,
            )?;
            match reply.code {
                resp::OK => {
                    let layout = LiveLayout::for_version(self.version);
                    return Ok(
                        codec::extract_live_view(&payload, layout)?.map(|f| LiveImage {
                            jpeg: f.jpeg.to_vec(),
                            width: f.width,
                            height: f.height,
                        }),
                    );
                }
                resp::ACCESS_DENIED => self.transport.sleep(Duration::from_millis(20)),
                resp::DEVICE_BUSY => self.transport.sleep(backoff(attempt)),
                resp::INVALID_OBJECT_HANDLE => {
                    self.refresh_properties()?;
                    if let Err(reason) = self.live_view_supported() {
                        self.live = false;
                        return Err(SessionError::LiveViewUnavailable(reason));
                    }
                    self.transport.sleep(Duration::from_millis(50));
                }
                code => {
                    return Err(SessionError::Response {
                        opcode: op::GET_OBJECT,
                        code,
                    })
                }
            }
        }
        Ok(None)
    }

    pub fn exposure_snapshot(&self) -> ExposureSnapshot {
        let iso = self
            .value(prop::ISO)
            .map(|v| Iso { raw: v as u32 })
            .filter(|i| !i.is_auto() && i.base() > 0)
            .map(|i| i.base());
        let shutter = match self
            .value(prop::SHUTTER_SPEED)
            .and_then(|v| Shutter::decode(v as u32))
        {
            Some(Shutter::Fraction {
                numerator,
                denominator,
            }) if numerator > 0 && denominator > 0 => Some(format!("{numerator}/{denominator}")),
            _ => None,
        };
        let aperture = self
            .value(prop::F_NUMBER)
            .and_then(|v| codec::f_number(v as u16));
        ExposureSnapshot {
            iso,
            shutter,
            aperture,
        }
    }

    /// Host file roles each exposure delivers: the PC delivery setting narrows the recorded
    /// file format. `None` when neither is known or they share no host role.
    pub fn expected_host_roles(&self) -> Option<Vec<HostRole>> {
        use HostRole::{Jpeg, Raw};
        let recorded = if let Some(v) = self.value(prop::FILE_FORMAT) {
            match v {
                1 | 4 => Some(vec![Raw]),
                2 => Some(vec![Raw, Jpeg]),
                3 => Some(vec![Jpeg]),
                _ => None,
            }
        } else {
            match self.value(prop::COMPRESSION) {
                Some(0x01..=0x04) => Some(vec![Jpeg]),
                Some(0x10) => Some(vec![Raw]),
                Some(0x11..=0x14) => Some(vec![Raw, Jpeg]),
                _ => None,
            }
        };
        // 0 means the body does not restrict delivery to the PC.
        let delivered = match self.value(prop::PC_SAVE_FORMAT) {
            None | Some(0) => return recorded,
            Some(1) => vec![Raw, Jpeg],
            Some(2) => vec![Jpeg],
            Some(3 | 4) => vec![Raw],
            Some(_) => return None,
        };
        let Some(recorded) = recorded else {
            return Some(delivered);
        };
        let both: Vec<HostRole> = delivered
            .into_iter()
            .filter(|r| recorded.contains(r))
            .collect();
        (!both.is_empty()).then_some(both)
    }

    pub fn battery_percent(&self) -> Option<u8> {
        self.value(prop::BATTERY_REMAINING)
            .and_then(|v| codec::battery_percent(v as u8 as i8))
    }

    pub fn save_destination(&self) -> Option<u16> {
        self.value(prop::SAVE_DESTINATION).map(|v| v as u16)
    }

    pub fn delivers_to_host(&self) -> Option<bool> {
        self.save_destination()
            .map(codec::save_destination_reaches_host)
    }

    pub fn code_for_key(&self, key: &str) -> Option<u16> {
        code_for_key(key, self.props.contains_key(&prop::COMPRESSION))
    }

    fn choices(&self, code: u16, values: &[PropValue]) -> Vec<Choice> {
        let menu = self.profile.current_menu();
        values
            .iter()
            .map(|v| Choice {
                id: v.id(),
                label: codec::value_label(code, v, menu),
            })
            .collect()
    }

    fn describe(
        &self,
        key: &'static str,
        label: &'static str,
        desc: &DevicePropDesc,
    ) -> CameraProperty {
        let menu = self.profile.current_menu();
        let route = if self.ambiguous {
            WriteRoute::ReadOnly
        } else {
            codec::write_route(desc, self.version)
        };
        let readings = [
            prop::BATTERY_REMAINING,
            prop::FOCUS_INDICATION,
            prop::FOCAL_POSITION,
        ];
        let kind = if readings.contains(&desc.code) {
            PropertyKind::Reading
        } else {
            match &desc.form {
                Form::Enum { .. } => PropertyKind::Enum,
                Form::Range { .. } => PropertyKind::Range,
                Form::None => PropertyKind::Reading,
            }
        };
        let access = if route == WriteRoute::ReadOnly {
            Access::ReadOnly
        } else {
            Access::ReadWrite
        };
        let choices = match (&desc.form, kind) {
            (
                Form::Enum {
                    writable,
                    reportable,
                },
                PropertyKind::Enum,
            ) => {
                if access == Access::ReadWrite {
                    self.choices(desc.code, writable)
                } else {
                    self.choices(desc.code, reportable)
                }
            }
            _ => Vec::new(),
        };
        let range = match (&desc.form, kind) {
            (Form::Range { min, max, step }, PropertyKind::Range) => Some(RangeSpec {
                min: min.as_i128().unwrap_or(0) as f64,
                max: max.as_i128().unwrap_or(0) as f64,
                step: step.as_i128().unwrap_or(1) as f64,
                unit: match desc.code {
                    prop::COLOR_TEMPERATURE => "K",
                    _ => "",
                },
            }),
            _ => None,
        };
        CameraProperty {
            key,
            label,
            code: desc.code,
            kind,
            value: Some(desc.current.id()),
            display: codec::value_label(desc.code, &desc.current, menu),
            access,
            choices,
            range,
            reason: (access != Access::ReadWrite && kind != PropertyKind::Reading)
                .then(|| self.lock_reason(desc)),
            prop_rev: self.rev_of(desc.code),
            relative: route == WriteRoute::RelativeNotch,
            number: (kind == PropertyKind::Range)
                .then(|| desc.current.as_i128().and_then(|v| i64::try_from(v).ok()))
                .flatten(),
        }
    }

    /// Normalized panel properties for every advertised code the camera reported.
    pub fn camera_properties(&self) -> Vec<CameraProperty> {
        let legacy = self.props.contains_key(&prop::COMPRESSION);
        PANEL
            .iter()
            .filter_map(|(key, label, code)| {
                let code = if *key == "quality" && !legacy {
                    prop::FILE_FORMAT
                } else {
                    *code
                };
                self.props.get(&code).map(|d| self.describe(key, label, d))
            })
            .collect()
    }

    pub fn actions(&self) -> Vec<ActionCap> {
        let cap = |key, result: std::result::Result<(), String>| ActionCap {
            key,
            available: result.is_ok(),
            reason: result.err(),
        };
        let shutter = if self.has_control(control::S1) && self.has_control(control::S2) {
            match self.delivers_to_host() {
                Some(false) => Err("The camera saves to its card only. Choose a destination that sends files to this computer.".into()),
                _ => Ok(()),
            }
        } else {
            Err("This camera does not offer remote shutter release.".into())
        };
        let half = if self.has_control(control::S1) {
            Ok(())
        } else {
            Err("This camera does not offer remote half-press.".into())
        };
        let steps = self.focus_step_available();
        let af_point = if self.has_control(control::AF_AREA_POSITION) {
            Ok(())
        } else {
            Err("This camera does not offer AF point control over USB.".into())
        };
        let mut out = vec![
            cap("trigger", shutter),
            cap("halfPress", half),
            cap("liveView", self.live_view_supported()),
            cap("afPoint", af_point),
            cap(
                "fel",
                if self.fel_supported() {
                    Ok(())
                } else {
                    Err("This camera does not offer flash exposure lock.".into())
                },
            ),
        ];
        for key in [
            "focusNear1",
            "focusNear2",
            "focusNear3",
            "focusFar1",
            "focusFar2",
            "focusFar3",
        ] {
            out.push(cap(key, steps.clone()));
        }
        out
    }
}

/// Typed value of a scalar descriptor, for tests and diagnostics.
pub fn scalar(value: &PropValue) -> Option<i128> {
    match value.data_type() {
        t if dtype::width(t).is_some() => value.as_i128(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use super::super::transport::{ExpectedPhase, ScriptedTransport, Step};
    use super::*;
    use std::sync::{Arc, Mutex};

    const ZERO8: [u8; 8] = [0; 8];

    fn ok_in(bytes: Vec<u8>) -> (ExpectedPhase, std::result::Result<Reply, TransportError>) {
        let n = bytes.len() as u64;
        (ExpectedPhase::In(bytes), Ok(Reply::ok(n)))
    }

    fn expect_in(t: &mut ScriptedTransport, opcode: u16, params: &[u32], bytes: Vec<u8>) {
        let (phase, result) = ok_in(bytes);
        t.expect(opcode, params, phase, result);
    }

    fn expect_out(t: &mut ScriptedTransport, opcode: u16, params: &[u32], bytes: &[u8]) {
        t.expect(
            opcode,
            params,
            ExpectedPhase::Out(bytes.to_vec()),
            Ok(Reply::ok(0)),
        );
    }

    fn snapshot(t: &mut ScriptedTransport, payload: Vec<u8>) {
        expect_in(t, op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO, &[], payload);
    }

    fn m3_handshake(t: &mut ScriptedTransport, payload: Vec<u8>) {
        t.push(Step::Open);
        expect_in(
            t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7M3").encode(),
        );
        expect_in(t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        expect_in(
            t,
            op::SDIO_GET_EXT_DEVICE_INFO,
            &[0xC8],
            m3_ext_device_info(),
        );
        expect_in(t, op::SDIO_CONNECT, &[3, 0, 0], ZERO8.to_vec());
        snapshot(t, payload);
    }

    fn cm2_handshake(t: &mut ScriptedTransport, payload: Vec<u8>) {
        t.push(Step::Open);
        expect_in(
            t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7CM2").encode(),
        );
        expect_in(t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        expect_in(
            t,
            op::SDIO_GET_EXT_DEVICE_INFO,
            &[0x12C, 1],
            cm2_ext_device_info(),
        );
        expect_in(t, op::SDIO_CONNECT, &[3, 0, 0], ZERO8.to_vec());
        snapshot(t, payload);
    }

    fn connected(
        handshake: fn(&mut ScriptedTransport, Vec<u8>),
        payload: Vec<u8>,
    ) -> SonySession<ScriptedTransport> {
        let mut t = ScriptedTransport::new();
        handshake(&mut t, payload);
        let mut s = SonySession::new(t, SessionConfig::default());
        s.connect().unwrap();
        s.transport_mut().sent.clear();
        s
    }

    fn m3(descs: Vec<DevicePropDesc>) -> SonySession<ScriptedTransport> {
        connected(
            m3_handshake,
            codec::encode_snapshot(&descs, Grammar::SingleList),
        )
    }

    fn cm2(descs: Vec<DevicePropDesc>) -> SonySession<ScriptedTransport> {
        connected(
            cm2_handshake,
            codec::encode_snapshot(&descs, Grammar::TwoList),
        )
    }

    fn m3_with(code: u16, value: PropValue) -> Vec<u8> {
        codec::encode_snapshot(
            &with_current(m3_descriptors(), code, value),
            Grammar::SingleList,
        )
    }

    fn cm2_with(code: u16, value: PropValue) -> Vec<u8> {
        codec::encode_snapshot(
            &with_current(cm2_descriptors(), code, value),
            Grammar::TwoList,
        )
    }

    fn opcodes(s: &SonySession<ScriptedTransport>) -> Vec<(u16, Vec<u32>, Option<Vec<u8>>)> {
        s.transport()
            .sent
            .iter()
            .map(|x| (x.opcode, x.params.clone(), x.out.clone()))
            .collect()
    }

    #[test]
    fn alpha7iii_handshake_negotiates_sdi_200_and_single_lists() {
        let mut t = ScriptedTransport::new();
        m3_handshake(&mut t, m3_snapshot_payload());
        let mut s = SonySession::new(t, SessionConfig::default());
        s.connect().unwrap();
        s.transport().finish();
        assert_eq!(s.profile(), CameraProfile::Alpha7III);
        assert_eq!(s.sdi_version(), 200);
        assert!(!s.extended_codes());
        assert_eq!(s.grammar(), Some(Grammar::SingleList));
        assert_eq!(s.state(), ConnectionState::Ready);
        assert_eq!(s.queue_signal(), QueueSignal::Ready);
        let sent: Vec<u16> = s.transport().sent.iter().map(|x| x.opcode).collect();
        assert_eq!(sent, [0x1001, 0x9201, 0x9201, 0x9202, 0x9201, 0x9209]);
        assert_eq!(s.transport().sent[3].params, [0xC8]);
        let props = s.camera_properties();
        let iso = props.iter().find(|p| p.key == "iso").unwrap();
        assert_eq!(iso.display, "ISO AUTO");
        assert_eq!(iso.access, Access::ReadWrite);
        assert!(iso.relative);
        assert_eq!(iso.choices.len(), M3_ISOS.len());
        let dest = props.iter().find(|p| p.key == "saveDestination").unwrap();
        assert_eq!(
            (dest.access, dest.display.as_str()),
            (Access::ReadOnly, "PC Only")
        );
        assert!(dest
            .reason
            .as_deref()
            .unwrap()
            .contains("before connecting"));
        let quality = props.iter().find(|p| p.key == "quality").unwrap();
        assert_eq!(quality.display, "RAW+JPEG Fine");
        let battery = props.iter().find(|p| p.key == "battery").unwrap();
        assert_eq!(
            (battery.kind, battery.display.as_str()),
            (PropertyKind::Reading, "51%")
        );
        assert_eq!(s.battery_percent(), Some(51));
        let snap = s.exposure_snapshot();
        assert_eq!(snap.shutter.as_deref(), Some("1/250"));
        assert_eq!(snap.aperture, Some(8.0));
        assert_eq!(snap.iso, None);
        assert_eq!(
            s.expected_host_roles(),
            Some(vec![HostRole::Raw, HostRole::Jpeg])
        );
        let actions = s.actions();
        assert!(actions.iter().all(|a| a.key != "trigger" || a.available));
        assert!(actions.iter().any(|a| a.key == "afPoint" && !a.available));
    }

    #[test]
    fn alpha7cii_retries_empty_negotiation_and_reads_two_lists() {
        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        expect_in(
            &mut t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7CM2").encode(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0x12C, 1], vec![]);
        expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0x12C, 1], vec![]);
        expect_in(
            &mut t,
            op::SDIO_GET_EXT_DEVICE_INFO,
            &[0x12C, 1],
            cm2_ext_device_info(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[3, 0, 0], ZERO8.to_vec());
        snapshot(&mut t, cm2_snapshot_payload());
        let mut s = SonySession::new(t, SessionConfig::default());
        s.connect().unwrap();
        s.transport().finish();
        assert_eq!(s.transport().elapsed(), Duration::from_millis(100));
        assert_eq!(
            (s.profile(), s.sdi_version()),
            (CameraProfile::Alpha7CII, 300)
        );
        assert!(s.extended_codes());
        assert_eq!(s.grammar(), Some(Grammar::TwoList));
        let props = s.camera_properties();
        let get = |k: &str| props.iter().find(|p| p.key == k).unwrap().clone();
        assert_eq!(get("program").display, "A");
        assert_eq!(get("drive").display, "Cont. Bracket: 0.3EV 3 Img.");
        assert_eq!(get("quality").display, "RAW+JPEG");
        assert_eq!(get("rawCompression").display, "Lossless Comp. L");
        assert_eq!(get("saveDestination").display, "Dest.+Camera");
        let focus = get("focusMode");
        assert_eq!(focus.access, Access::ReadOnly);
        assert_eq!(focus.choices.len(), 5);
        assert_eq!(
            s.expected_host_roles(),
            Some(vec![HostRole::Raw, HostRole::Jpeg])
        );
        assert_eq!(s.exposure_snapshot().iso, Some(800));
        let iso = get("iso");
        assert!(!iso.relative);
        assert_eq!(iso.access, Access::ReadWrite);
    }

    #[test]
    fn negotiation_stops_on_empty_or_unknown_versions() {
        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        expect_in(
            &mut t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7M3").encode(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        for _ in 0..20 {
            expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0xC8], vec![]);
        }
        let mut s = SonySession::new(t, SessionConfig::default());
        assert!(matches!(s.connect(), Err(SessionError::Negotiation(_))));
        s.transport().finish();

        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        expect_in(
            &mut t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7M3").encode(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        let mut odd = m3_ext_device_info();
        odd[0] = 0x64;
        expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0xC8], odd);
        let mut s = SonySession::new(t, SessionConfig::default());
        assert!(matches!(s.connect(), Err(SessionError::Negotiation(_))));
        assert_ne!(s.state(), ConnectionState::Ready);

        // Each SDIO_Connect phase answers exactly eight bytes, and the capability dataset ends
        // where its lists end.
        for (phase, reply) in [(1u32, vec![0u8; 4]), (2, vec![0; 9]), (3, vec![])] {
            let mut t = ScriptedTransport::new();
            t.push(Step::Open);
            expect_in(
                &mut t,
                op::GET_DEVICE_INFO,
                &[],
                device_info("ILCE-7M3").encode(),
            );
            for p in 1..=phase {
                let data = if p == phase {
                    reply.clone()
                } else {
                    ZERO8.to_vec()
                };
                expect_in(&mut t, op::SDIO_CONNECT, &[p, 0, 0], data);
                if p == 2 && phase == 3 {
                    expect_in(
                        &mut t,
                        op::SDIO_GET_EXT_DEVICE_INFO,
                        &[0xC8],
                        m3_ext_device_info(),
                    );
                }
            }
            let mut s = SonySession::new(t, SessionConfig::default());
            assert!(
                matches!(s.connect(), Err(SessionError::Negotiation(m)) if m.contains("instead of 8")),
                "phase {phase}"
            );
            s.transport().finish();
            assert_ne!(s.state(), ConnectionState::Ready);
        }
        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        expect_in(
            &mut t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7M3").encode(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        let mut trailing = m3_ext_device_info();
        trailing.extend_from_slice(&[0, 0]);
        expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0xC8], trailing);
        let mut s = SonySession::new(t, SessionConfig::default());
        assert!(matches!(
            s.connect(),
            Err(SessionError::Protocol(ProtocolError::Malformed(_)))
        ));
        s.transport().finish();

        // MTP mode: no Sony operations.
        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        let mut mtp = device_info("ILCE-7CM2");
        mtp.vendor_extension_id = 6;
        mtp.operations.retain(|o| *o < 0x9000);
        expect_in(&mut t, op::GET_DEVICE_INFO, &[], mtp.encode());
        let mut s = SonySession::new(t, SessionConfig::default());
        assert!(matches!(s.connect(), Err(SessionError::NotSonyRemote(m)) if m == "ILCE-7CM2"));
    }

    #[test]
    fn alpha7cii_falls_back_to_the_legacy_profile_after_a_clean_reopen() {
        let mut t = ScriptedTransport::new();
        t.push(Step::Open);
        expect_in(
            &mut t,
            op::GET_DEVICE_INFO,
            &[],
            device_info("ILCE-7CM2").encode(),
        );
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        t.expect(
            op::SDIO_GET_EXT_DEVICE_INFO,
            &[0x12C, 1],
            ExpectedPhase::In(vec![]),
            Ok(Reply::code(resp::PARAMETER_NOT_SUPPORTED)),
        );
        t.push(Step::Close).push(Step::Open);
        expect_in(&mut t, op::SDIO_CONNECT, &[1, 0, 0], ZERO8.to_vec());
        expect_in(&mut t, op::SDIO_CONNECT, &[2, 0, 0], ZERO8.to_vec());
        let mut legacy = m3_ext_device_info();
        legacy[0] = 0xC8;
        expect_in(&mut t, op::SDIO_GET_EXT_DEVICE_INFO, &[0xC8], legacy);
        expect_in(&mut t, op::SDIO_CONNECT, &[3, 0, 0], ZERO8.to_vec());
        snapshot(&mut t, m3_snapshot_payload());
        let mut s = SonySession::new(t, SessionConfig::default());
        s.connect().unwrap();
        s.transport().finish();
        assert_eq!(
            (s.profile(), s.sdi_version()),
            (CameraProfile::Alpha7CII, 200)
        );
        assert!(!s.extended_codes());
        // Unqualified SDI 200 grammar resolves by exact consumption.
        assert_eq!(s.grammar(), Some(Grammar::SingleList));
    }

    #[test]
    fn shutter_sends_all_four_edges_with_a_focus_wait() {
        let mut s = m3(m3_descriptors());
        assert!(s.should_wait_for_focus());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        snapshot(t, m3_with(prop::FOCUS_INDICATION, PropValue::U8(1)));
        snapshot(t, m3_with(prop::FOCUS_INDICATION, PropValue::U8(2)));
        expect_out(t, 0x9207, &[0xD2C2], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let cancel = AtomicBool::new(false);
        let outcome = s
            .capture(
                CaptureOptions {
                    wait_for_focus: true,
                },
                &cancel,
            )
            .unwrap();
        assert_eq!(outcome, CaptureOutcome::Released);
        s.transport().finish();
        assert!(s.held_controls().is_empty());
        let sent = opcodes(&s);
        assert_eq!(sent.first().unwrap().2.as_deref(), Some(&[2u8, 0][..]));
        assert_eq!(
            sent.last().unwrap(),
            &(0x9207, vec![0xD2C1], Some(vec![1, 0]))
        );
    }

    #[test]
    fn focus_priority_unwinds_s1_without_releasing_the_shutter() {
        // Low contrast ends the wait at once and is not reported as focus.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        snapshot(t, m3_with(prop::FOCUS_INDICATION, PropValue::U8(3)));
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let cancel = AtomicBool::new(false);
        let outcome = s
            .capture(
                CaptureOptions {
                    wait_for_focus: true,
                },
                &cancel,
            )
            .unwrap();
        assert_eq!(outcome, CaptureOutcome::FocusNotAcquired);
        s.transport().finish();

        // No lock within the budget.
        let mut s = m3(m3_descriptors());
        s.config.af_budget = Duration::from_millis(100);
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        for _ in 0..3 {
            snapshot(t, m3_with(prop::FOCUS_INDICATION, PropValue::U8(1)));
        }
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let outcome = s
            .capture(
                CaptureOptions {
                    wait_for_focus: true,
                },
                &cancel,
            )
            .unwrap();
        assert_eq!(outcome, CaptureOutcome::FocusNotAcquired);
        s.transport().finish();
        assert!(s.held_controls().is_empty());
    }

    #[test]
    fn cancel_and_failures_unwind_in_reverse_order() {
        let mut s = m3(m3_descriptors());
        let cancel = Arc::new(AtomicBool::new(false));
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        t.then_signal(cancel.clone());
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let result = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert!(matches!(result, Err(SessionError::Cancelled)));
        s.transport().finish();
        assert!(!opcodes(&s).iter().any(|x| x.1 == [0xD2C2]));

        // S2 rejected as busy: S1 is released, S2 is not resent.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        t.expect(
            0x9207,
            &[0xD2C2],
            ExpectedPhase::Out(vec![2, 0]),
            Ok(Reply::code(resp::DEVICE_BUSY)),
        );
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let cancel = AtomicBool::new(false);
        let result = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert!(matches!(
            result,
            Err(SessionError::Response { code: 0x2019, .. })
        ));
        s.transport().finish();

        // S2 times out, is cut off or answered with garbage: its outcome is unknown, so both
        // presses are released and the shutter is reported as uncertain.
        let failures = [
            TransportError::TimedOut,
            TransportError::Framing("truncated response".into()),
            TransportError::native("the camera closed the connection"),
        ];
        for failure in failures {
            let mut s = m3(m3_descriptors());
            let t = s.transport_mut();
            expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
            t.expect(
                0x9207,
                &[0xD2C2],
                ExpectedPhase::Out(vec![2, 0]),
                Err(failure),
            );
            expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
            expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
            let result = s.capture(
                CaptureOptions {
                    wait_for_focus: false,
                },
                &cancel,
            );
            assert!(
                matches!(
                    result,
                    Err(SessionError::Removed {
                        shutter_uncertain: true
                    })
                ),
                "{result:?}"
            );
            s.transport().finish();
        }

        // S1 failing the same way never fired the shutter.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        t.expect(
            0x9207,
            &[0xD2C1],
            ExpectedPhase::Out(vec![2, 0]),
            Err(TransportError::TimedOut),
        );
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let result = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert!(
            matches!(
                result,
                Err(SessionError::Transport(TransportError::TimedOut))
            ),
            "{result:?}"
        );
        s.transport().finish();

        // Unplugged during S2: shutter state is uncertain and nothing more is sent.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        t.expect(
            0x9207,
            &[0xD2C2],
            ExpectedPhase::Out(vec![2, 0]),
            Err(TransportError::Removed),
        );
        let result = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert!(matches!(
            result,
            Err(SessionError::Removed {
                shutter_uncertain: true
            })
        ));
        s.transport().finish();
        assert_eq!(s.state(), ConnectionState::Removed);
        assert!(s.held_controls().is_empty());
        assert!(matches!(
            s.refresh_properties(),
            Err(SessionError::Removed { .. })
        ));

        // Unplugged while releasing either button after S2 went down: the shutter may have fired.
        for unplug_on in [0xD2C2u32, 0xD2C1] {
            let mut s = m3(m3_descriptors());
            let t = s.transport_mut();
            expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
            expect_out(t, 0x9207, &[0xD2C2], &[2, 0]);
            if unplug_on == 0xD2C1 {
                expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
            }
            t.expect(
                0x9207,
                &[unplug_on],
                ExpectedPhase::Out(vec![1, 0]),
                Err(TransportError::Removed),
            );
            let result = s.capture(
                CaptureOptions {
                    wait_for_focus: false,
                },
                &cancel,
            );
            assert!(
                matches!(
                    result,
                    Err(SessionError::Removed {
                        shutter_uncertain: true
                    })
                ),
                "unplugged on {unplug_on:04X}: {result:?}"
            );
            s.transport().finish();
        }

        // A busy button-up is retried, and the press stays owed until the camera accepts it.
        let mut s = m3(m3_descriptors());
        s.config.busy_deadline = Duration::from_millis(120);
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[2, 0]);
        for _ in 0..3 {
            t.expect(
                0x9207,
                &[0xD2C2],
                ExpectedPhase::Out(vec![1, 0]),
                Ok(Reply::code(resp::DEVICE_BUSY)),
            );
        }
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let outcome = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert_eq!(outcome.unwrap(), CaptureOutcome::Released);
        s.transport().finish();
        assert_eq!(s.held_controls(), &[0xD2C2]);
        let t = s.transport_mut();
        t.expect(
            0x9207,
            &[0xD2C2],
            ExpectedPhase::Out(vec![1, 0]),
            Ok(Reply::code(resp::DEVICE_BUSY)),
        );
        expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        let outcome = s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        );
        assert_eq!(outcome.unwrap(), CaptureOutcome::Released);
        s.transport().finish();
        assert!(s.held_controls().is_empty());
    }

    #[test]
    fn half_press_is_tied_to_its_hold_and_survives_a_capture() {
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C1], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C2], &[1, 0]);
        expect_out(t, 0x9207, &[0xD2C1], &[1, 0]);
        s.half_press("hold-1").unwrap();
        s.half_press("hold-1").unwrap();
        assert!(matches!(
            s.half_press("hold-2"),
            Err(SessionError::Locked(_))
        ));
        let cancel = AtomicBool::new(false);
        s.capture(
            CaptureOptions {
                wait_for_focus: false,
            },
            &cancel,
        )
        .unwrap();
        assert_eq!(s.held_controls(), [control::S1]);
        assert!(!s.half_release(Some("hold-2")).unwrap());
        assert!(s.half_release(Some("hold-1")).unwrap());
        assert!(!s.half_release(Some("hold-1")).unwrap());
        s.transport().finish();
    }

    #[test]
    fn raw_and_jpeg_drain_with_an_unchanged_queue_value() {
        let mut s = m3(m3_descriptors());
        let jpeg = jpeg_file(3000);
        let raw = arw_file(9000);
        let t = s.transport_mut();
        t.enqueue_object(
            object_info(0x3801, "DSC00042.JPG", jpeg.len() as u32, 42),
            jpeg.clone(),
        );
        t.enqueue_object(
            object_info(0xB101, "DSC00042.ARW", raw.len() as u32, 42),
            raw.clone(),
        );
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        snapshot(t, m3_with(prop::OBJECT_IN_MEMORY, PropValue::U16(0)));
        let mut files = Vec::new();
        loop {
            match s.drain_one(|_, _| Ok(Vec::new())).unwrap() {
                DrainStep::Object(obj, bytes) => files.push((obj, bytes)),
                DrainStep::Empty => break,
                other => panic!("unexpected {other:?}"),
            }
        }
        s.transport().finish();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0.kind, FileKind::Jpeg);
        assert_eq!(files[0].1, jpeg);
        assert_eq!(files[1].0.kind, FileKind::Raw);
        assert_eq!(files[1].1, raw);
        assert_eq!(
            files[0].0.info.sequence_number,
            files[1].0.info.sequence_number
        );
        // Each object was read once and only through the capture pseudo-handle.
        let reads: Vec<_> = opcodes(&s).into_iter().filter(|x| x.0 == 0x1009).collect();
        assert_eq!(reads.len(), 2);
        assert!(reads.iter().all(|x| x.1 == [0xFFFF_C001]));
    }

    #[test]
    fn invalid_handle_ends_the_read_and_a_fresh_event_wakes_it() {
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo);
        snapshot(t, m3_with(prop::OBJECT_IN_MEMORY, PropValue::U16(0)));
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        assert!(matches!(step, DrainStep::Empty));
        s.transport().finish();

        // A C201 counts as readiness even while D215 still reads pending.
        let mut s = m3(with_current(
            m3_descriptors(),
            prop::OBJECT_IN_MEMORY,
            PropValue::U16(1),
        ));
        let jpeg = jpeg_file(500);
        let generation = s.transport().generation();
        let t = s.transport_mut();
        t.enqueue_object(object_info(0x3801, "DSC1.JPG", 500, 1), jpeg.clone());
        t.schedule(
            Duration::ZERO,
            TransportEvent::Ptp {
                generation,
                code: 0xC201,
                params: vec![0xFFFF_C001],
            },
        );
        // A stale generation's event is ignored.
        t.schedule(
            Duration::ZERO,
            TransportEvent::Removed {
                generation: generation + 7,
            },
        );
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        assert!(matches!(step, DrainStep::Object(o, b) if o.kind == FileKind::Jpeg && b == jpeg));
        assert_eq!(s.state(), ConnectionState::Ready);
        s.transport().finish();
    }

    #[test]
    fn bare_msb_waits_then_reports_a_stall() {
        let mut s = m3(with_current(
            m3_descriptors(),
            prop::OBJECT_IN_MEMORY,
            PropValue::U16(0x8000),
        ));
        s.config.stall_after = Duration::from_millis(200);
        let bare = m3_with(prop::OBJECT_IN_MEMORY, PropValue::U16(0x8000));
        let t = s.transport_mut();
        for _ in 0..3 {
            snapshot(t, bare.clone());
        }
        assert!(matches!(
            s.drain_one(|_, _| Ok(Vec::new())).unwrap(),
            DrainStep::Pending
        ));
        s.transport_mut().sleep(Duration::from_millis(150));
        assert!(matches!(
            s.drain_one(|_, _| Ok(Vec::new())).unwrap(),
            DrainStep::Pending
        ));
        s.transport_mut().sleep(Duration::from_millis(100));
        assert!(matches!(
            s.drain_one(|_, _| Ok(Vec::new())).unwrap(),
            DrainStep::Stalled
        ));
        // Never read FFFFC001 blindly.
        assert!(!opcodes(&s).iter().any(|x| x.0 == 0x1008));
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn removal_mid_raw_keeps_partial_bytes_and_stops() {
        let mut s = m3(m3_descriptors());
        let raw = arw_file(40_000);
        let t = s.transport_mut();
        t.enqueue_object(
            object_info(0xB101, "DSC2.ARW", raw.len() as u32, 2),
            raw.clone(),
        );
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo);
        t.push(Step::CaptureObjectFails {
            bytes: 1000,
            error: TransportError::Removed,
        });
        let partial = Shared::default();
        let sink = partial.clone();
        let result = s.drain_one(move |_, kind| {
            assert_eq!(kind, FileKind::Raw);
            Ok(sink)
        });
        assert!(matches!(result, Err(SessionError::Removed { .. })));
        assert_eq!(partial.0.lock().unwrap().as_slice(), &raw[..1000]);
        assert_eq!(s.state(), ConnectionState::Removed);
        assert!(matches!(
            s.drain_one(|_, _| Ok(Vec::new())),
            Err(SessionError::Removed { .. })
        ));
        s.transport().finish();
    }

    #[test]
    fn a_lost_response_after_consumption_moves_to_the_next_object() {
        let mut s = m3(m3_descriptors());
        let first = jpeg_file(800);
        let second = arw_file(1600);
        let t = s.transport_mut();
        t.enqueue_object(object_info(0x3801, "DSC3.JPG", 800, 3), first);
        t.enqueue_object(object_info(0xB101, "DSC3.ARW", 1600, 3), second.clone());
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo);
        t.push(Step::CaptureObjectFails {
            bytes: 0,
            error: TransportError::TimedOut,
        });
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        let r = s.drain_one(|_, _| Ok(Vec::new()));
        assert!(matches!(
            r,
            Err(SessionError::Transport(TransportError::TimedOut))
        ));
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        assert!(matches!(step, DrainStep::Object(o, b) if o.kind == FileKind::Raw && b == second));
        s.transport().finish();
    }

    #[test]
    fn short_objects_and_mismatched_types_are_reported() {
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        // Declares 2000 bytes, delivers 1500.
        let short = jpeg_file(1500);
        t.enqueue_object(object_info(0x3801, "DSC4.JPG", 2000, 4), short.clone());
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo);
        t.expect(
            0x1009,
            &[0xFFFF_C001],
            ExpectedPhase::In(short.clone()),
            Ok(Reply::ok(1500)),
        );
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        // The bytes that did arrive are handed back with the shortfall, never dropped.
        assert!(matches!(
            step,
            DrainStep::Short { object, sink, expected: 2000 }
                if object.bytes == 1500 && sink == short
        ));

        // An object larger than its ObjectInfo declared is staged whole, not refused.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        let long = jpeg_file(2600);
        t.enqueue_object(object_info(0x3801, "DSC6.JPG", 2000, 6), long.clone());
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        assert!(matches!(
            step,
            DrainStep::Short { object, sink, expected: 2000 }
                if object.bytes == 2600 && sink == long
        ));

        // An ARW-labelled object carrying JPEG bytes is not a RAW.
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        let jpeg = jpeg_file(600);
        t.enqueue_object(object_info(0xB101, "DSC5.ARW", 600, 5), jpeg);
        snapshot(t, m3_snapshot_payload());
        t.push(Step::CaptureInfo).push(Step::CaptureObject);
        let step = s.drain_one(|_, _| Ok(Vec::new())).unwrap();
        assert!(matches!(step, DrainStep::Object(o, _) if o.kind == FileKind::Unknown));
    }

    #[test]
    fn busy_reads_back_off_and_a_closed_session_is_reported() {
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        let payload = m3_snapshot_payload();
        for _ in 0..2 {
            t.expect(
                0x9209,
                &[],
                ExpectedPhase::In(vec![]),
                Ok(Reply::code(resp::DEVICE_BUSY)),
            );
        }
        snapshot(t, payload);
        let before = s.transport().elapsed();
        s.refresh_properties().unwrap();
        assert_eq!(s.transport().elapsed() - before, Duration::from_millis(150));
        s.transport().finish();

        // SessionNotOpen is handed to the owner; the session never reopens a body by itself.
        let t = s.transport_mut();
        t.expect(
            0x9209,
            &[],
            ExpectedPhase::In(vec![]),
            Ok(Reply::code(resp::SESSION_NOT_OPEN)),
        );
        assert!(matches!(
            s.refresh_properties(),
            Err(SessionError::SessionLost)
        ));
        assert_eq!(s.state(), ConnectionState::Lost);
        s.transport().finish();
    }

    #[test]
    fn a_malformed_snapshot_preserves_the_last_good_state() {
        let mut s = m3(m3_descriptors());
        let rev = s.prop_rev();
        let mut bad = m3_with(prop::ISO, PropValue::U32(800));
        bad.truncate(bad.len() - 3);
        snapshot(s.transport_mut(), bad.clone());
        assert!(matches!(
            s.refresh_properties(),
            Err(SessionError::Protocol(_))
        ));
        assert_eq!(
            s.property(prop::ISO).unwrap().current,
            PropValue::U32(0x00FF_FFFF)
        );
        assert_eq!(s.prop_rev(), rev);
        assert_eq!(s.rejected_snapshot(), Some(&bad[..]));
        snapshot(s.transport_mut(), m3_with(prop::ISO, PropValue::U32(800)));
        assert_eq!(s.refresh_properties().unwrap(), vec![prop::ISO]);
        assert!(s.rev_of(prop::ISO) > rev);
    }

    #[test]
    fn absolute_writes_check_revision_choices_and_readback() {
        let mut s = cm2(cm2_descriptors());
        let rev = s.rev_of(prop::WHITE_BALANCE);
        assert!(matches!(
            s.set_property(prop::WHITE_BALANCE, "0004", Some(rev + 1)),
            Err(SessionError::StaleRevision { current }) if current == rev
        ));
        assert!(matches!(
            s.set_property(prop::WHITE_BALANCE, "0006", Some(rev)),
            Err(SessionError::InvalidValue(_))
        ));
        let t = s.transport_mut();
        expect_out(t, 0x9205, &[0x5005], &[0x04, 0x00]);
        snapshot(t, cm2_with(prop::WHITE_BALANCE, PropValue::U16(4)));
        let changed = s
            .set_property(prop::WHITE_BALANCE, "0004", Some(rev))
            .unwrap();
        assert_eq!(changed, vec![prop::WHITE_BALANCE]);
        // v3 ISO is a direct u32 write.
        let t = s.transport_mut();
        expect_out(t, 0x9205, &[0xD21E], &400u32.to_le_bytes());
        snapshot(t, cm2_with(prop::ISO, PropValue::U32(800)));
        assert!(matches!(
            s.set_property(prop::ISO, "00000190", None),
            Err(SessionError::NotApplied(_))
        ));
        // Camera-owned settings refuse writes with a reason.
        assert!(matches!(
            s.set_property(prop::SAVE_DESTINATION, "0001", None),
            Err(SessionError::Locked(m)) if m.contains("Remote Shoot Setting")
        ));
        s.transport().finish();
    }

    #[test]
    fn range_writes_take_decimal_values() {
        let mut descs = m3_descriptors();
        let kelvin = descs
            .iter_mut()
            .find(|d| d.code == prop::COLOR_TEMPERATURE)
            .unwrap();
        kelvin.is_enabled = 1;
        kelvin.current = PropValue::U16(5000);
        let mut s = m3(descs.clone());
        let panel = s.camera_properties();
        let wb = panel
            .iter()
            .find(|p| p.code == prop::COLOR_TEMPERATURE)
            .unwrap();
        assert_eq!((wb.kind, wb.number), (PropertyKind::Range, Some(5000)));
        assert!(panel
            .iter()
            .all(|p| p.kind == PropertyKind::Range || p.number.is_none()));
        // A hex ID or an off-step value is not a temperature.
        for bad in ["15E0", "5650", "12000", "warm"] {
            assert!(
                matches!(
                    s.set_property(prop::COLOR_TEMPERATURE, bad, None),
                    Err(SessionError::InvalidValue(_))
                ),
                "{bad}"
            );
        }
        assert!(s.transport().sent.is_empty());
        let t = s.transport_mut();
        expect_out(t, 0x9205, &[0xD20F], &[0xE0, 0x15]);
        let applied = with_current(descs, prop::COLOR_TEMPERATURE, PropValue::U16(5600));
        snapshot(t, codec::encode_snapshot(&applied, Grammar::SingleList));
        assert_eq!(
            s.set_property(prop::COLOR_TEMPERATURE, "5600", None)
                .unwrap(),
            vec![prop::COLOR_TEMPERATURE]
        );
        s.transport().finish();
        let wb = s
            .camera_properties()
            .into_iter()
            .find(|p| p.code == prop::COLOR_TEMPERATURE)
            .unwrap();
        assert_eq!(wb.number, Some(5600));
    }

    #[test]
    fn host_roles_are_what_the_pc_setting_lets_through_of_what_is_recorded() {
        use HostRole::{Jpeg, Raw};
        let roles = |pc: Option<u8>, recorded: u8| {
            let mut descs = with_current(
                cm2_descriptors(),
                prop::FILE_FORMAT,
                PropValue::U8(recorded),
            );
            if let Some(pc) = pc {
                descs.push(DevicePropDesc {
                    code: prop::PC_SAVE_FORMAT,
                    data_type: 0x0002,
                    get_set: 0,
                    is_enabled: 1,
                    default: PropValue::U8(0),
                    current: PropValue::U8(pc),
                    form: Form::Enum {
                        writable: vec![],
                        reportable: (0..=5).map(PropValue::U8).collect(),
                    },
                });
            }
            cm2(descs).expected_host_roles()
        };
        assert_eq!(roles(None, 2), Some(vec![Raw, Jpeg]));
        // Disabled delivery restriction falls through to the recorded format.
        assert_eq!(roles(Some(0), 2), Some(vec![Raw, Jpeg]));
        assert_eq!(roles(Some(0), 3), Some(vec![Jpeg]));
        assert_eq!(roles(Some(2), 2), Some(vec![Jpeg]));
        assert_eq!(roles(Some(3), 2), Some(vec![Raw]));
        // RAW&JPEG to the PC while recording JPEG only delivers the JPEG.
        assert_eq!(roles(Some(1), 3), Some(vec![Jpeg]));
        assert_eq!(roles(Some(4), 1), Some(vec![Raw]));
        assert_eq!(roles(Some(3), 3), None);
        assert_eq!(roles(Some(5), 2), None);
    }

    #[test]
    fn capture_boundary_refreshes_camera_memory_even_without_an_object_event() {
        let mut s = m3(m3_descriptors());
        for (signal, pending) in [(0, false), (1, true), (0x8001, true), (0x8000, true)] {
            snapshot(
                s.transport_mut(),
                m3_with(prop::OBJECT_IN_MEMORY, PropValue::U16(signal)),
            );
            assert_eq!(s.refresh_capture_pending().unwrap(), pending);
        }
        s.transport().finish();
    }

    #[test]
    fn alpha7iii_writes_writable_flash_settings_absolutely() {
        let mut s = m3(m3_descriptors());
        let flash = s
            .camera_properties()
            .into_iter()
            .find(|p| p.key == "flashMode")
            .unwrap();
        assert_eq!(flash.display, "Off");
        assert!(flash
            .choices
            .iter()
            .any(|c| c.id == "8ABC" && c.label == "0x8ABC"));
        let t = s.transport_mut();
        expect_out(t, 0x9205, &[0x500C], &[0x03, 0x80]);
        let changed = with_current(m3_descriptors(), prop::FLASH_MODE, PropValue::U16(0x8003));
        snapshot(t, codec::encode_snapshot(&changed, Grammar::SingleList));
        expect_out(t, 0x9205, &[0xD200], &[0xD4, 0xFE]);
        let changed = with_current(changed, prop::FLASH_COMPENSATION, PropValue::I16(-300));
        snapshot(t, codec::encode_snapshot(&changed, Grammar::SingleList));
        s.set_property(prop::FLASH_MODE, "8003", None).unwrap();
        s.set_property(prop::FLASH_COMPENSATION, "FED4", None)
            .unwrap();
        let props = s.camera_properties();
        assert_eq!(
            props.iter().find(|p| p.key == "flashMode").unwrap().display,
            "Rear sync"
        );
        assert_eq!(
            props.iter().find(|p| p.key == "flashComp").unwrap().display,
            "-0.3 EV"
        );
        s.transport().finish();
        let mut locked = m3_descriptors();
        locked
            .iter_mut()
            .find(|p| p.code == prop::FLASH_COMPENSATION)
            .unwrap()
            .get_set = 0;
        let mut s = m3(locked);
        assert!(matches!(
            s.set_property(prop::FLASH_COMPENSATION, "FED4", None),
            Err(SessionError::Locked(_))
        ));
        s.transport().finish();
    }

    #[test]
    fn fel_pulses_refresh_the_lock_and_release_on_error_or_cancellation() {
        let mut s = m3(m3_descriptors());
        assert!(s.actions().iter().any(|a| a.key == "fel" && a.available));
        let cancel = Arc::new(AtomicBool::new(false));
        let before = s.transport().now();
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C9], &[2, 0]);
        expect_out(t, 0x9207, &[0xD2C9], &[1, 0]);
        snapshot(t, m3_with(prop::FEL_STATE, PropValue::U8(2)));
        s.pulse_fel(&cancel).unwrap();
        assert_eq!(s.transport().now() - before, s.config.press_hold);
        let lock = s
            .camera_properties()
            .into_iter()
            .find(|p| p.key == "felState")
            .unwrap();
        assert_eq!(
            (lock.access, lock.display.as_str()),
            (Access::ReadOnly, "Locked")
        );
        let t = s.transport_mut();
        t.expect(
            0x9207,
            &[0xD2C9],
            ExpectedPhase::Out(vec![2, 0]),
            Err(TransportError::TimedOut),
        );
        expect_out(t, 0x9207, &[0xD2C9], &[1, 0]);
        assert!(matches!(
            s.pulse_fel(&cancel),
            Err(SessionError::Transport(TransportError::TimedOut))
        ));
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2C9], &[2, 0]);
        t.then_signal(cancel.clone());
        expect_out(t, 0x9207, &[0xD2C9], &[1, 0]);
        assert!(matches!(s.pulse_fel(&cancel), Err(SessionError::Cancelled)));
        assert!(s.held_controls().is_empty());
        s.transport().finish();
        let mut unsupported = cm2(cm2_descriptors());
        assert!(!unsupported
            .actions()
            .iter()
            .any(|a| a.key == "fel" && a.available));
        assert!(matches!(
            unsupported.pulse_fel(&AtomicBool::new(false)),
            Err(SessionError::Unsupported(_))
        ));
        unsupported.transport().finish();
    }

    #[test]
    fn alpha7iii_exposure_moves_by_notches_and_learns_direction() {
        let mut s = m3(with_current(
            m3_descriptors(),
            prop::ISO,
            PropValue::U32(100),
        ));
        let t = s.transport_mut();
        // 100 → 800 is three choices up; the first notch moves the other way.
        expect_out(t, 0x9207, &[0xD21E], &[0x01, 0x00]);
        snapshot(t, m3_with(prop::ISO, PropValue::U32(0x00FF_FFFF)));
        for iso in [100, 200, 400, 800] {
            expect_out(t, 0x9207, &[0xD21E], &[0xFF, 0x00]);
            snapshot(t, m3_with(prop::ISO, PropValue::U32(iso)));
        }
        s.set_property(prop::ISO, "00000320", None).unwrap();
        s.transport().finish();
        assert_eq!(s.property(prop::ISO).unwrap().current, PropValue::U32(800));

        // A nominal aperture range takes single steps.
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0x5007], &[0x01, 0x00]);
        snapshot(t, m3_with(prop::F_NUMBER, PropValue::U16(0x0384)));
        s.set_property(prop::F_NUMBER, "+1", None).unwrap();
        assert!(matches!(
            s.set_property(prop::F_NUMBER, "0384", None),
            Err(SessionError::InvalidValue(_))
        ));
        s.transport().finish();

        // Relative controls take inc/dec and signed multi-steps, one detent per readback.
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0x5007], &[0xFF, 0x00]);
        snapshot(t, m3_snapshot_payload());
        for aperture in [900, 1000] {
            expect_out(t, 0x9207, &[0x5007], &[0x01, 0x00]);
            snapshot(t, m3_with(prop::F_NUMBER, PropValue::U16(aperture)));
        }
        expect_out(t, 0x9207, &[0x5007], &[0x01, 0x00]);
        snapshot(t, m3_with(prop::F_NUMBER, PropValue::U16(1000)));
        s.set_property(prop::F_NUMBER, "dec", None).unwrap();
        s.set_property(prop::F_NUMBER, "+2", None).unwrap();
        assert!(matches!(
            s.set_property(prop::F_NUMBER, "inc", None),
            Err(SessionError::NotApplied(_))
        ));
        s.transport().finish();
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0x5007], &[0xFF, 0x00]);
        snapshot(t, m3_with(prop::F_NUMBER, PropValue::U16(1100)));
        assert!(matches!(
            s.set_property(prop::F_NUMBER, "dec", None),
            Err(SessionError::NotApplied(_))
        ));
        s.transport().finish();
        let sent = s.transport().sent.len();
        for bad in ["0", "+0", "+17", "-99", "up", "1.5"] {
            assert!(
                matches!(
                    s.set_property(prop::F_NUMBER, bad, None),
                    Err(SessionError::InvalidValue(_))
                ),
                "{bad}"
            );
        }
        assert_eq!(s.transport().sent.len(), sent);

        // No movement twice: report instead of looping.
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0x5010], &[0x01, 0x00]);
        snapshot(t, m3_snapshot_payload());
        expect_out(t, 0x9207, &[0x5010], &[0x01, 0x00]);
        snapshot(t, m3_snapshot_payload());
        assert!(matches!(
            s.set_property(prop::EXPOSURE_BIAS, "012C", None),
            Err(SessionError::NotApplied(_))
        ));
        s.transport().finish();
    }

    #[test]
    fn focus_steps_are_gated_and_signed() {
        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        expect_out(t, 0x9207, &[0xD2D1], &[0xFE, 0xFF]);
        expect_out(t, 0x9207, &[0xD2D1], &[0x03, 0x00]);
        s.focus_step(true, 2).unwrap();
        s.focus_step(false, 3).unwrap();
        s.transport().finish();

        let mut s = m3(with_current(
            m3_descriptors(),
            prop::NEAR_FAR_ENABLE,
            PropValue::U8(0),
        ));
        assert!(matches!(
            s.focus_step(true, 1),
            Err(SessionError::Locked(_))
        ));
        assert!(s
            .actions()
            .iter()
            .any(|a| a.key == "focusNear1" && !a.available));
        assert!(matches!(
            s.set_af_position(10, 10),
            Err(SessionError::Unsupported(_))
        ));
    }

    #[test]
    fn live_view_extracts_frames_for_both_layouts() {
        let jpeg = synthetic_jpeg(1024, 680, true);
        for (mut s, layout) in [
            (m3(m3_descriptors()), LiveLayout::Sdi200),
            (cm2(cm2_descriptors()), LiveLayout::Sdi300),
        ] {
            let payload = live_view_payload(&jpeg, layout, b"focal");
            let snapshot_bytes = if layout == LiveLayout::Sdi200 {
                m3_snapshot_payload()
            } else {
                cm2_snapshot_payload()
            };
            let t = s.transport_mut();
            snapshot(t, snapshot_bytes);
            t.expect(
                0x1008,
                &[0xFFFF_C002],
                ExpectedPhase::In(vec![]),
                Ok(Reply::code(resp::ACCESS_DENIED)),
            );
            expect_in(
                t,
                0x1008,
                &[0xFFFF_C002],
                object_info(0x3801, "", 1 << 20, 0),
            );
            t.expect(
                0x1009,
                &[0xFFFF_C002],
                ExpectedPhase::In(vec![]),
                Ok(Reply::code(resp::ACCESS_DENIED)),
            );
            expect_in(t, 0x1009, &[0xFFFF_C002], payload.clone());
            expect_in(t, 0x1009, &[0xFFFF_C002], payload);
            s.start_live_view().unwrap();
            for _ in 0..2 {
                let frame = s.fetch_live_frame().unwrap().unwrap();
                assert_eq!(frame.jpeg, jpeg);
                assert_eq!((frame.width, frame.height), (1024, 680));
            }
            // GetObjectInfo was sent once for the whole stream.
            assert_eq!(opcodes(&s).iter().filter(|x| x.0 == 0x1008).count(), 2);
            s.transport().finish();
            s.stop_live_view();
            assert!(matches!(
                s.fetch_live_frame(),
                Err(SessionError::LiveViewUnavailable(_))
            ));
        }
    }

    #[test]
    fn live_view_requires_status_and_handles_invalid_handles() {
        let mut s = m3(m3_descriptors());
        snapshot(
            s.transport_mut(),
            m3_with(prop::LIVE_VIEW_STATUS, PropValue::U8(2)),
        );
        assert!(matches!(
            s.start_live_view(),
            Err(SessionError::LiveViewUnavailable(_))
        ));

        let mut s = m3(m3_descriptors());
        let t = s.transport_mut();
        snapshot(t, m3_snapshot_payload());
        expect_in(
            t,
            0x1008,
            &[0xFFFF_C002],
            object_info(0x3801, "", 1 << 20, 0),
        );
        t.expect(
            0x1009,
            &[0xFFFF_C002],
            ExpectedPhase::In(vec![]),
            Ok(Reply::code(resp::INVALID_OBJECT_HANDLE)),
        );
        snapshot(t, m3_with(prop::LIVE_VIEW_STATUS, PropValue::U8(0)));
        s.start_live_view().unwrap();
        assert!(matches!(
            s.fetch_live_frame(),
            Err(SessionError::LiveViewUnavailable(_))
        ));
        assert!(!s.is_live());
        s.transport().finish();

        // A frame that is not ready yet, then a malformed one.
        let mut s = cm2(cm2_descriptors());
        let t = s.transport_mut();
        snapshot(t, cm2_snapshot_payload());
        expect_in(
            t,
            0x1008,
            &[0xFFFF_C002],
            object_info(0x3801, "", 1 << 20, 0),
        );
        let mut empty = vec![0u8; 16];
        empty[0] = 16;
        expect_in(t, 0x1009, &[0xFFFF_C002], empty);
        let mut broken = live_view_payload(&synthetic_jpeg(64, 48, false), LiveLayout::Sdi300, b"");
        let n = broken.len();
        broken[n - 1] = 0;
        expect_in(t, 0x1009, &[0xFFFF_C002], broken);
        s.start_live_view().unwrap();
        assert_eq!(s.fetch_live_frame().unwrap(), None);
        assert!(matches!(
            s.fetch_live_frame(),
            Err(SessionError::Protocol(_))
        ));
        s.transport().finish();
    }

    #[test]
    fn events_mark_state_and_removal_retires_the_session() {
        let mut s = m3(m3_descriptors());
        let generation = s.transport().generation();
        let t = s.transport_mut();
        t.schedule(
            Duration::ZERO,
            TransportEvent::Ptp {
                generation,
                code: 0xC203,
                params: vec![0x5004],
            },
        );
        t.schedule(
            Duration::ZERO,
            TransportEvent::Ptp {
                generation,
                code: 0xC201,
                params: vec![0xFFFF_C001],
            },
        );
        t.schedule(
            Duration::ZERO,
            TransportEvent::Ptp {
                generation,
                code: 0xC202,
                params: vec![0xFFFF_C001],
            },
        );
        t.schedule(
            Duration::from_millis(10),
            TransportEvent::Removed { generation },
        );
        let events = s.process_events();
        assert_eq!(
            events,
            vec![SessionEvent::PropertiesDirty, SessionEvent::ObjectAdded]
        );
        assert!(s.properties_dirty());
        assert!(!s.object_announced());

        // Object events for any other handle only ask for a fresh reading; a C202 for another
        // handle leaves an announced capture in place.
        let deliver = |s: &mut SonySession<ScriptedTransport>, events: &[(u16, u32)]| {
            for &(code, handle) in events {
                s.transport_mut().schedule(
                    Duration::ZERO,
                    TransportEvent::Ptp {
                        generation,
                        code,
                        params: vec![handle],
                    },
                );
            }
            s.process_events()
        };
        let other = deliver(&mut s, &[(0xC201, 0xFFFF_C002), (0x4002, 0xFFFF_C001)]);
        assert_eq!(other, vec![SessionEvent::PropertiesDirty]);
        assert!(!s.object_announced());
        let kept = deliver(&mut s, &[(0xC201, 0xFFFF_C001), (0xC202, 0x0000_0001)]);
        assert_eq!(
            kept,
            vec![SessionEvent::ObjectAdded, SessionEvent::PropertiesDirty]
        );
        assert!(s.object_announced());

        s.transport_mut().sleep(Duration::from_millis(10));
        assert_eq!(s.process_events(), vec![SessionEvent::Removed]);
        assert_eq!(s.state(), ConnectionState::Removed);
        let cancel = AtomicBool::new(false);
        assert!(s
            .capture(
                CaptureOptions {
                    wait_for_focus: false
                },
                &cancel
            )
            .is_err());
        assert!(s.transport().sent.is_empty());
    }

    #[test]
    fn scalar_reads_typed_values() {
        assert_eq!(scalar(&PropValue::I16(-7)), Some(-7));
        assert_eq!(scalar(&PropValue::Str("x".into())), None);
    }
}
