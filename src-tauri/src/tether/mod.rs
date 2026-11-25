//! Tethered capture: the camera actor, staging and exclusive publication, Live View and the
//! Tauri commands. Node owns the ledger, naming and Library ingest; Rust receives write plans
//! only through the private `tether-*` backend methods.

pub mod icc;
pub mod live;
pub mod protocol;
pub mod transfer;
pub mod wifi;

use crate::backend::{Backend, Failure};
use icc::{IccBrowser, IccDevice, IccTransport};
use live::{LiveError, LiveViewHub, POLL_TIMEOUT};
use protocol::codec::QueueSignal;
use protocol::ptp::{FileKind, ObjectInfo};
use protocol::ptpip::{PtpIpAbort, PtpIpConfig, PtpIpTransport, PTPIP_PORT};
use protocol::session::{
    ActionCap, CameraProperty, CaptureOptions, CaptureOutcome, ConnectionState, DrainStep,
    ExposureSnapshot, HostRole, PropertyKind, SessionConfig, SessionError, SessionEvent,
    SonySession,
};
use protocol::transport::{
    DataPhase, Operation, PtpTransport, Reply as PtpReply, TransportError, TransportEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use transfer::{StageReceipt, StageWriter, TransferError};
use wifi::{AttachedWifiRoute, WifiAuth, WifiCandidate, WifiState, WIFI_PREFIX};

const MAX_OUTSTANDING: usize = 32;
const RECONNECT_STEPS: [u64; 6] = [1, 2, 4, 8, 16, 30];
const HALF_PRESS_LIMIT: Duration = Duration::from_secs(15);
const REVIEW_LIMIT: usize = 64 << 20;
const COMPOSITION_DIR: &str = ".photocull-tether/composition";
const RAW_PREVIEW_SCAN: usize = 32 << 20;
const EMBEDDED_JPEG_LIMIT: usize = 16 << 20;
const PREVIEW_PIXELS: u64 = 64_000_000;
const SHUTTER_WAIT: Duration = Duration::from_secs(15);
const OVERLAY_INPUT_LIMIT: usize = 32 << 20;
const OVERLAY_SOURCE_PIXELS: u64 = 32_000_000;
const OVERLAY_EDGE: u32 = 4096;
const DEFAULT_OBJECT_BUDGET: u64 = 128 << 20;
/// Largest single object taken from the camera, whatever its ObjectInfo declared.
const MAX_CAPTURE_BYTES: u64 = 512 << 20;
/// Photos the camera handed over but the disk refused, kept in memory until a retry stores them.
const RECOVERY_BYTES: usize = 1 << 30;
const RECOVERY_COUNT: usize = 16;
/// How long a released shutter may wait for its photo before it no longer claims the next one.
const REQUEST_TTL: Duration = Duration::from_secs(60);
/// A first Wi-Fi pairing waits for approval on the camera body.
const WIFI_PAIRING_TIMEOUT: Duration = Duration::from_secs(60);
const WIFI_REOPEN_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_START_TIMEOUT: Duration = Duration::from_secs(25);
const INITIATOR_NAME: &str = "PhotoCull";
/// Wi-Fi attachment generations start far above ImageCaptureCore's, in blocks per transport.
static WIFI_GENERATIONS: AtomicU64 = AtomicU64::new(1 << 62);

const CODES: [&str; 14] = [
    "STALE_SESSION",
    "STALE_REV",
    "CAMERA_LOST",
    "CAMERA_BUSY",
    "CONTROL_LOCKED",
    "UNSUPPORTED",
    "NO_SPACE",
    "DEST_CHANGED",
    "NAME_INVALID",
    "NAME_TAKEN",
    "INCOMPLETE",
    "STREAM_CLOSED",
    "IO_ERROR",
    "INVALID_FORMAT",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TetherError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_rev: Option<u64>,
    /// The camera's SSH host-key fingerprint the photographer must compare and confirm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// Node already recorded this failure in the shoot journal.
    #[serde(skip)]
    pub journaled: bool,
    /// The shutter may or may not have fired.
    #[serde(skip)]
    pub uncertain: bool,
}

impl TetherError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        TetherError {
            code: code.to_string(),
            message: message.into(),
            retryable: matches!(
                code,
                "STALE_REV" | "CAMERA_BUSY" | "CAMERA_LOST" | "NO_SPACE" | "IO_ERROR"
            ),
            field: None,
            current_rev: None,
            fingerprint: None,
            journaled: false,
            uncertain: false,
        }
    }

    fn retryable(mut self, value: bool) -> Self {
        self.retryable = value;
        self
    }

    fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }

    fn stale_session() -> Self {
        TetherError::new(
            "STALE_SESSION",
            "The tethered shoot changed. Refresh and try again.",
        )
    }

    fn from_backend(failure: Failure) -> Self {
        let Some(detail) = failure.detail.as_ref().filter(|d| d.is_object()) else {
            return TetherError::new("IO_ERROR", failure.message);
        };
        let code = detail["code"]
            .as_str()
            .filter(|c| CODES.contains(c))
            .unwrap_or("IO_ERROR");
        let mut e = TetherError::new(code, detail["message"].as_str().unwrap_or(&failure.message));
        if let Some(r) = detail["retryable"].as_bool() {
            e.retryable = r;
        }
        e.field = detail["field"].as_str().map(String::from);
        e.current_rev = detail["currentRev"].as_u64();
        // Node attaches recovery actions only when it has put the member on hold.
        e.journaled = detail["actions"].as_array().is_some();
        e
    }

    fn from_transfer(e: TransferError) -> Self {
        match e {
            TransferError::Name(m) => TetherError::new("NAME_INVALID", m),
            TransferError::Taken(p) => TetherError::new(
                "NAME_TAKEN",
                format!(
                    "{} already exists.",
                    p.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "The file".into())
                ),
            ),
            TransferError::Destination(m) => TetherError::new("DEST_CHANGED", m),
            TransferError::Limit(_) => TetherError::new(
                "INCOMPLETE",
                "The camera sent more data than the photo declared.",
            ),
            TransferError::NoSpace => TetherError::new(
                "NO_SPACE",
                "The capture disk is full. Free space or choose another folder.",
            ),
            TransferError::Io(e) => TetherError::new("IO_ERROR", e.to_string()),
            TransferError::Signature(m) => TetherError::new("INVALID_FORMAT", m),
            TransferError::Changed(m) => TetherError::new("INCOMPLETE", m),
        }
    }

    fn from_session(e: SessionError) -> Self {
        use SessionError as S;
        match e {
            S::Removed { shutter_uncertain } => TetherError::new(
                "CAMERA_LOST",
                if shutter_uncertain {
                    "The camera connection failed during the shutter press; it may or may not have fired."
                } else {
                    "The camera disconnected. Reconnect the USB cable."
                },
            ),
            S::SessionLost => TetherError::new("CAMERA_LOST", "The camera session ended."),
            S::StaleRevision { current } => {
                let mut e = TetherError::new(
                    "STALE_REV",
                    "The setting changed on the camera. The panel shows its current value.",
                );
                e.current_rev = Some(current);
                e
            }
            S::Locked(m) | S::NotApplied(m) => TetherError::new("CONTROL_LOCKED", m),
            S::InvalidValue(m) => TetherError::new("STALE_REV", m),
            S::Unsupported(m) | S::LiveViewUnavailable(m) => TetherError::new("UNSUPPORTED", m),
            S::NotSonyRemote(model) => TetherError::new(
                "UNSUPPORTED",
                format!("{model} is not in PC Remote mode. Set USB Connection to PC Remote and reconnect."),
            )
            .retryable(true),
            S::Negotiation(m) => TetherError::new("UNSUPPORTED", m).retryable(true),
            S::Cancelled => TetherError::new("CONTROL_LOCKED", "Cancelled."),
            S::Incomplete { .. } | S::QueueFault(_) => {
                TetherError::new("INCOMPLETE", e_text(&e)).retryable(true)
            }
            S::Response { code: 0x2019, .. } => {
                TetherError::new("CAMERA_BUSY", "The camera is busy. Try again.")
            }
            S::Response { code: 0x200F, .. } => TetherError::new(
                "CONTROL_LOCKED",
                "The camera refused the command in its current state.",
            ),
            S::Transport(TransportError::TimedOut) => {
                TetherError::new("CAMERA_BUSY", "The camera did not answer in time.")
            }
            S::Transport(TransportError::InUse) => TetherError::new(
                "CAMERA_BUSY",
                "Another application is using the camera. Close other tether or import apps.",
            ),
            S::Transport(TransportError::Sink(e)) if transfer::is_no_space(&e) => {
                TetherError::from_transfer(TransferError::NoSpace)
            }
            S::Transport(TransportError::Permission) => TetherError::new(
                "UNSUPPORTED",
                "PhotoCull is not allowed to control the camera. Allow camera access in System Settings → Privacy & Security.",
            )
            .retryable(true),
            other => TetherError::new("IO_ERROR", e_text(&other)),
        }
    }

    fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn e_text(e: &dyn std::fmt::Display) -> String {
    let text = e.to_string();
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect::<String>() + ".",
        None => "The camera reported an error.".into(),
    }
}

type TResult<T> = Result<T, TetherError>;

fn envelope(result: TResult<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error.to_value() }),
    }
}

fn valid_id(value: &str, field: &str) -> TResult<()> {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(TetherError::new("UNSUPPORTED", format!("Invalid {field}.")).field(field))
    }
}

#[derive(Debug, Clone)]
pub struct Binding {
    pub shoot_id: String,
    pub session: String,
    pub root: PathBuf,
    pub library_root: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct DeviceDesc {
    device_id: String,
    model: String,
    firmware: String,
    serial: String,
    wifi: bool,
    /// How a Wi-Fi camera was reached and which body answered.
    route: Option<AttachedWifiRoute>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkState {
    Offline,
    Connecting,
    Ready,
    Paused,
    Lost,
    Reconnecting,
    Draining,
}

impl LinkState {
    fn as_str(self) -> &'static str {
        match self {
            LinkState::Offline => "offline",
            LinkState::Connecting => "connecting",
            LinkState::Ready => "ready",
            LinkState::Paused => "paused",
            LinkState::Lost => "lost",
            LinkState::Reconnecting => "reconnecting",
            LinkState::Draining => "draining",
        }
    }
}

struct Inner {
    app: AppHandle,
    data_dir: PathBuf,
    browser: IccBrowser,
    live: LiveViewHub,
    binding: Mutex<Option<Binding>>,
    actor: Mutex<Option<ActorHandle>>,
    /// Unique to this launch: epochs restart with every launch, so they alone never tell an undated
    /// photo of this launch from one journaled by an earlier launch.
    cohort: String,
    epoch: AtomicU64,
    state: Mutex<(LinkState, Option<String>)>,
    publish_lock: tokio::sync::Mutex<()>,
    shoot_lock: tokio::sync::Mutex<()>,
    composition_mode: AtomicBool,
    composition_seq: AtomicU64,
    composition_shot: Mutex<Option<CompositionShot>>,
    outstanding: AtomicUsize,
    receiving: AtomicUsize,
    transfer_seq: AtomicU64,
    cancel: AtomicBool,
    confirmations: Mutex<HashMap<String, oneshot::Sender<String>>>,
    /// Requests whose caller stopped waiting; they no longer claim a photo.
    timed_out: Mutex<Vec<String>>,
    recovery: Mutex<HashMap<String, Retained>>,
    /// Set after the disk refused a photo the camera handed over: no further photo leaves the
    /// camera until the photographer retries.
    drain_hold: Mutex<Option<String>>,
    wifi: Mutex<WifiState>,
    /// The connection the actor is opening, so Disconnect and Exit need not wait behind it.
    connecting: Mutex<Option<PendingConnect>>,
}

struct PendingConnect {
    cancelled: Arc<AtomicBool>,
    link: Option<PtpIpAbort>,
}

impl Inner {
    fn abort_connect(&self) {
        if let Some(pending) = self.connecting.lock().unwrap().as_ref() {
            pending.cancelled.store(true, Ordering::SeqCst);
            if let Some(link) = &pending.link {
                link.abort();
            }
        }
    }
}

/// Clears the pending connection however `connect` returns.
struct Connecting(Arc<Inner>);

impl Drop for Connecting {
    fn drop(&mut self) {
        self.0.connecting.lock().unwrap().take();
    }
}

/// The camera link behind the Sony session. An SSH tunnel outlives both PTP/IP streams, which
/// drop first.
enum CameraTransport {
    Usb(IccTransport),
    Wifi {
        transport: PtpIpTransport,
        _tunnel: Option<wifi::SshTunnel>,
    },
}

impl CameraTransport {
    fn take_orphan(&mut self) -> Option<icc::Orphan> {
        match self {
            CameraTransport::Usb(t) => t.take_orphan(),
            CameraTransport::Wifi { .. } => None,
        }
    }

    fn is_usb(&self) -> bool {
        matches!(self, CameraTransport::Usb(_))
    }

    fn responder_guid(&self) -> Option<[u8; 16]> {
        match self {
            CameraTransport::Usb(_) => None,
            CameraTransport::Wifi { transport, .. } => transport.responder_guid(),
        }
    }

    fn is_live(&self) -> bool {
        match self {
            CameraTransport::Usb(_) => true,
            CameraTransport::Wifi { transport, .. } => transport.is_live(),
        }
    }
}

impl PtpTransport for CameraTransport {
    fn open(&mut self, deadline: Instant) -> Result<(), TransportError> {
        match self {
            CameraTransport::Usb(t) => t.open(deadline),
            CameraTransport::Wifi { transport, .. } => transport.open(deadline),
        }
    }

    fn transact(
        &mut self,
        request: Operation<'_>,
        phase: DataPhase<'_>,
        deadline: Instant,
    ) -> Result<PtpReply, TransportError> {
        match self {
            CameraTransport::Usb(t) => t.transact(request, phase, deadline),
            CameraTransport::Wifi { transport, .. } => transport.transact(request, phase, deadline),
        }
    }

    fn close(&mut self, deadline: Instant) -> Result<(), TransportError> {
        match self {
            CameraTransport::Usb(t) => t.close(deadline),
            CameraTransport::Wifi { transport, .. } => transport.close(deadline),
        }
    }

    fn poll_event(&mut self) -> Option<TransportEvent> {
        match self {
            CameraTransport::Usb(t) => t.poll_event(),
            CameraTransport::Wifi { transport, .. } => transport.poll_event(),
        }
    }

    fn generation(&self) -> u64 {
        match self {
            CameraTransport::Usb(t) => t.generation(),
            CameraTransport::Wifi { transport, .. } => transport.generation(),
        }
    }

    fn wait_event(&mut self, until: Instant) -> Option<TransportEvent> {
        match self {
            CameraTransport::Usb(t) => t.wait_event(until),
            CameraTransport::Wifi { transport, .. } => transport.wait_event(until),
        }
    }
}

/// A complete camera object whose stage write failed, keyed by member ID.
struct Retained {
    shoot_id: String,
    exposure_id: String,
    plan: MemberPlan,
    payload: icc::Orphan,
    shot: Value,
    epoch: u64,
}

#[derive(Clone)]
struct CompositionMember {
    path: PathBuf,
    name: String,
    kind: FileKind,
    receipt: StageReceipt,
}

struct CompositionShot {
    shoot_id: String,
    test_seq: u64,
    epoch: u64,
    promotion_key: String,
    captured_at: String,
    members: Vec<CompositionMember>,
    expected_roles: Vec<HostRole>,
    preview_rev: u64,
    preview_jpeg: Vec<u8>,
    preview_width: u32,
    preview_height: u32,
    camera_meta: Value,
}

impl CompositionShot {
    fn pair_complete(&self) -> bool {
        self.expected_roles
            .iter()
            .all(|role| self.members.iter().any(|m| m.kind.role() == role.as_str()))
    }

    fn check_keep(&self, force_single: bool) -> TResult<()> {
        if !force_single && !self.pair_complete() {
            let message = if self.members.iter().any(|m| m.kind == FileKind::Jpeg) {
                "Waiting for the RAW companion before keeping this shot."
            } else {
                "Waiting for the JPEG companion before keeping this shot."
            };
            return Err(TetherError::new("PAIR_PENDING", message).retryable(true));
        }
        Ok(())
    }

    fn add_companion(
        &mut self,
        member: CompositionMember,
        meta: Value,
        preview: Option<ShotPreview>,
    ) {
        if let Some((jpeg, w, h)) =
            preview.filter(|_| member.kind == FileKind::Jpeg || self.preview_jpeg.is_empty())
        {
            (self.preview_jpeg, self.preview_width, self.preview_height) = (jpeg, w, h);
            self.preview_rev += 1;
        }
        for key in ["focalLength", "flash"] {
            if self.camera_meta[key].is_null() && !meta[key].is_null() {
                self.camera_meta[key] = meta[key].clone();
            }
        }
        self.members.push(member);
    }
}

fn check_test_seq(shot: Option<&CompositionShot>, seq: Option<u64>) -> TResult<()> {
    if seq.is_some() && shot.map(|s| s.test_seq) != seq {
        return Err(TetherError::new("STALE_SHOT", "A newer test shot arrived."));
    }
    Ok(())
}

// Sony gives the two files of one exposure the same sequence number.
#[derive(Clone, PartialEq, Eq)]
struct CompositionCohort {
    epoch: u64,
    sequence: u32,
    stem: String,
}

impl CompositionCohort {
    fn new(epoch: u64, info: &ObjectInfo, kind: FileKind) -> Self {
        Self {
            epoch,
            sequence: info.sequence_number,
            stem: file_stem(&object_name(info, kind)).to_uppercase(),
        }
    }
}

struct CompositionDrain {
    seq: u64,
    companion: bool,
    name: String,
    kind: FileKind,
    path: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct TestDisposition {
    new_shot: bool,
    discard: bool,
}

#[derive(Default)]
struct CaptureCohorts {
    last_regular: Option<CompositionCohort>,
    latest_test: Option<CompositionCohort>,
    recent_tests: VecDeque<CompositionCohort>,
    pending_test: Option<Instant>,
    awaiting_quiet_queue: bool,
    kept_single: VecDeque<CompositionCohort>,
}

impl CaptureCohorts {
    fn expire_test(&mut self) {
        self.pending_test = self.pending_test.filter(|at| at.elapsed() < SHUTTER_WAIT);
    }

    fn check_transition(&mut self, camera_pending: bool, shutter_pending: bool) -> TResult<()> {
        self.expire_test();
        if camera_pending || shutter_pending || self.pending_test.is_some() {
            return Err(TetherError::new(
                "CAPTURE_PENDING",
                "Waiting for the previous capture to arrive from the camera.",
            )
            .retryable(true));
        }
        Ok(())
    }

    fn test_disposition(
        &self,
        cohort: &CompositionCohort,
        active: bool,
    ) -> Option<TestDisposition> {
        let latest = self.latest_test.as_ref() == Some(cohort);
        let known_test = latest || self.recent_tests.contains(cohort);
        if self.last_regular.as_ref() == Some(cohort)
            || self.kept_single.contains(cohort)
            || ((!active || self.awaiting_quiet_queue) && !known_test)
        {
            return None;
        }
        let new_shot = !known_test;
        let discard = known_test && (!active || !latest);
        Some(TestDisposition { new_shot, discard })
    }

    fn remember_test(&mut self, cohort: CompositionCohort) {
        if self.recent_tests.len() == MAX_OUTSTANDING {
            self.recent_tests.pop_front();
        }
        self.recent_tests.push_back(cohort);
    }
}

/// Managed Tauri state for tethering. Cheap to clone.
#[derive(Clone)]
pub struct TetherManager {
    inner: Arc<Inner>,
}

/// The shoot and camera connection a command was issued for. The actor rechecks it right before
/// dispatch, so a command queued behind a reconnect never reaches a different body or session.
#[derive(Debug, Clone)]
struct Stamp {
    shoot_id: String,
    epoch: Option<u64>,
}

enum SetValue {
    Text(String),
    Number(f64),
}

enum Cmd {
    Bind(Binding, Value, Reply<Vec<Value>>),
    Connect(String, Option<ExpectedBody>, Reply<Value>),
    Snapshot(Reply<Value>),
    TransfersSettled(Reply<bool>),
    Pause(Stamp, bool, Reply<Value>),
    Refresh(Stamp, Reply<Value>),
    Reconnect(Stamp, Reply<Value>),
    Disconnect(Stamp, Reply<Value>),
    Preflight(Stamp, Reply<()>),
    Trigger(Stamp, Option<String>, Reply<CaptureOutcome>),
    Fel(Stamp, Reply<Value>),
    Composition(Stamp, CompositionOp, Reply<Value>),
    SetProperty(Stamp, String, SetValue, u64, Reply<Value>),
    Focus(Stamp, FocusOp, Reply<Value>),
    Live(Stamp, bool, Reply<Value>),
    Shutdown(mpsc::Sender<()>),
}

type Reply<T> = oneshot::Sender<TResult<T>>;

struct ActorHandle {
    tx: mpsc::Sender<Cmd>,
    done: Arc<AtomicBool>,
}

enum FocusOp {
    Press(String),
    Release(Option<String>),
    Pulse,
    Step { near: bool, size: u8 },
}

enum CompositionOp {
    On,
    Off,
    Discard(Option<u64>),
    Keep(Option<u64>, bool),
}

impl CompositionOp {
    fn selected_seq(&self, slot: Option<&CompositionShot>) -> TResult<Option<u64>> {
        if let Self::Keep(seq, _) | Self::Discard(seq) = self {
            check_test_seq(slot, *seq)?;
        }
        Ok(slot.map(|s| s.test_seq))
    }
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

async fn node(app: &AppHandle, method: &str, params: Value) -> TResult<Value> {
    let backend = app
        .try_state::<Backend>()
        .ok_or_else(|| TetherError::new("IO_ERROR", "PhotoCull's backend is not running."))?;
    backend
        .call_detail(method, params)
        .await
        .map_err(TetherError::from_backend)
}

fn node_blocking(app: &AppHandle, method: &str, params: Value) -> TResult<Value> {
    tauri::async_runtime::block_on(node(app, method, params))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> TResult<T> + Send + 'static,
) -> TResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?
}

fn str_field(value: &Value, key: &str) -> TResult<String> {
    value[key]
        .as_str()
        .map(String::from)
        .ok_or_else(|| TetherError::new("IO_ERROR", format!("The backend reply has no {key}.")))
}

impl TetherManager {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        TetherManager {
            inner: Arc::new(Inner {
                app,
                data_dir,
                browser: IccBrowser::default(),
                live: LiveViewHub::default(),
                binding: Mutex::new(None),
                actor: Mutex::new(None),
                cohort: launch_cohort(),
                epoch: AtomicU64::new(0),
                state: Mutex::new((LinkState::Offline, None)),
                publish_lock: tokio::sync::Mutex::new(()),
                shoot_lock: tokio::sync::Mutex::new(()),
                composition_mode: AtomicBool::new(false),
                composition_seq: AtomicU64::new(0),
                composition_shot: Mutex::new(None),
                outstanding: AtomicUsize::new(0),
                receiving: AtomicUsize::new(0),
                transfer_seq: AtomicU64::new(0),
                cancel: AtomicBool::new(false),
                confirmations: Mutex::new(HashMap::new()),
                timed_out: Mutex::new(Vec::new()),
                recovery: Mutex::new(HashMap::new()),
                drain_hold: Mutex::new(None),
                wifi: Mutex::new(WifiState::default()),
                connecting: Mutex::new(None),
            }),
        }
    }

    pub(crate) async fn lock_between_shoots(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self.inner.shoot_lock.lock().await;
        if self.inner.binding.lock().unwrap().is_some() {
            return None;
        }
        let has_actor = self.inner.actor.lock().unwrap().is_some();
        if has_actor && !self.ask(Cmd::TransfersSettled).await.ok()? {
            return None;
        }
        let idle = self.inner.receiving.load(Ordering::SeqCst) == 0
            && self.inner.outstanding.load(Ordering::SeqCst) == 0
            && self.inner.recovery.lock().unwrap().is_empty()
            && self.inner.publish_lock.try_lock().is_ok();
        idle.then_some(guard)
    }

    fn binding(&self) -> Option<Binding> {
        self.inner.binding.lock().unwrap().clone()
    }

    fn check(&self, shoot_id: &str, epoch: Option<u64>) -> TResult<Binding> {
        let binding = self.binding().filter(|b| b.shoot_id == shoot_id);
        let binding = binding.ok_or_else(TetherError::stale_session)?;
        if let Some(epoch) = epoch {
            if epoch != self.inner.epoch.load(Ordering::SeqCst) {
                return Err(TetherError::new(
                    "STALE_SESSION",
                    "The camera reconnected. Refresh and try again.",
                ));
            }
        }
        Ok(binding)
    }

    /// The actor's channel, starting the thread on first use or after it exited.
    fn sender(&self) -> TResult<mpsc::Sender<Cmd>> {
        let mut actor = self.inner.actor.lock().unwrap();
        if let Some(handle) = actor.as_ref() {
            if !handle.done.load(Ordering::SeqCst) {
                return Ok(handle.tx.clone());
            }
        }
        let (tx, rx) = mpsc::channel();
        let done = Arc::new(AtomicBool::new(false));
        let inner = self.inner.clone();
        let flag = done.clone();
        std::thread::Builder::new()
            .name("photocull-tether".into())
            .spawn(move || {
                Actor::new(inner, rx).run();
                flag.store(true, Ordering::SeqCst);
            })
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
        *actor = Some(ActorHandle {
            tx: tx.clone(),
            done,
        });
        Ok(tx)
    }

    async fn ask<T: Send + 'static>(&self, make: impl FnOnce(Reply<T>) -> Cmd) -> TResult<T> {
        let (tx, rx) = oneshot::channel();
        self.sender()?
            .send(make(tx))
            .map_err(|_| TetherError::new("CAMERA_LOST", "The camera worker stopped."))?;
        rx.await
            .map_err(|_| TetherError::new("CAMERA_LOST", "The camera worker stopped."))?
    }

    /// Releases held controls, closes the camera session and stops discovery. Safe on the main
    /// thread: the main run loop keeps servicing ImageCaptureCore while it waits.
    pub fn shutdown(&self) {
        self.inner.cancel.store(true, Ordering::SeqCst);
        self.inner.abort_connect();
        self.inner.live.close();
        let sender = self.inner.actor.lock().unwrap().take();
        if let Some(ActorHandle { tx, .. }) = sender {
            let (done_tx, done_rx) = mpsc::channel();
            if tx.send(Cmd::Shutdown(done_tx)).is_ok() {
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if done_rx.try_recv().is_ok() {
                        break;
                    }
                    icc::pump(0.02);
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        self.inner.browser.stop();
    }
}

/// Write target for one camera object: an owned stage file, or nothing for a repeat.
enum MemberSink {
    Stage(StageWriter),
    Discard,
}

impl Write for MemberSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            MemberSink::Stage(w) => w.write(buf),
            MemberSink::Discard => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            MemberSink::Stage(w) => w.flush(),
            MemberSink::Discard => Ok(()),
        }
    }
}

#[derive(Debug, Clone)]
struct MemberPlan {
    exposure_id: String,
    member_id: String,
    stage_rel: String,
    status: String,
    name: String,
    declared: Option<u64>,
}

fn capture_time(info: &ObjectInfo) -> Option<String> {
    let (date, time) = info.capture_date_parts()?;
    Some(format!(
        "{}:{}:{} {}:{}:{}",
        &date[0..4],
        &date[4..6],
        &date[6..8],
        &time[0..2],
        &time[2..4],
        &time[4..6]
    ))
}

fn embedded_jpeg(bytes: &[u8]) -> Option<(&[u8], u32, u32)> {
    let mut remaining = &bytes[..bytes.len().min(RAW_PREVIEW_SCAN)];
    // Malformed JPEG candidates can overlap, so bound the total bytes parsed.
    let mut budget = remaining.len().saturating_mul(2);
    let mut best: Option<(&[u8], u32, u32)> = None;
    while budget > 0 {
        let Some(start) = remaining.windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]) else {
            break;
        };
        let candidate = &remaining[start..];
        let limit = candidate.len().min(EMBEDDED_JPEG_LIMIT);
        if let Ok((w, h, end)) =
            protocol::codec::jpeg_scan_bounded(&candidate[..limit], &mut budget)
        {
            let (w, h) = (u32::from(w), u32::from(h));
            if u64::from(w) * u64::from(h) <= PREVIEW_PIXELS
                && best.is_none_or(|(old, ow, oh)| (w * h, end) > (ow * oh, old.len()))
            {
                best = Some((&candidate[..end], w, h));
            }
        }
        remaining = &candidate[2..];
    }
    best
}

// TIFF's JPEGInterchangeFormat and JPEGInterchangeFormatLength are relative to the TIFF header.
fn tiff_preview_range(header: &[u8]) -> Option<(u64, usize)> {
    let little = match header.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let short = |bytes: &[u8]| {
        let pair = [bytes[0], bytes[1]];
        if little {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        }
    };
    let long = |bytes: &[u8]| {
        let word = [bytes[0], bytes[1], bytes[2], bytes[3]];
        if little {
            u32::from_le_bytes(word)
        } else {
            u32::from_be_bytes(word)
        }
    };
    let mut ifd = long(header.get(4..8)?) as usize;
    let mut best = None;
    for _ in 0..8 {
        if ifd == 0 {
            break;
        }
        let Some(table) = header.get(ifd..).filter(|b| b.len() >= 2) else {
            break;
        };
        let length = usize::from(short(table)) * 12;
        let Some(entries) = table.get(2..2 + length) else {
            break;
        };
        let (mut offset, mut size) = (None, None);
        for entry in entries.chunks_exact(12) {
            if short(&entry[2..]) == 4 && long(&entry[4..]) == 1 {
                match short(entry) {
                    0x0201 => offset = Some(u64::from(long(&entry[8..]))),
                    0x0202 => size = Some(long(&entry[8..]) as usize),
                    _ => {}
                }
            }
        }
        if let Some((start, size)) = offset.zip(size) {
            if start > 0
                && (1..=EMBEDDED_JPEG_LIMIT).contains(&size)
                && best.is_none_or(|(_, n)| size > n)
            {
                best = Some((start, size));
            }
        }
        let Some(next) = table.get(2 + length..6 + length) else {
            break;
        };
        ifd = long(next) as usize;
    }
    best
}

type ShotPreview = (Vec<u8>, u32, u32);

fn read_test_image(
    path: &Path,
    name: &str,
    kind: FileKind,
    snapshot: Value,
) -> TResult<(Value, Option<ShotPreview>)> {
    let mut file = fs::File::open(path).map_err(composition_io)?;
    let size = file.metadata().map_err(composition_io)?.len();
    let header_limit = 2 << 20;
    let mut bytes = Vec::new();
    (&mut file)
        .take(header_limit)
        .read_to_end(&mut bytes)
        .map_err(composition_io)?;
    transfer::validate_capture_signature(name, &bytes).map_err(TetherError::from_transfer)?;
    let meta = composition_metadata(snapshot, &bytes, kind);
    if kind == FileKind::Jpeg {
        if size > REVIEW_LIMIT as u64 {
            return Ok((meta, None));
        }
        (&mut file)
            .take(size.saturating_sub(bytes.len() as u64))
            .read_to_end(&mut bytes)
            .map_err(composition_io)?;
        let (w, h, _) = protocol::codec::jpeg_scan(&bytes).map_err(|_| {
            TetherError::new(
                "INVALID_FORMAT",
                "The test shot does not contain a complete JPEG.",
            )
        })?;
        let preview =
            (u64::from(w) * u64::from(h) <= PREVIEW_PIXELS).then_some((bytes, w.into(), h.into()));
        return Ok((meta, preview));
    }
    let mut remaining = RAW_PREVIEW_SCAN - bytes.len();
    if let Some((offset, length)) =
        tiff_preview_range(&bytes).filter(|(offset, n)| offset + *n as u64 <= size)
    {
        file.seek(SeekFrom::Start(offset)).map_err(composition_io)?;
        let mut jpeg = vec![0; length];
        file.read_exact(&mut jpeg).map_err(composition_io)?;
        if let Ok((w, h, end)) = protocol::codec::jpeg_scan(&jpeg) {
            if u64::from(w) * u64::from(h) <= PREVIEW_PIXELS {
                jpeg.truncate(end);
                return Ok((meta, Some((jpeg, w.into(), h.into()))));
            }
        }
        remaining -= length;
        file.seek(SeekFrom::Start(bytes.len() as u64))
            .map_err(composition_io)?;
    }
    file.take(remaining as u64)
        .read_to_end(&mut bytes)
        .map_err(composition_io)?;
    let preview = embedded_jpeg(&bytes).map(|(jpeg, w, h)| (jpeg.to_vec(), w, h));
    Ok((meta, preview))
}

fn composition_io(e: io::Error) -> TetherError {
    TetherError::from_transfer(e.into())
}

fn composition_dir(root: &Path) -> TResult<PathBuf> {
    let stage = transfer::stage_dir(root).map_err(TetherError::from_transfer)?;
    transfer::create_child_dir(&stage, "", "composition")
        .map(|(dir, _)| dir)
        .map_err(TetherError::from_transfer)
}

fn checked_composition_dir(root: &Path) -> TResult<PathBuf> {
    transfer::resolve_dir(root, "").map_err(TetherError::from_transfer)?;
    transfer::resolve_dir(&root.join(transfer::STAGE_DIR), "composition")
        .map_err(TetherError::from_transfer)
}

fn remove_if_present(path: &Path) -> TResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(composition_io(e)),
    }
}

fn clean_composition(data: &Path, root: &Path) -> TResult<()> {
    let dir = root.join(COMPOSITION_DIR);
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(composition_io(e)),
        Ok(_) => {}
    }
    let dir = checked_composition_dir(root)?;
    for entry in fs::read_dir(&dir).map_err(composition_io)? {
        let entry = entry.map_err(composition_io)?;
        let name = entry.file_name();
        let seq = name
            .to_str()
            .and_then(|n| n.strip_prefix("test-"))
            .and_then(|n| n.split_once('-'))
            .filter(|(_, suffix)| matches!(*suffix, "raw.arw" | "jpeg.jpg"))
            .and_then(|(seq, _)| seq.parse::<u64>().ok());
        let Some(seq) = seq else { continue };
        if !keep_file(data, root, seq)
            .try_exists()
            .map_err(composition_io)?
            && !entry.file_type().map_err(composition_io)?.is_dir()
        {
            remove_if_present(&entry.path())?;
        }
    }
    match fs::remove_dir(dir) {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(composition_io(e)),
    }
}

fn closed_shoot(data: &Path, root: &Path, pending: &Value, epoch: u64) -> Value {
    let mut reply = json!({ "state": "offline", "pending": pending, "epoch": epoch });
    if let Err(error) = clean_composition(data, root) {
        reply["cleanupWarning"] = json!(error.message);
    }
    reply
}

fn replace_composition(
    data: &Path,
    root: &Path,
    slot: &mut Option<CompositionShot>,
    replacement: Option<CompositionShot>,
) -> TResult<()> {
    let previous = std::mem::replace(slot, replacement);
    if let Some(previous) = previous {
        if keep_file(data, root, previous.test_seq)
            .try_exists()
            .map_err(composition_io)?
        {
            return Ok(());
        }
        checked_composition_dir(root)?;
        for member in previous.members {
            remove_if_present(&member.path)?;
        }
    }
    Ok(())
}

fn composition_payload(shoot_id: &str, active: bool, shot: Option<&CompositionShot>) -> Value {
    let mut out = json!({
        "v": 1, "shootId": shoot_id, "active": active,
        "roles": shot.map(|s| s.members.iter().map(|m| m.kind.role()).collect::<Vec<_>>()).unwrap_or_default(),
        "previewRev": shot.map_or(0, |s| s.preview_rev), "pairComplete": shot.is_some_and(CompositionShot::pair_complete),
        "hasShot": shot.is_some(), "testSeq": shot.map_or(0, |s| s.test_seq),
    });
    if let Some(shot) = shot {
        let member = shot
            .members
            .iter()
            .find(|m| m.kind == FileKind::Raw)
            .unwrap_or(&shot.members[0]);
        let meta = &shot.camera_meta;
        out["filename"] = json!(member.name);
        out["format"] = json!(member.kind.role());
        out["bytes"] = json!(member.receipt.bytes);
        out["capturedAt"] = json!(shot.captured_at);
        out["meta"] = json!({
            "iso": meta["iso"].as_u64().map(|v| v.to_string()),
            "shutter": meta["shutter"].as_str().map(String::from)
                .or_else(|| meta["shutter"].as_f64().map(|v| format!("{v}s"))),
            "aperture": meta["aperture"].as_f64().map(|v| format!("f/{v}")),
            "focalLength": meta["focalLength"].as_f64().map(|v| format!("{v}mm")),
            "model": meta["model"], "flash": meta["flash"],
        });
    }
    out
}

fn composition_metadata(mut snapshot: Value, bytes: &[u8], kind: FileKind) -> Value {
    let exif = match kind {
        FileKind::Raw => lightcraft_meta::read_exif(bytes),
        _ => lightcraft_meta::extract(bytes),
    };
    if let Some(flash) = exif.flash {
        snapshot["flash"] = json!(if flash.fired { "Fired" } else { "Did not fire" });
    }
    if let Some(iso) = exif.iso {
        snapshot["iso"] = json!(iso);
    }
    if let Some(s) = exif.exposure_time.filter(|s| s.is_finite() && *s > 0.0) {
        if s < 1.0 && (s.recip() - s.recip().round()).abs() < 0.001 {
            snapshot["shutter"] = json!(format!("1/{:.0}", s.recip()));
        } else {
            snapshot["shutter"] = json!(s);
        }
    }
    if let Some(f) = exif.f_number {
        snapshot["aperture"] = json!(f);
    }
    if let Some(f) = exif.focal_length {
        snapshot["focalLength"] = json!(f);
    }
    if let Some(time) = exif.capture_time {
        snapshot["captureTime"] = json!(time.to_exif());
    }
    if snapshot["model"].is_null() {
        if let Some(model) = exif.model {
            snapshot["model"] = json!(model.chars().take(128).collect::<String>());
        }
    }
    snapshot
}

fn composition_timestamp(meta: &Value) -> String {
    meta["captureTime"]
        .as_str()
        .and_then(lightcraft_meta::DateTime::parse_exif)
        .map(|time| time.to_iso())
        .unwrap_or_else(|| {
            let seconds = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let (mut days, clock) = (seconds / 86400, seconds % 86400);
            let leap = |year| year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let mut year = 1970;
            while days >= 365 + u64::from(leap(year)) {
                days -= 365 + u64::from(leap(year));
                year += 1;
            }
            let month_lengths = [
                31,
                28 + u64::from(leap(year)),
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ];
            let mut month = 1;
            for length in month_lengths {
                if days < length {
                    break;
                }
                days -= length;
                month += 1;
            }
            format!(
                "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}Z",
                days + 1,
                clock / 3600,
                clock / 60 % 60,
                clock % 60
            )
        })
}

fn open_test_member(
    inner: &Inner,
    binding: &Binding,
    info: &ObjectInfo,
    kind: FileKind,
    companion: bool,
) -> TResult<Option<(CompositionDrain, StageWriter)>> {
    let seq = if companion {
        let shot = inner.composition_shot.lock().unwrap();
        let Some(shot) = shot.as_ref().filter(|s| s.shoot_id == binding.shoot_id) else {
            return Ok(None);
        };
        if shot.members.iter().any(|member| member.kind == kind) {
            return Ok(None);
        }
        shot.test_seq
    } else {
        inner.composition_seq.fetch_add(1, Ordering::SeqCst) + 1
    };
    if let Ok(free) = transfer::free_space(&binding.root) {
        let bytes = (info.compressed_size != u32::MAX)
            .then_some(info.compressed_size as u64)
            .unwrap_or(DEFAULT_OBJECT_BUDGET);
        if !transfer::has_room(free, bytes) {
            return Err(TetherError::new(
                "NO_SPACE",
                "The capture disk is almost full.",
            ));
        }
    }
    let path = composition_dir(&binding.root)?.join(format!(
        "test-{seq}-{}.{}",
        kind.role(),
        kind.extension().to_ascii_lowercase()
    ));
    let writer =
        StageWriter::create(path.clone(), MAX_CAPTURE_BYTES).map_err(TetherError::from_transfer)?;
    let name = object_name(info, kind);
    Ok(Some((
        CompositionDrain {
            seq,
            companion,
            name,
            kind,
            path,
        },
        writer,
    )))
}

fn store_test_member(
    inner: &Inner,
    binding: &Binding,
    plan: CompositionDrain,
    writer: StageWriter,
    snapshot: Value,
    roles: Option<Vec<HostRole>>,
) -> TResult<()> {
    let CompositionDrain {
        seq,
        companion,
        name,
        kind,
        path,
    } = plan;
    let prepared = (|| {
        let receipt = writer.finish().map_err(TetherError::from_transfer)?;
        let (meta, preview) = read_test_image(&path, &name, kind, snapshot)?;
        let member = CompositionMember {
            path: path.clone(),
            name,
            kind,
            receipt,
        };
        Ok((member, meta, preview))
    })();
    let (member, meta, preview) = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            let _ = remove_if_present(&path);
            return Err(e);
        }
    };

    let mut slot = inner.composition_shot.lock().unwrap();
    let cleanup = if companion {
        let shot = slot
            .as_mut()
            .expect("test shot still owned by the camera actor");
        shot.add_companion(member, meta, preview);
        Ok(())
    } else {
        let (preview_jpeg, preview_width, preview_height) = preview.unwrap_or_default();
        let epoch = inner.epoch.load(Ordering::SeqCst);
        let shot = CompositionShot {
            shoot_id: binding.shoot_id.clone(),
            test_seq: seq,
            epoch,
            promotion_key: format!("composition:{}:{}", inner.cohort, unique_suffix(epoch)),
            captured_at: composition_timestamp(&meta),
            expected_roles: roles.unwrap_or_else(|| vec![HostRole::Raw, HostRole::Jpeg]),
            preview_rev: u64::from(!preview_jpeg.is_empty()),
            members: vec![member],
            preview_jpeg,
            preview_width,
            preview_height,
            camera_meta: meta,
        };
        replace_composition(&inner.data_dir, &binding.root, &mut slot, Some(shot))
    };
    emit(
        &inner.app,
        "tether-composition",
        composition_payload(&binding.shoot_id, true, slot.as_ref()),
    );
    if let Err(e) = cleanup {
        crate::logs::write(&format!(
            "tether test shot cleanup {}: {}",
            e.code, e.message
        ));
    }
    Ok(())
}

fn camera_snapshot(
    device: &DeviceDesc,
    snapshot: &ExposureSnapshot,
    info: Option<&ObjectInfo>,
) -> Value {
    let mut out = Map::new();
    let text =
        |s: &str| (!s.is_empty()).then(|| Value::from(s.chars().take(128).collect::<String>()));
    if let Some(v) = text(&device.model) {
        out.insert("model".into(), v);
    }
    if let Some(v) = text(&device.serial) {
        out.insert("bodyId".into(), v);
    }
    if let Some(v) = text(&device.firmware) {
        out.insert("firmware".into(), v);
    }
    if let Some(t) = info.and_then(capture_time) {
        out.insert("captureTime".into(), t.into());
    }
    if let Some(iso) = snapshot.iso {
        out.insert("iso".into(), iso.into());
    }
    if let Some(s) = &snapshot.shutter {
        out.insert("shutter".into(), s.clone().into());
    }
    if let Some(a) = snapshot.aperture {
        out.insert("aperture".into(), a.into());
    }
    Value::Object(out)
}

fn object_name(info: &ObjectInfo, kind: FileKind) -> String {
    let name = info.filename.trim();
    let ok = !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control);
    if ok {
        name.to_string()
    } else {
        format!(
            "DSC{:05}.{}",
            info.sequence_number % 100_000,
            kind.extension()
        )
    }
}

fn file_stem(name: &str) -> &str {
    name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
}

/// A random identifier for this launch of the app.
fn launch_cohort() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    let random = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| io::Read::read_exact(&mut f, &mut bytes))
        .is_ok();
    if !random {
        // std seeds each RandomState from the operating system's generator.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for half in bytes.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            half.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    transfer::hex(&bytes)
}

/// Ledger keys for a camera shot and object. Sony restarts SequenceNumber at power-up, so without
/// a capture time only the current connection of this launch can vouch that two objects are the
/// same photo.
fn provider_keys(
    body: &str,
    cohort: &str,
    epoch: u64,
    info: &ObjectInfo,
    name: &str,
) -> (String, String) {
    let stem = file_stem(name).to_uppercase();
    let seq = info.sequence_number;
    let shot = if capture_time(info).is_some() {
        format!("sony:{body}:{}:{seq}:{stem}", info.capture_date)
    } else {
        format!("sony:{body}:cohort:{cohort}:epoch:{epoch}:{seq}:{stem}")
    };
    let object = format!("{shot}:{}", name.to_uppercase());
    (shot, object)
}

/// A name part no other recovered file uses.
fn unique_suffix(generation: u64) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{generation}-{nanos:x}-{}",
        NEXT.fetch_add(1, Ordering::SeqCst)
    )
}

/// Drops requests that may no longer claim a photo: expired, or given up by their caller.
fn prune_pending(pending: &mut VecDeque<(String, Instant)>, timed_out: &mut Vec<String>) {
    let gone = std::mem::take(timed_out);
    pending.retain(|(id, at)| at.elapsed() < REQUEST_TTL && !gone.contains(id));
}

/// Whether photos held in memory leave no room for another one.
fn recovery_full(count: usize, bytes: usize) -> bool {
    count >= RECOVERY_COUNT || bytes as u64 + DEFAULT_OBJECT_BUDGET > RECOVERY_BYTES as u64
}

/// Data the open callback needs without borrowing the actor.
struct DrainCtx {
    app: AppHandle,
    binding: Binding,
    cohort: String,
    epoch: u64,
    device: DeviceDesc,
    snapshot: ExposureSnapshot,
    roles: Option<Vec<HostRole>>,
    request: Option<String>,
    plan: RefCell<Option<MemberPlan>>,
    failure: RefCell<Option<TetherError>>,
    /// The exposure and, when this object's exposure was the one that claimed it, the request.
    accepted: RefCell<Option<(String, Option<String>)>>,
}

impl DrainCtx {
    fn open(&self, info: &ObjectInfo, kind: FileKind) -> io::Result<MemberSink> {
        match self.try_open(info, kind) {
            Ok(sink) => Ok(sink),
            Err(e) => {
                let message = e.message.clone();
                *self.failure.borrow_mut() = Some(e);
                Err(io::Error::other(message))
            }
        }
    }

    fn try_open(&self, info: &ObjectInfo, kind: FileKind) -> TResult<MemberSink> {
        let declared = (info.compressed_size != u32::MAX).then_some(info.compressed_size as u64);
        let free = transfer::free_space(&self.binding.root).ok();
        if let Some(free) = free {
            if !transfer::has_room(free, declared.unwrap_or(DEFAULT_OBJECT_BUDGET)) {
                return Err(TetherError::new(
                    "NO_SPACE",
                    "The capture disk is almost full. Free space or choose another folder; the camera keeps the photo until then.",
                ));
            }
        }
        let name = object_name(info, kind);
        let body = if self.device.serial.is_empty() {
            self.device.model.clone()
        } else {
            self.device.serial.clone()
        };
        let (shot_key, object_key) = provider_keys(&body, &self.cohort, self.epoch, info, &name);
        let role = match kind {
            FileKind::Raw => Some(HostRole::Raw),
            FileKind::Jpeg => Some(HostRole::Jpeg),
            _ => None,
        };
        let roles: Vec<&str> = match (&self.roles, role) {
            (Some(r), _) if !r.is_empty() => r.iter().map(|r| r.as_str()).collect(),
            (_, Some(r)) => vec![r.as_str()],
            _ => vec!["raw"],
        };
        let shoot = &self.binding.shoot_id;
        let request = self.request.clone();
        let accepted = node_blocking(
            &self.app,
            "tether-accept",
            json!([
                shoot,
                self.epoch,
                request,
                { "key": shot_key },
                roles,
                camera_snapshot(&self.device, &self.snapshot, Some(info)),
            ]),
        )?;
        let exposure_id = str_field(&accepted, "exposureId")?;
        let bound = accepted["boundRequestId"].as_str().map(String::from);
        *self.accepted.borrow_mut() = Some((exposure_id.clone(), bound));
        let mut descriptor = json!({
            "role": kind.role(),
            "originalName": name,
            "providerObjectKey": object_key,
        });
        if let Some(d) = declared {
            descriptor["declaredBytes"] = d.into();
        }
        let member = node_blocking(
            &self.app,
            "tether-member",
            json!([shoot, exposure_id, descriptor]),
        )?;
        let plan = MemberPlan {
            exposure_id,
            member_id: str_field(&member, "memberId")?,
            stage_rel: str_field(&member, "stageRelPath")?,
            status: str_field(&member, "status")?,
            name,
            declared,
        };
        let fresh = matches!(plan.status.as_str(), "announced" | "receiving" | "held");
        let sink = if fresh {
            let path = transfer::stage_path(&self.binding.root, &plan.stage_rel)
                .map_err(TetherError::from_transfer)?;
            let limit = declared.unwrap_or(0).max(MAX_CAPTURE_BYTES);
            let mut writer =
                StageWriter::create(path, limit).map_err(TetherError::from_transfer)?;
            // The camera may not send a photo twice; whatever arrived stays for recovery.
            writer.keep_partial();
            MemberSink::Stage(writer)
        } else {
            MemberSink::Discard
        };
        *self.plan.borrow_mut() = Some(plan);
        Ok(sink)
    }
}

struct Actor {
    inner: Arc<Inner>,
    rx: mpsc::Receiver<Cmd>,
    session: Option<SonySession<CameraTransport>>,
    device: Option<DeviceDesc>,
    /// The shoot `device` was verified and attached for; a failed connect leaves it unchanged.
    device_shoot: Option<String>,
    shoot_id: Option<String>,
    epoch: u64,
    state: LinkState,
    paused: bool,
    want_live: bool,
    live_on: bool,
    next_poll: Instant,
    next_live: Instant,
    next_stats: Instant,
    reconnect: Option<(usize, Instant)>,
    last_topology: u64,
    last_revs: BTreeMap<u16, u64>,
    last_props: Vec<CameraProperty>,
    last_d215: u16,
    /// Released software shutters waiting for their exposure, oldest first.
    pending: VecDeque<(String, Instant)>,
    drain_blocked_until: Option<Instant>,
    half_press_since: Option<Instant>,
    issue_open: Option<String>,
    /// Members whose GetObject timed out, by attachment generation: the camera may still finish.
    late_claims: HashMap<u64, LateClaim>,
    /// Late photos the disk has not accepted yet.
    late_backlog: Vec<icc::LateObject>,
    late_retry_at: Instant,
    cohorts: CaptureCohorts,
}

/// Where a late GetObject payload belongs.
struct LateClaim {
    binding: Binding,
    plan: MemberPlan,
    shot: Value,
    epoch: u64,
}

impl Actor {
    fn new(inner: Arc<Inner>, rx: mpsc::Receiver<Cmd>) -> Self {
        let now = Instant::now();
        Actor {
            inner,
            rx,
            session: None,
            device: None,
            device_shoot: None,
            shoot_id: None,
            epoch: 0,
            state: LinkState::Offline,
            paused: false,
            want_live: false,
            live_on: false,
            next_poll: now,
            next_live: now,
            next_stats: now,
            reconnect: None,
            last_topology: 0,
            last_revs: BTreeMap::new(),
            last_props: Vec::new(),
            last_d215: 0,
            pending: VecDeque::new(),
            drain_blocked_until: None,
            half_press_since: None,
            issue_open: None,
            late_claims: HashMap::new(),
            late_backlog: Vec::new(),
            late_retry_at: now,
            cohorts: CaptureCohorts::default(),
        }
    }

    fn run(mut self) {
        loop {
            let wait = if self.live_on {
                Duration::from_millis(10)
            } else if self.session.is_some() || self.reconnect.is_some() {
                Duration::from_millis(50)
            } else {
                Duration::from_millis(250)
            };
            match self.rx.recv_timeout(wait) {
                Ok(Cmd::Shutdown(done)) => {
                    self.teardown();
                    let _ = done.send(());
                    return;
                }
                Ok(cmd) => self.handle(cmd),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.teardown();
                    return;
                }
            }
            self.service();
        }
    }

    fn binding(&self) -> Option<Binding> {
        let binding = self.inner.binding.lock().unwrap().clone()?;
        (Some(&binding.shoot_id) == self.shoot_id.as_ref()).then_some(binding)
    }

    fn set_state(&mut self, state: LinkState, reason: Option<String>) {
        self.state = state;
        *self.inner.state.lock().unwrap() = (state, reason);
    }

    fn check_stamp(&self, stamp: &Stamp) -> TResult<()> {
        let bound = self
            .inner
            .binding
            .lock()
            .unwrap()
            .as_ref()
            .map(|b| b.shoot_id.clone());
        check_stamp(
            stamp,
            bound.as_deref(),
            self.shoot_id.as_deref(),
            self.epoch,
        )
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Bind(binding, recoveries, reply) => {
                let _ = reply.send(self.bind(binding, recoveries));
            }
            Cmd::Connect(device_id, expect, reply) => {
                let result = self.connect(&device_id, true, expect.as_ref());
                let _ = reply.send(result);
            }
            Cmd::Snapshot(reply) => {
                let _ = reply.send(Ok(self.snapshot()));
            }
            Cmd::TransfersSettled(reply) => {
                self.store_late_objects();
                let _ = reply.send(Ok(
                    self.late_claims.is_empty() && self.late_backlog.is_empty()
                ));
            }
            Cmd::Pause(stamp, paused, reply) => {
                if let Err(e) = self.check_stamp(&stamp) {
                    let _ = reply.send(Err(e));
                    return;
                }
                self.paused = paused;
                if self.state == LinkState::Ready || self.state == LinkState::Paused {
                    let state = if paused {
                        LinkState::Paused
                    } else {
                        LinkState::Ready
                    };
                    self.set_state(state, None);
                }
                if paused {
                    self.release_holds();
                    self.stop_live(Some("Tether paused".into()));
                } else if self.want_live {
                    let _ = self.start_live();
                }
                self.emit_connection(None);
                let _ = reply.send(Ok(self.control_state()));
            }
            Cmd::Refresh(stamp, reply) => {
                if let Err(e) = self.check_stamp(&stamp) {
                    let _ = reply.send(Err(e));
                    return;
                }
                let refreshed = match self.session.as_mut() {
                    Some(session) if session.state() == ConnectionState::Ready => {
                        Some(session.refresh_properties())
                    }
                    _ => None,
                };
                let result = match refreshed {
                    Some(Ok(_)) => {
                        if let Some(session) = self.session.as_ref() {
                            let props = session.camera_properties();
                            self.last_revs = props.iter().map(|p| (p.code, p.prop_rev)).collect();
                            self.last_props = props;
                        }
                        Ok(self.snapshot())
                    }
                    Some(Err(e)) => {
                        let mapped = TetherError::from_session(e_clone(&e));
                        self.handle_session_error(e);
                        Err(mapped)
                    }
                    None => Ok(self.snapshot()),
                };
                let _ = reply.send(result);
            }
            Cmd::Reconnect(stamp, reply) => {
                if let Err(e) = self.check_stamp(&stamp) {
                    let _ = reply.send(Err(e));
                    return;
                }
                crate::logs::write("tether reconnect requested");
                let result = match self.device.clone() {
                    Some(device) => {
                        self.close_session();
                        self.connect(&device.device_id, false, None)
                            .map(|_| self.control_state())
                    }
                    None => Err(TetherError::new(
                        "CAMERA_LOST",
                        "Choose a camera to connect first.",
                    )),
                };
                let _ = reply.send(result);
            }
            Cmd::Disconnect(stamp, reply) => {
                if let Err(e) = self.check_stamp(&stamp) {
                    let _ = reply.send(Err(e));
                    return;
                }
                self.disconnect();
                let _ = reply.send(Ok(self.control_state()));
            }
            Cmd::Preflight(stamp, reply) => {
                let _ = reply.send(self.check_stamp(&stamp).and_then(|_| self.preflight()));
            }
            Cmd::Trigger(stamp, request_id, reply) => {
                let result = self
                    .check_stamp(&stamp)
                    .and_then(|_| self.trigger(request_id));
                let _ = reply.send(result);
            }
            Cmd::Fel(stamp, reply) => {
                let result = self.check_stamp(&stamp).and_then(|_| self.fel());
                let _ = reply.send(result);
            }
            Cmd::Composition(stamp, op, reply) => {
                let result = self.check_stamp(&stamp).and_then(|_| self.composition(op));
                let _ = reply.send(result);
            }
            Cmd::SetProperty(stamp, key, value, rev, reply) => {
                let result = self
                    .check_stamp(&stamp)
                    .and_then(|_| self.set_property(&key, &value, rev));
                let _ = reply.send(result);
            }
            Cmd::Focus(stamp, op, reply) => {
                // A release must always reach the camera, even from a stale panel.
                let result = match op {
                    FocusOp::Release(_) => self.focus(op),
                    op => self.check_stamp(&stamp).and_then(|_| self.focus(op)),
                };
                let _ = reply.send(result);
            }
            Cmd::Live(stamp, enabled, reply) => {
                if let Err(e) = self.check_stamp(&stamp) {
                    let _ = reply.send(Err(e));
                    return;
                }
                let result = if enabled {
                    self.want_live = true;
                    self.start_live()
                } else {
                    self.want_live = false;
                    self.stop_live(None);
                    Ok(json!({ "streamId": null, "state": "off" }))
                };
                let _ = reply.send(result);
            }
            Cmd::Shutdown(_) => {}
        }
    }

    fn ready_session(&mut self) -> TResult<&mut SonySession<CameraTransport>> {
        match self.session.as_mut() {
            Some(s) if s.state() == ConnectionState::Ready => Ok(s),
            _ => Err(TetherError::new(
                "CAMERA_LOST",
                "The camera is not connected.",
            )),
        }
    }

    fn device_json(&self) -> Value {
        let Some(device) = &self.device else {
            return Value::Null;
        };
        let session = self.session.as_ref();
        let battery = session.and_then(|s| s.battery_percent());
        let destination = session.and_then(|s| {
            s.camera_properties()
                .into_iter()
                .find(|p| p.key == "saveDestination")
                .map(|p| p.display)
        });
        let guid = device.route.as_ref().and_then(|r| r.responder_guid);
        json!({
            "deviceId": device.device_id,
            "model": device.model,
            "bodyKey": body_key(&device.model, &device.serial, guid),
            "firmware": if device.firmware.is_empty() { Value::Null } else { device.firmware.clone().into() },
            "transport": if device.wifi { "wifi-ptpip" } else { "usb-icc" },
            "profile": session.map(|s| s.profile().name()),
            "sdiVersion": session.map(|s| s.sdi_version()),
            "battery": battery,
            "saveDestination": destination,
            "deliversToHost": session.and_then(|s| s.delivers_to_host()),
        })
    }

    fn properties_json(props: &[CameraProperty]) -> Value {
        Value::Array(props.iter().map(property_json).collect())
    }

    fn actions_json(&self) -> Value {
        match &self.session {
            Some(s) if s.state() == ConnectionState::Ready => {
                let mut actions = s.actions();
                if self.paused {
                    for a in actions
                        .iter_mut()
                        .filter(|a| a.key == "trigger" || a.key == "liveView")
                    {
                        a.available = false;
                        a.reason = Some("Tether is paused.".into());
                    }
                }
                Value::Array(actions.iter().map(action_json).collect())
            }
            _ => json!([]),
        }
    }

    fn capabilities_json(&self) -> Value {
        let supported = self.session.as_ref().is_some_and(|s| s.fel_supported());
        let enabled = supported
            && self
                .session
                .as_ref()
                .is_some_and(|s| s.state() == ConnectionState::Ready);
        let reason = if enabled {
            None
        } else if self.session.is_none() {
            Some("The camera is not connected.")
        } else if !supported {
            Some("This camera does not offer flash exposure lock.")
        } else {
            Some("The camera is not ready.")
        };
        json!({ "fel": { "supported": supported, "enabled": enabled, "reason": reason } })
    }

    fn snapshot(&self) -> Value {
        let props = match &self.session {
            Some(s) => s.camera_properties(),
            None => self.last_props.clone(),
        };
        let reason = self.inner.state.lock().unwrap().1.clone();
        json!({
            "epoch": self.epoch,
            "shootId": self.device_shoot,
            "device": self.device_json(),
            "properties": Self::properties_json(&props),
            "propRev": self.session.as_ref().map(|s| s.prop_rev()).unwrap_or(0),
            "actions": self.actions_json(),
            "capabilities": self.capabilities_json(),
            "connection": {
                "state": self.state.as_str(),
                "paused": self.paused,
                "reason": reason,
                "lastSeen": self.session.is_none() && !props.is_empty(),
            },
        })
    }

    fn control_state(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "epoch": self.epoch,
            "pending": self.inner.outstanding.load(Ordering::SeqCst),
            "paused": self.paused,
        })
    }

    fn emit_connection(&self, reason: Option<&str>) {
        let Some(shoot) = &self.shoot_id else { return };
        let snap = self.snapshot();
        emit(
            &self.inner.app,
            "tether-connection",
            json!({
                "v": 1,
                "shootId": shoot,
                "epoch": self.epoch,
                "state": self.state.as_str(),
                "device": snap["device"],
                "actions": snap["actions"],
                "capabilities": snap["capabilities"],
                "properties": snap["properties"],
                "propRev": snap["propRev"],
                "reason": reason,
            }),
        );
    }

    fn emit_issue(&mut self, code: &str, message: &str, retryable: bool) {
        let key = format!("{code}:{message}");
        if self.issue_open.as_deref() == Some(key.as_str()) {
            return;
        }
        self.issue_open = Some(key);
        crate::logs::write(&format!("tether issue {code}: {message}"));
        let binding = self.binding();
        emit(
            &self.inner.app,
            "tether-issue",
            json!({
                "v": 1,
                "shootId": self.shoot_id,
                "session": binding.map(|b| b.session),
                "code": code,
                "message": message,
                "retryable": retryable,
                "actions": [],
            }),
        );
    }

    fn connect(
        &mut self,
        device_id: &str,
        explicit: bool,
        expect: Option<&ExpectedBody>,
    ) -> TResult<Value> {
        let binding = self
            .inner
            .binding
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(TetherError::stale_session)?;
        if let (Some(device), Some(session)) = (&self.device, &self.session) {
            if device.device_id == device_id
                && session.state() == ConnectionState::Ready
                && self.shoot_id.as_ref() == Some(&binding.shoot_id)
            {
                return Ok(self.snapshot());
            }
        }
        let previous = self.device.clone();
        self.close_session();
        self.shoot_id = Some(binding.shoot_id.clone());
        let is_wifi = device_id.starts_with(WIFI_PREFIX);
        let waiting = is_wifi
            .then_some("Waiting for the camera. If it asks, confirm PhotoCull on the camera.");
        self.set_state(LinkState::Connecting, waiting.map(String::from));
        self.emit_connection(waiting);
        let cancelled = Arc::new(AtomicBool::new(false));
        *self.inner.connecting.lock().unwrap() = Some(PendingConnect {
            cancelled: cancelled.clone(),
            link: None,
        });
        let _connecting = Connecting(self.inner.clone());
        // A reconnect goes the way the shoot attached, whatever the camera list says now.
        let attached = previous
            .as_ref()
            .filter(|_| !explicit)
            .and_then(|d| d.route.clone());
        let mut route = None;
        let transport = if is_wifi {
            self.wifi_transport(device_id, attached.as_ref(), &cancelled)
                .map(|(transport, r)| {
                    route = Some(r);
                    transport
                })
        } else {
            IccTransport::new(device_id)
                .map(CameraTransport::Usb)
                .map_err(|e| TetherError::from_session(SessionError::Transport(e)))
        };
        let transport = transport.map_err(|e| {
            if cancelled.load(Ordering::SeqCst) {
                connect_cancelled()
            } else {
                e
            }
        });
        let mut session = match transport {
            Ok(t) => SonySession::new(
                t,
                SessionConfig {
                    max_object_bytes: MAX_CAPTURE_BYTES,
                    open_timeout: match (is_wifi, explicit) {
                        (true, true) => WIFI_PAIRING_TIMEOUT,
                        (true, false) => WIFI_REOPEN_TIMEOUT,
                        _ => SessionConfig::default().open_timeout,
                    },
                    ..SessionConfig::default()
                },
            ),
            Err(e) => {
                let next = if explicit {
                    LinkState::Offline
                } else {
                    self.state
                };
                self.set_state(next, Some(e.message.clone()));
                self.emit_connection(Some(&e.message));
                return Err(e);
            }
        };
        let connected = session.connect();
        if connected.is_ok() && cancelled.load(Ordering::SeqCst) {
            let _ = session.close();
            let e = connect_cancelled();
            self.set_state(LinkState::Offline, Some(e.message.clone()));
            self.emit_connection(Some(&e.message));
            return Err(e);
        }
        if let Err(e) = connected {
            let _ = session.close();
            let e = if cancelled.load(Ordering::SeqCst) {
                connect_cancelled()
            } else if is_wifi {
                wifi_connect_error(e)
            } else {
                TetherError::from_session(e)
            };
            let next = if explicit {
                LinkState::Offline
            } else {
                self.state
            };
            crate::logs::write(&format!(
                "tether connect failed ({}): {} {}",
                if is_wifi { "wifi" } else { "usb" },
                e.code,
                e.message
            ));
            self.set_state(next, Some(e.message.clone()));
            if explicit {
                self.emit_connection(Some(&e.message));
            }
            return Err(e);
        }
        let info = session.device().cloned().unwrap_or_default();
        let responder_guid = session.transport().responder_guid();
        if let Some(route) = route.as_mut().filter(|_| attached.is_none()) {
            route.responder_guid = responder_guid;
            route.model = info.model.trim().to_string();
        }
        if !explicit {
            if let Some(previous) = &previous {
                let same = if is_wifi {
                    same_wifi_body(previous, &info.model, &info.serial_number, responder_guid)
                } else {
                    same_body(previous, device_id, &info.model, &info.serial_number)
                };
                if !same {
                    let _ = session.close();
                    return Err(TetherError::new(
                        "CAMERA_LOST",
                        "A different camera is connected. Choose it to continue the shoot.",
                    )
                    .retryable(false));
                }
            }
        }
        let key = body_key(&info.model, &info.serial_number, responder_guid);
        if expect.is_some_and(|e| !e.matches(device_id, &info.model, key.as_deref())) {
            let _ = session.close();
            let e = TetherError::new(
                "CAMERA_LOST",
                "A different camera is connected. Choose it to continue the shoot.",
            )
            .retryable(false);
            self.set_state(LinkState::Offline, Some(e.message.clone()));
            self.emit_connection(Some(&e.message));
            return Err(e);
        }
        self.device_shoot = Some(binding.shoot_id.clone());
        self.device = Some(DeviceDesc {
            device_id: device_id.to_string(),
            model: info.model.trim().to_string(),
            firmware: info.device_version.trim().to_string(),
            serial: info.serial_number.trim().to_string(),
            wifi: is_wifi,
            route,
        });
        if is_wifi {
            remember_wifi(&self.inner, device_id, info.model.trim(), responder_guid);
        }
        self.epoch = self.inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.last_revs = session
            .descriptors()
            .map(|d| (d.code, session.rev_of(d.code)))
            .collect();
        self.last_props = session.camera_properties();
        self.last_d215 = session.object_in_memory();
        crate::logs::write(&format!(
            "tether connected: {} ({}, sdi={}, saveDest={:?}, d215=0x{:04X})",
            info.model.trim(),
            if is_wifi { "wifi" } else { "usb" },
            session.sdi_version(),
            session.save_destination().map(|v| format!("0x{v:04X}")),
            self.last_d215
        ));
        self.session = Some(session);
        self.reconnect = None;
        self.drain_blocked_until = None;
        self.issue_open = None;
        self.last_topology = self.inner.browser.topology();
        let state = if self.paused {
            LinkState::Paused
        } else {
            LinkState::Ready
        };
        self.set_state(state, None);
        self.next_poll = Instant::now();
        self.emit_connection(None);
        if self.want_live && !self.paused {
            let _ = self.start_live();
        }
        Ok(self.snapshot())
    }

    /// Builds the Wi-Fi link: the attached route on a reconnect, else the camera list's route.
    /// SSH tunnel first when Access Authentication is on, never a silent fall back to plaintext.
    fn wifi_transport(
        &mut self,
        device_id: &str,
        attached: Option<&AttachedWifiRoute>,
        cancelled: &AtomicBool,
    ) -> TResult<(CameraTransport, AttachedWifiRoute)> {
        let known = known_hosts(&self.inner.data_dir);
        let (route, password) = {
            let mut state = self.inner.wifi.lock().unwrap();
            load_remembered(&self.inner.data_dir, &mut state);
            let route = match attached {
                Some(route) => route.clone(),
                None => {
                    let candidate = state.candidates.get(device_id).ok_or_else(|| {
                        TetherError::new(
                            "CAMERA_LOST",
                            "Find the camera on Wi-Fi or add it by its IP address first.",
                        )
                        .retryable(false)
                    })?;
                    if candidate.auth == WifiAuth::Unknown {
                        return Err(auth_choice_required());
                    }
                    AttachedWifiRoute::attach(candidate, &known).map_err(ssh_error)?
                }
            };
            (route, state.passwords.get(device_id).cloned())
        };
        if attached.is_some() {
            route.check_pin(&known).map_err(ssh_error)?;
        }
        let guid = wifi::initiator_guid(&self.inner.data_dir).map_err(|e| {
            TetherError::new(
                "IO_ERROR",
                format!("PhotoCull could not keep its camera pairing identity: {e}"),
            )
        })?;
        let (endpoint, tunnel) = match route.auth {
            WifiAuth::Unknown => return Err(auth_choice_required()),
            WifiAuth::Plain => (
                SocketAddr::V4(SocketAddrV4::new(route.address, PTPIP_PORT)),
                None,
            ),
            WifiAuth::Ssh => {
                let (Some(username), Some(password)) = (route.username.clone(), password) else {
                    return Err(credentials_required());
                };
                let target = wifi::SshTarget {
                    address: route.address,
                    username,
                    alias: route.alias.clone(),
                    known_hosts: known,
                };
                let tunnel = wifi::SshTunnel::start(
                    &target,
                    &password,
                    &ssh_dir(&self.inner.data_dir).join("run"),
                    SSH_START_TIMEOUT,
                    cancelled,
                )
                .map_err(ssh_error)?;
                (tunnel.local_addr(), Some(tunnel))
            }
        };
        let transport = PtpIpTransport::new(PtpIpConfig {
            endpoint,
            initiator_guid: guid,
            friendly_name: INITIATOR_NAME.into(),
            generation: WIFI_GENERATIONS.fetch_add(1 << 20, Ordering::SeqCst),
        });
        let link = transport.abort_handle();
        if let Some(pending) = self.inner.connecting.lock().unwrap().as_mut() {
            pending.link = Some(link.clone());
        }
        // A Disconnect that arrived before the handle was registered still ends the open.
        if cancelled.load(Ordering::SeqCst) {
            link.abort();
        }
        Ok((
            CameraTransport::Wifi {
                transport,
                _tunnel: tunnel,
            },
            route,
        ))
    }

    fn close_session(&mut self) {
        self.stop_live(None);
        if let Some(mut session) = self.session.take() {
            self.last_props = session.camera_properties();
            let _ = session.close();
        }
        self.half_press_since = None;
    }

    fn disconnect(&mut self) {
        self.inner.cancel.store(true, Ordering::SeqCst);
        if self.session.is_some() {
            self.set_state(LinkState::Draining, None);
        }
        self.close_session();
        self.reconnect = None;
        self.want_live = false;
        self.set_state(LinkState::Offline, None);
        self.emit_connection(None);
    }

    fn teardown(&mut self) {
        self.release_holds();
        self.close_session();
        if let Some(binding) = self.inner.binding.lock().unwrap().as_ref() {
            if let Err(error) = clean_composition(&self.inner.data_dir, &binding.root) {
                crate::logs::write(&format!("tether test shot cleanup: {}", error.message));
            }
        }
        self.reconnect = None;
        self.set_state(LinkState::Offline, None);
    }

    fn release_holds(&mut self) {
        if let Some(s) = self.session.as_mut() {
            let _ = s.half_release(None);
        }
        self.half_press_since = None;
    }

    fn lost(&mut self, reason: &str) {
        crate::logs::write(&format!("tether lost: {reason}"));
        self.stop_live(Some(reason.to_string()));
        if let Some(mut session) = self.session.take() {
            self.last_props = session.camera_properties();
            let _ = session.close();
        }
        self.half_press_since = None;
        // The photos may still arrive after a reconnect and bind then; nobody waits meanwhile.
        for (id, _) in self.pending.clone() {
            self.inner.confirmations.lock().unwrap().remove(&id);
            self.resolve_request(&id, "outcomeUnknown");
        }
        self.set_state(LinkState::Lost, Some(reason.to_string()));
        self.emit_connection(Some(reason));
        self.last_topology = self.inner.browser.topology();
        if !self.auto_reconnect() {
            self.reconnect = None;
            return;
        }
        self.set_state(LinkState::Reconnecting, Some(reason.to_string()));
        self.reconnect = Some((0, Instant::now() + Duration::from_secs(RECONNECT_STEPS[0])));
        self.emit_connection(Some(reason));
    }

    /// The photographer's preference, read when it matters so a change applies at once.
    fn auto_reconnect(&self) -> bool {
        node_blocking(&self.inner.app, "settings", json!([]))
            .map_or(true, |settings| auto_reconnect_enabled(&settings))
    }

    fn resolve_request(&self, request_id: &str, result: &str) {
        if let Some(shoot) = &self.shoot_id {
            let _ = node_blocking(
                &self.inner.app,
                "tether-request",
                json!([shoot, request_id, null, "resolve", result]),
            );
        }
    }

    fn try_reconnect(&mut self) {
        let Some((attempt, at)) = self.reconnect else {
            return;
        };
        let topology = self.inner.browser.topology();
        if Instant::now() < at && topology == self.last_topology {
            return;
        }
        self.last_topology = topology;
        let Some(device) = self.device.clone() else {
            self.reconnect = None;
            return;
        };
        if !self.auto_reconnect() {
            self.reconnect = None;
            let reason = self.inner.state.lock().unwrap().1.clone();
            self.set_state(LinkState::Lost, reason.clone());
            self.emit_connection(reason.as_deref());
            return;
        }
        let target = if device.wifi {
            Some(device.device_id.clone())
        } else {
            let candidates: Vec<IccDevice> = self.inner.browser.devices().unwrap_or_default();
            reconnect_target(&device, &candidates)
        };
        if target.is_none() && device.serial.is_empty() {
            self.set_state(
                LinkState::Reconnecting,
                Some("Waiting for the same camera. If it reappears under a new identity, choose it again.".into()),
            );
        }
        let mut failed = true;
        if let Some(id) = target {
            match self.connect(&id, false, None) {
                Ok(_) => failed = false,
                Err(e) if !e.retryable => {
                    self.reconnect = None;
                    self.set_state(LinkState::Offline, Some(e.message.clone()));
                    self.emit_connection(Some(&e.message));
                    return;
                }
                Err(_) => {}
            }
        }
        if failed {
            let next = (attempt + 1).min(RECONNECT_STEPS.len() - 1);
            self.reconnect = Some((
                next,
                Instant::now() + Duration::from_secs(RECONNECT_STEPS[next]),
            ));
            let reason = self.inner.state.lock().unwrap().1.clone();
            self.set_state(LinkState::Reconnecting, reason);
        }
    }

    fn service(&mut self) {
        self.cohorts.expire_test();
        self.store_late_objects();
        if self.reconnect.is_some() {
            self.try_reconnect();
            return;
        }
        let Some(session) = self.session.as_mut() else {
            return;
        };
        for event in session.process_events() {
            match event {
                SessionEvent::Removed => return self.lost("The camera was disconnected."),
                SessionEvent::SessionLost => return self.lost("The camera session ended."),
                SessionEvent::PropertiesDirty => self.next_poll = Instant::now(),
                SessionEvent::ObjectAdded => crate::logs::write("tether event: ObjectAdded"),
            }
        }
        if let Some(since) = self.half_press_since {
            if since.elapsed() > HALF_PRESS_LIMIT {
                self.release_holds();
            }
        }
        let now = Instant::now();
        if now >= self.next_poll {
            let draining = self.inner.receiving.load(Ordering::SeqCst) > 0;
            let waiting_capture = !self.pending.is_empty()
                || self.cohorts.pending_test.is_some()
                || self.session.as_ref().is_some_and(|s| {
                    s.object_announced() || s.queue_signal() != QueueSignal::Empty
                });
            self.next_poll = now
                + if draining {
                    Duration::from_millis(1000)
                } else if waiting_capture {
                    Duration::from_millis(100)
                } else {
                    Duration::from_millis(500)
                };
            let result = self.session.as_mut().map(|s| s.refresh_properties());
            match result {
                Some(Ok(_)) => {
                    if let Some((d215, quiet)) = self.session.as_ref().map(|s| {
                        (
                            s.object_in_memory(),
                            !s.object_announced() && s.queue_signal() == QueueSignal::Empty,
                        )
                    }) {
                        if d215 != self.last_d215 {
                            crate::logs::write(&format!(
                                "tether d215: 0x{:04X} -> 0x{:04X}",
                                self.last_d215, d215
                            ));
                            self.last_d215 = d215;
                        }
                        if quiet {
                            self.cohorts.awaiting_quiet_queue = false;
                        }
                    }
                    self.emit_property_changes();
                }
                Some(Err(e)) => {
                    if self.handle_session_error(e) {
                        return;
                    }
                }
                None => return,
            }
        }
        let wants_drain = self
            .session
            .as_ref()
            .is_some_and(|s| s.object_announced() || s.queue_signal() == QueueSignal::Ready);
        let blocked = self.drain_blocked_until.is_some_and(|t| Instant::now() < t);
        if wants_drain && !blocked && self.binding().is_some() {
            self.drain_some();
            if self.session.is_none() {
                return;
            }
        }
        let capture_active = self
            .session
            .as_ref()
            .is_some_and(|s| s.object_announced() || s.queue_signal() != QueueSignal::Empty)
            || self
                .pending
                .iter()
                .any(|(_, at)| at.elapsed() < Duration::from_secs(4))
            || self.cohorts.pending_test.is_some();
        if self.live_on && !self.paused && !capture_active && Instant::now() >= self.next_live {
            self.fetch_live();
        }
        if self.live_on && Instant::now() >= self.next_stats {
            self.next_stats = Instant::now() + Duration::from_secs(2);
            let (fps, dropped) = self.inner.live.take_stats();
            if let Some((stream, epoch)) = self.inner.live.stream() {
                emit(
                    &self.inner.app,
                    "tether-live-state",
                    json!({ "v": 1, "shootId": self.shoot_id, "epoch": epoch, "streamId": stream, "state": "streaming", "deliveredFps": fps, "dropped": dropped }),
                );
            }
        }
    }

    /// True when the error ended the session.
    fn handle_session_error(&mut self, e: SessionError) -> bool {
        match e {
            SessionError::Removed { .. } => {
                self.lost("The camera was disconnected.");
                true
            }
            SessionError::SessionLost | SessionError::Transport(TransportError::TimedOut) => {
                self.lost("The camera stopped answering.");
                true
            }
            // A failed PTP/IP transaction retires both streams; a local sink error before
            // GetObject leaves the streams live.
            SessionError::Transport(ref t)
                if self.device.as_ref().is_some_and(|d| d.wifi)
                    && (!matches!(t, TransportError::Sink(_))
                        || self
                            .session
                            .as_ref()
                            .map_or(true, |s| !s.transport().is_live())) =>
            {
                self.lost("The camera connection was lost.");
                true
            }
            _ => false,
        }
    }

    fn emit_property_changes(&mut self) {
        self.emit_properties(false);
    }

    fn emit_properties(&mut self, force: bool) {
        let Some(session) = self.session.as_ref() else {
            return;
        };
        let props = session.camera_properties();
        let changed: Vec<&CameraProperty> = props
            .iter()
            .filter(|p| self.last_revs.get(&p.code) != Some(&p.prop_rev))
            .collect();
        let removed: Vec<&str> = self
            .last_props
            .iter()
            .filter(|old| !props.iter().any(|p| p.key == old.key))
            .map(|old| old.key)
            .collect();
        if !force && changed.is_empty() && removed.is_empty() {
            return;
        }
        let payload = json!({
            "v": 1,
            "shootId": self.shoot_id,
            "epoch": self.epoch,
            "propRev": session.prop_rev(),
            "changed": changed.iter().map(|p| property_json(p)).collect::<Vec<_>>(),
            "removed": removed,
            "actions": self.actions_json(),
            "capabilities": self.capabilities_json(),
        });
        self.last_revs = props.iter().map(|p| (p.code, p.prop_rev)).collect();
        self.last_props = props;
        emit(&self.inner.app, "tether-properties", payload);
    }

    /// Binds the shoot and replays interrupted Keeps; returns the issues of Keeps that could not
    /// finish, which the renderer has not subscribed to yet.
    fn bind(&mut self, binding: Binding, mut recoveries: Value) -> TResult<Vec<Value>> {
        let mut issues = Vec::new();
        let previous = self.inner.binding.lock().unwrap().clone();
        if let Some(old) = previous.as_ref().filter(|b| b.root != binding.root) {
            clean_composition(&self.inner.data_dir, &old.root)?;
        }
        for promotion in KeepPromotion::pending(&self.inner.data_dir, &binding.root)? {
            self.inner
                .composition_seq
                .fetch_max(promotion.seq, Ordering::SeqCst);
            if promotion.shoot_id != binding.shoot_id {
                continue;
            }
            if let Some(records) = recoveries.as_array_mut() {
                for member in &promotion.members {
                    let (id, _) = promotion.member(&binding.root, member);
                    records.retain(|record| record["memberId"] != id);
                }
            }
            if let Err(e) =
                tauri::async_runtime::block_on(keep_composition(&self.inner, &binding, &promotion))
            {
                let issue = json!({
                    "v": 1, "shootId": binding.shoot_id, "session": binding.session, "code": e.code,
                    "message": format!("Keeping test shot {}: {}", promotion.seq, e.message), "retryable": e.retryable, "actions": [],
                });
                emit(&self.inner.app, "tether-issue", issue.clone());
                issues.push(issue);
            }
        }
        clean_composition(&self.inner.data_dir, &binding.root)?;
        self.inner.composition_mode.store(false, Ordering::SeqCst);
        self.inner.composition_shot.lock().unwrap().take();
        self.cohorts.latest_test = None;
        self.cohorts.awaiting_quiet_queue = false;
        self.cohorts.pending_test = None;
        *self.inner.binding.lock().unwrap() = Some(binding.clone());
        resume_records(&self.inner, &binding, &recoveries);
        Ok(issues)
    }

    fn composition(&mut self, op: CompositionOp) -> TResult<Value> {
        let binding = self
            .inner
            .binding
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(TetherError::stale_session)?;
        let inner = self.inner.clone();
        let active = inner.composition_mode.load(Ordering::SeqCst);
        let on = matches!(op, CompositionOp::On);
        let off = matches!(op, CompositionOp::Off);
        let current_seq = op.selected_seq(inner.composition_shot.lock().unwrap().as_ref())?;
        if (on || off) && on != active {
            let camera_pending = self.session.is_some() && self.refresh_capture_pending()?;
            prune_pending(&mut self.pending, &mut self.inner.timed_out.lock().unwrap());
            self.cohorts
                .check_transition(camera_pending, !self.pending.is_empty())?;
        }
        if matches!(op, CompositionOp::Keep(..))
            && self.session.is_some()
            && inner
                .composition_shot
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|s| !s.pair_complete())
            && self.refresh_capture_pending()?
        {
            self.drain_some();
            check_test_seq(inner.composition_shot.lock().unwrap().as_ref(), current_seq)?;
        }
        let mut cleanup = Ok(());
        let result = match op {
            CompositionOp::On => {
                if !active {
                    self.cohorts.awaiting_quiet_queue = true;
                    self.next_poll = Instant::now();
                }
                inner.composition_mode.store(true, Ordering::SeqCst);
                None
            }
            CompositionOp::Off | CompositionOp::Discard(_) => {
                inner.composition_shot.lock().unwrap().take();
                self.cohorts.latest_test = None;
                if off {
                    inner.composition_mode.store(false, Ordering::SeqCst);
                }
                cleanup = clean_composition(&self.inner.data_dir, &binding.root);
                None
            }
            CompositionOp::Keep(_, force_single) => {
                let (promotion, single) = {
                    let slot = inner.composition_shot.lock().unwrap();
                    let shot = slot.as_ref().ok_or_else(|| {
                        TetherError::new("NO_SHOT", "There is no test shot to keep.")
                    })?;
                    shot.check_keep(force_single)?;
                    (KeepPromotion::from_shot(shot), !shot.pair_complete())
                };
                let target = tauri::async_runtime::block_on(node(
                    &inner.app,
                    "tether-journal",
                    json!([binding.shoot_id, "destination", {}]),
                ))?;
                let promotion = KeepPromotion {
                    target,
                    ..promotion
                }
                .record(&inner.data_dir, &binding.root)?;
                if let Some(cohort) = self.cohorts.latest_test.clone().filter(|_| single) {
                    if !self.cohorts.kept_single.contains(&cohort) {
                        self.cohorts.kept_single.push_back(cohort);
                        if self.cohorts.kept_single.len() > MAX_OUTSTANDING {
                            self.cohorts.kept_single.pop_front();
                        }
                    }
                }
                let mut result =
                    tauri::async_runtime::block_on(keep_composition(&inner, &binding, &promotion))?;
                result["testSeq"] = json!(current_seq);
                self.cohorts.latest_test = None;
                inner.composition_shot.lock().unwrap().take();
                Some(result)
            }
        };
        let active = inner.composition_mode.load(Ordering::SeqCst);
        let slot = inner.composition_shot.lock().unwrap();
        let payload = composition_payload(&binding.shoot_id, active, slot.as_ref());
        emit(&inner.app, "tether-composition", payload.clone());
        cleanup?;
        if off {
            return Ok(json!({ "active": false, "hasShot": false }));
        }
        Ok(result.unwrap_or_else(|| {
            json!({
                "active": active, "hasShot": slot.is_some(), "testSeq": current_seq.unwrap_or(0),
            })
        }))
    }

    fn refresh_capture_pending(&mut self) -> TResult<bool> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(TetherError::stale_session)?;
        match session.refresh_capture_pending() {
            Ok(pending) => Ok(pending),
            Err(e) => {
                let mapped = TetherError::from_session(e_clone(&e));
                self.handle_session_error(e);
                Err(mapped)
            }
        }
    }

    fn drain_some(&mut self) {
        let Some(binding) = self.binding() else {
            return;
        };
        for _ in 0..4 {
            prune_pending(&mut self.pending, &mut self.inner.timed_out.lock().unwrap());
            if self.draining_held() {
                return;
            }
            let Some(session) = self.session.as_mut() else {
                return;
            };
            let generation = session.transport().generation();
            let usb = session.transport().is_usb();
            let mut ctx = DrainCtx {
                app: self.inner.app.clone(),
                binding: binding.clone(),
                cohort: self.inner.cohort.clone(),
                epoch: self.epoch,
                device: self.device.clone().unwrap_or_default(),
                snapshot: session.exposure_snapshot(),
                roles: session.expected_host_roles(),
                request: self.pending.front().map(|(id, _)| id.clone()),
                plan: RefCell::new(None),
                failure: RefCell::new(None),
                accepted: RefCell::new(None),
            };
            // An orphan left by any other transaction is not this member's photo.
            drop(session.transport_mut().take_orphan());
            self.inner.receiving.fetch_add(1, Ordering::SeqCst);
            let started = Instant::now();
            let active = self.inner.composition_mode.load(Ordering::SeqCst);
            let mut test = None;
            let mut test_plan = None;
            let mut test_error = None;
            let mut regular = None;
            let result = session.drain_one(|info, kind| {
                let cohort = CompositionCohort::new(self.epoch, info, kind);
                let Some(disposition) = self.cohorts.test_disposition(&cohort, active) else {
                    if self.cohorts.kept_single.contains(&cohort) {
                        ctx.roles = None;
                        ctx.request = None;
                    }
                    regular = Some(cohort);
                    return ctx.open(info, kind);
                };
                let TestDisposition { new_shot, discard } = disposition;
                test = Some((cohort, disposition));
                if discard || !matches!(kind, FileKind::Raw | FileKind::Jpeg) {
                    return Ok(MemberSink::Discard);
                }
                match open_test_member(&self.inner, &binding, info, kind, !new_shot) {
                    Ok(Some((plan, writer))) => {
                        test_plan = Some(plan);
                        Ok(MemberSink::Stage(writer))
                    }
                    Ok(None) => Ok(MemberSink::Discard),
                    Err(e) => {
                        let message = e.message.clone();
                        test_error = Some(e);
                        Err(io::Error::other(message))
                    }
                }
            });
            self.inner.receiving.fetch_sub(1, Ordering::SeqCst);
            let orphan = session.transport_mut().take_orphan();
            if let Some((cohort, TestDisposition { new_shot, discard })) = test {
                match result {
                    Ok(DrainStep::Object(object, sink)) => {
                        if new_shot {
                            self.cohorts.pending_test = None;
                        }
                        if let (Some(plan), MemberSink::Stage(writer)) = (test_plan, sink) {
                            let shot =
                                camera_snapshot(&ctx.device, &ctx.snapshot, Some(&object.info));
                            match store_test_member(
                                &self.inner,
                                &binding,
                                plan,
                                writer,
                                shot,
                                session.expected_host_roles(),
                            ) {
                                Ok(()) => {
                                    if new_shot {
                                        self.cohorts.remember_test(cohort.clone());
                                    }
                                    self.cohorts.latest_test = Some(cohort);
                                    self.issue_open = None;
                                }
                                Err(e) => self.emit_issue(&e.code, &e.message, e.retryable),
                            }
                        } else if !discard && !matches!(object.kind, FileKind::Raw | FileKind::Jpeg)
                        {
                            self.emit_issue(
                                "INVALID_FORMAT",
                                "Composition Mode accepts RAW and JPEG test shots.",
                                false,
                            );
                        }
                    }
                    Ok(DrainStep::Short { .. }) => {
                        if new_shot {
                            self.cohorts.pending_test = None;
                        }
                        self.emit_issue(
                            "INCOMPLETE",
                            "The camera sent an incomplete test shot.",
                            true,
                        );
                    }
                    Err(e) => {
                        let error = match test_error {
                            Some(e) => e,
                            None => {
                                let error = TetherError::from_session(e_clone(&e));
                                if self.handle_session_error(e) {
                                    return;
                                }
                                error
                            }
                        };
                        self.emit_issue(&error.code, &error.message, error.retryable);
                        self.drain_blocked_until = Some(Instant::now() + Duration::from_secs(3));
                        return;
                    }
                    _ => return,
                }
                continue;
            }
            if matches!(&result, Ok(DrainStep::Object(..) | DrainStep::Short { .. })) {
                self.cohorts.last_regular = regular;
            }
            if let Some((exposure_id, Some(bound))) = ctx.accepted.borrow().clone() {
                // Only the request Node bound to a fresh exposure is answered.
                self.pending.retain(|(id, _)| *id != bound);
                if let Some(tx) = self.inner.confirmations.lock().unwrap().remove(&bound) {
                    let _ = tx.send(exposure_id);
                }
            }
            let plan = ctx.plan.borrow().clone();
            match result {
                Ok(DrainStep::Object(object, sink)) => {
                    crate::logs::write(&format!(
                        "tether drained {:?} {} ({} bytes)",
                        object.kind, object.info.filename, object.bytes
                    ));
                    let Some(plan) = plan else { continue };
                    let seconds = started.elapsed().as_secs_f64().max(1e-3);
                    let mbps = object.bytes as f64 / 1_000_000.0 / seconds;
                    let shot = camera_snapshot(&ctx.device, &ctx.snapshot, Some(&object.info));
                    self.issue_open = None;
                    let (receipt, stage) = match sink {
                        MemberSink::Stage(writer) => {
                            let path = writer.path().to_path_buf();
                            match writer.finish() {
                                Ok(r) => (Some(r), path),
                                Err(e) => {
                                    let e = TetherError::from_transfer(e);
                                    journal_issue(
                                        &self.inner.app,
                                        &binding.shoot_id,
                                        &plan.member_id,
                                        &e,
                                    );
                                    self.hold_draining(&e.code, &e.message);
                                    return;
                                }
                            }
                        }
                        MemberSink::Discard => (None, PathBuf::new()),
                    };
                    self.emit_transfer(&plan, "staged", object.bytes, Some(mbps));
                    let Some(receipt) = receipt else { continue };
                    if plan.status != "held" {
                        // Checked before the member is journaled as staged, so no retry can
                        // publish a file that is not the image its name promises.
                        if let Err(e) = transfer::validate_staged_signature(&stage, &plan.name) {
                            let e = TetherError::from_transfer(e);
                            journal_issue(&self.inner.app, &binding.shoot_id, &plan.member_id, &e);
                            continue;
                        }
                    }
                    // Durable before publication: a crash from here on resumes from the stage
                    // file instead of asking the camera again.
                    journal_staged(&self.inner.app, &binding.shoot_id, &plan, &receipt, &shot);
                    if plan.status == "held" {
                        continue;
                    }
                    spawn_publish(
                        self.inner.clone(),
                        binding.clone(),
                        plan,
                        receipt,
                        shot,
                        self.epoch,
                    );
                }
                Ok(DrainStep::Short {
                    object,
                    sink,
                    expected,
                }) => {
                    let message = if object.bytes > expected {
                        format!(
                            "The camera sent {} bytes of {}, more than the {expected} it declared. The file is kept in staging for inspection.",
                            object.bytes, object.info.filename
                        )
                    } else {
                        format!(
                            "The camera sent {} of {expected} bytes of {}. The partial file is kept in staging; import the photo from the card if it was saved there.",
                            object.bytes, object.info.filename
                        )
                    };
                    if let MemberSink::Stage(writer) = sink {
                        let _ = writer.finish();
                    }
                    if let Some(plan) = &plan {
                        let e = TetherError::new("INCOMPLETE", message.clone());
                        journal_issue(&self.inner.app, &binding.shoot_id, &plan.member_id, &e);
                    }
                    self.emit_issue("INCOMPLETE", &message, true);
                }
                Ok(DrainStep::Empty) | Ok(DrainStep::Pending) => return,
                Ok(DrainStep::Stalled) => {
                    self.emit_issue(
                        "INCOMPLETE",
                        "The camera reports a photo that it has not made ready. Check the camera.",
                        true,
                    );
                    self.drain_blocked_until = Some(Instant::now() + Duration::from_secs(5));
                    return;
                }
                Err(e) => {
                    crate::logs::write(&format!("tether drain error: {e}"));
                    let failure = ctx.failure.borrow_mut().take();
                    let mut error =
                        failure.unwrap_or_else(|| TetherError::from_session(e_clone(&e)));
                    // Delivered bytes the disk refused: nothing more leaves the camera until the
                    // photographer has dealt with it.
                    let mut hold = orphan.is_some()
                        && matches!(e, SessionError::Transport(TransportError::Sink(_)));
                    if let (Some(plan), Some(payload)) = (&plan, orphan) {
                        let shot = camera_snapshot(&ctx.device, &ctx.snapshot, None);
                        if retain(&self.inner, &binding, plan, payload, shot, self.epoch) {
                            error.message = format!(
                                "{} The photo is held in memory; choose Retry once the problem is fixed, and keep PhotoCull open until it is saved.",
                                error.message
                            );
                        } else {
                            hold = true;
                            error.message = format!(
                                "{} PhotoCull could not keep another photo in memory; import it from the card if it was saved there.",
                                error.message
                            );
                        }
                    }
                    if let Some(plan) = &plan {
                        let code = if matches!(e, SessionError::Removed { .. }) {
                            TetherError::new("CAMERA_LOST", "The camera disconnected while sending this photo. If it was saved to the card, import it from there.")
                        } else {
                            error.clone()
                        };
                        journal_issue(&self.inner.app, &binding.shoot_id, &plan.member_id, &code);
                        if usb && matches!(e, SessionError::Transport(TransportError::TimedOut)) {
                            // ImageCaptureCore may still complete this read; its bytes go here.
                            self.late_claims.insert(
                                generation,
                                LateClaim {
                                    binding: binding.clone(),
                                    plan: plan.clone(),
                                    shot: camera_snapshot(&ctx.device, &ctx.snapshot, None),
                                    epoch: self.epoch,
                                },
                            );
                        }
                    }
                    if self.handle_session_error(e) {
                        return;
                    }
                    if hold {
                        let code = if error.code == "NO_SPACE" {
                            "NO_SPACE"
                        } else {
                            "IO_ERROR"
                        };
                        self.hold_draining(code, &error.message);
                        return;
                    }
                    let backoff = if error.code == "NO_SPACE" { 15 } else { 3 };
                    self.drain_blocked_until = Some(Instant::now() + Duration::from_secs(backoff));
                    let message = error.message.clone();
                    self.emit_issue(&error.code, &message, true);
                    return;
                }
            }
        }
    }

    /// Stops taking photos from the camera until the photographer retries; they stay on the body.
    fn hold_draining(&mut self, code: &str, message: &str) {
        *self.inner.drain_hold.lock().unwrap() = Some(code.to_string());
        self.emit_issue(
            code,
            &format!("{message} New photos stay on the camera until you choose Retry."),
            true,
        );
    }

    fn draining_held(&mut self) -> bool {
        if self.inner.drain_hold.lock().unwrap().is_some() {
            return true;
        }
        let (count, bytes) = {
            let kept = self.inner.recovery.lock().unwrap();
            (
                kept.len(),
                kept.values().map(|r| r.payload.bytes().len()).sum(),
            )
        };
        if recovery_full(count, bytes) {
            self.hold_draining(
                "IO_ERROR",
                "PhotoCull is holding as many unsaved photos in memory as it can. Save them first.",
            );
            return true;
        }
        false
    }

    /// Stores GetObject payloads that ImageCaptureCore completed after their timeout.
    fn store_late_objects(&mut self) {
        self.late_backlog.extend(icc::take_late_objects());
        if self.late_backlog.is_empty() || Instant::now() < self.late_retry_at {
            return;
        }
        for late in std::mem::take(&mut self.late_backlog) {
            if let Err((late, e)) = self.store_late(late) {
                self.late_backlog.push(late);
                self.late_retry_at = Instant::now() + Duration::from_secs(5);
                let message = format!(
                    "{} A photo that arrived late is held in memory until it can be saved; keep PhotoCull open.",
                    e.message
                );
                self.hold_draining(&e.code, &message);
            }
        }
    }

    /// Durable first: the payload is on disk before any journal or publication step.
    fn store_late(
        &mut self,
        late: icc::LateObject,
    ) -> std::result::Result<(), (icc::LateObject, TetherError)> {
        let capture = protocol::ptp::holds_captured_photo(
            late.opcode,
            &[late.param1],
            protocol::ptp::resp::OK,
        );
        let claim = capture
            .then(|| self.late_claims.remove(&late.generation))
            .flatten();
        let Some(claim) = claim else {
            let root = self
                .binding()
                .map(|b| b.root)
                .unwrap_or_else(|| self.inner.data_dir.clone());
            let rel = format!(
                "{}/recovered-{}.part",
                transfer::STAGE_DIR,
                unique_suffix(late.generation)
            );
            let stored = transfer::stage_path(&root, &rel).and_then(|path| {
                transfer::stage_complete(path.clone(), late.payload.bytes()).map(|_| path)
            });
            return match stored {
                Ok(path) => {
                    self.emit_issue(
                        "INCOMPLETE",
                        &format!(
                            "A photo arrived after the camera stopped answering and was saved as {}. Import it from there.",
                            path.display()
                        ),
                        false,
                    );
                    Ok(())
                }
                Err(e) => Err((late, TetherError::from_transfer(e))),
            };
        };
        let stored =
            transfer::stage_path(&claim.binding.root, &claim.plan.stage_rel).and_then(|path| {
                transfer::stage_complete(path.clone(), late.payload.bytes()).map(|r| (path, r))
            });
        let (path, receipt) = match stored {
            Ok(stored) => stored,
            Err(e) => {
                self.late_claims.insert(late.generation, claim);
                return Err((late, TetherError::from_transfer(e)));
            }
        };
        drop(late);
        let LateClaim {
            binding,
            plan,
            shot,
            epoch,
        } = claim;
        let app = self.inner.app.clone();
        if let Err(e) = transfer::validate_staged_signature(&path, &plan.name) {
            journal_issue(
                &app,
                &binding.shoot_id,
                &plan.member_id,
                &TetherError::from_transfer(e),
            );
            return Ok(());
        }
        journal_staged(&app, &binding.shoot_id, &plan, &receipt, &shot);
        // The timeout put this member on hold; complete now, it goes out as usual.
        let retried = node_blocking(
            &app,
            "tether-journal",
            json!([binding.shoot_id, "recovery", { "action": "retry", "memberId": plan.member_id }]),
        );
        let staged = retried.is_ok_and(|r| {
            r["records"].as_array().is_some_and(|records| {
                records.iter().any(|m| {
                    m["memberId"].as_str() == Some(&plan.member_id)
                        && m["state"].as_str() == Some("staged")
                })
            })
        });
        if staged {
            spawn_publish(self.inner.clone(), binding, plan, receipt, shot, epoch);
        } else {
            let e = TetherError::new(
                "INCOMPLETE",
                format!(
                    "{} arrived after the camera stopped answering and is saved in staging. Choose Retry to add it.",
                    plan.name
                ),
            );
            journal_issue(&app, &binding.shoot_id, &plan.member_id, &e);
        }
        Ok(())
    }

    fn emit_transfer(&self, plan: &MemberPlan, phase: &str, bytes: u64, mbps: Option<f64>) {
        emit_transfer(
            &self.inner,
            self.shoot_id.as_deref(),
            self.epoch,
            Some(&plan.exposure_id),
            Some(&plan.member_id),
            phase,
            bytes,
            plan.declared,
            mbps,
        );
    }

    fn preflight(&mut self) -> TResult<()> {
        if self.paused {
            return Err(TetherError::new(
                "CONTROL_LOCKED",
                "Tether is paused. Resume to shoot from the computer.",
            ));
        }
        let binding = self.binding().ok_or_else(TetherError::stale_session)?;
        if let Some(code) = self.inner.drain_hold.lock().unwrap().clone() {
            return Err(TetherError::new(
                &code,
                "Saving photos is paused. Choose Retry on the photo that could not be saved first.",
            ));
        }
        if self.drain_blocked_until.is_some_and(|t| Instant::now() < t) {
            if let Some(issue) = &self.issue_open {
                if issue.starts_with("NO_SPACE") {
                    return Err(TetherError::new("NO_SPACE", "The capture disk is full."));
                }
            }
        }
        if let Ok(free) = transfer::free_space(&binding.root) {
            if !transfer::has_room(free, DEFAULT_OBJECT_BUDGET) {
                return Err(TetherError::new(
                    "NO_SPACE",
                    "The capture disk is almost full. Free space or choose another folder.",
                ));
            }
        }
        prune_pending(&mut self.pending, &mut self.inner.timed_out.lock().unwrap());
        let waiting = {
            let waiters = self.inner.confirmations.lock().unwrap();
            self.pending.iter().any(|(id, _)| waiters.contains_key(id))
        };
        if waiting {
            return Err(TetherError::new(
                "CAMERA_BUSY",
                "Waiting for the previous photo to arrive from the camera.",
            ));
        }
        self.cohorts.expire_test();
        if self.cohorts.pending_test.is_some() {
            return Err(TetherError::new(
                "CAMERA_BUSY",
                "Waiting for the test shot to arrive from the camera.",
            ));
        }
        if self.inner.outstanding.load(Ordering::SeqCst) >= MAX_OUTSTANDING {
            return Err(TetherError::new(
                "CAMERA_BUSY",
                "Waiting for earlier photos to finish saving.",
            ));
        }
        let session = self.ready_session()?;
        if let Some(cap) = session.actions().into_iter().find(|a| a.key == "trigger") {
            if !cap.available {
                return Err(TetherError::new(
                    "CONTROL_LOCKED",
                    cap.reason
                        .unwrap_or_else(|| "The camera cannot release now.".into()),
                ));
            }
        }
        Ok(())
    }

    fn trigger(&mut self, request_id: Option<String>) -> TResult<CaptureOutcome> {
        self.preflight()?;
        self.inner.cancel.store(false, Ordering::SeqCst);
        let inner = self.inner.clone();
        if request_id.is_none() && self.cohorts.awaiting_quiet_queue {
            let pending = self.refresh_capture_pending()?;
            self.cohorts.check_transition(pending, false)?;
            self.cohorts.awaiting_quiet_queue = false;
        }
        let session = self.ready_session()?;
        let options = CaptureOptions {
            wait_for_focus: session.should_wait_for_focus(),
        };
        match session.capture(options, &inner.cancel) {
            Ok(CaptureOutcome::Released) => {
                // Older requests nobody waits for any more were resolved as unknown; a newer
                // shutter release never lets them claim its photo.
                {
                    let waiters = self.inner.confirmations.lock().unwrap();
                    self.pending.retain(|(id, _)| waiters.contains_key(id));
                }
                if let Some(request_id) = request_id {
                    self.pending.push_back((request_id, Instant::now()));
                } else {
                    self.cohorts.pending_test = Some(Instant::now());
                }
                self.next_poll = Instant::now();
                Ok(CaptureOutcome::Released)
            }
            Ok(outcome) => Ok(outcome),
            Err(e) => {
                let mut mapped = TetherError::from_session(e_clone(&e));
                mapped.uncertain = matches!(
                    e,
                    SessionError::Removed {
                        shutter_uncertain: true
                    }
                );

                self.handle_session_error(e);
                Err(mapped)
            }
        }
    }

    fn fel(&mut self) -> TResult<Value> {
        let inner = self.inner.clone();
        inner.cancel.store(false, Ordering::SeqCst);
        let session = self.ready_session()?;
        if let Err(e) = session.pulse_fel(&inner.cancel) {
            let mapped = TetherError::from_session(e_clone(&e));
            self.handle_session_error(e);
            return Err(mapped);
        }
        let props = session.camera_properties();
        let state = props
            .iter()
            .find(|p| p.key == "felState")
            .map(|p| p.display.as_str());
        self.emit_properties(true);
        Ok(json!({ "felState": state, "properties": Self::properties_json(&props) }))
    }

    fn set_property(&mut self, key: &str, value: &SetValue, rev: u64) -> TResult<Value> {
        let session = self.ready_session()?;
        let code = session.code_for_key(key).ok_or_else(|| {
            TetherError::new("UNSUPPORTED", "The camera does not report this setting.").field("key")
        })?;
        let prop = session
            .camera_properties()
            .into_iter()
            .find(|p| p.code == code);
        let value = wire_value(prop.as_ref(), value)?;
        match session.set_property(code, &value, Some(rev)) {
            Ok(changed) => {
                let props = session.camera_properties();
                let mut keys: Vec<u16> = changed;
                keys.push(code);
                let out: Vec<Value> = props
                    .iter()
                    .filter(|p| keys.contains(&p.code))
                    .map(property_json)
                    .collect();
                let rev = session.prop_rev();
                self.emit_property_changes();
                Ok(json!({ "properties": out, "propRev": rev }))
            }
            Err(e) => {
                let mapped = TetherError::from_session(e_clone(&e));
                if !self.handle_session_error(e) {
                    if let Some(s) = self.session.as_mut() {
                        let _ = s.refresh_properties();
                    }
                    self.emit_property_changes();
                }
                Err(mapped)
            }
        }
    }

    fn focus(&mut self, op: FocusOp) -> TResult<Value> {
        let result = {
            let session = self.ready_session()?;
            match op {
                FocusOp::Press(hold) => session.half_press(&hold).map(|_| true),
                FocusOp::Release(hold) => session.half_release(hold.as_deref()).map(|_| true),
                FocusOp::Step { near, size } => session.focus_step(near, size).map(|_| true),
                FocusOp::Pulse => {
                    let held = session.half_press_hold().is_some();
                    if held {
                        Ok(true)
                    } else {
                        let r = session.half_press("pulse");
                        if r.is_ok() {
                            let deadline = Instant::now() + Duration::from_secs(1);
                            while Instant::now() < deadline {
                                if session.refresh_properties().is_err() {
                                    break;
                                }
                                match session.focus_indication() {
                                    Some(f) if f.is_focused() || f.is_unfocused() => break,
                                    _ => std::thread::sleep(Duration::from_millis(50)),
                                }
                            }
                            let _ = session.half_release(Some("pulse"));
                        }
                        r.map(|_| true)
                    }
                }
            }
        };
        match result {
            Ok(_) => {
                let session = self.session.as_ref().expect("connected session");
                let active = session.half_press_hold().is_some();
                self.half_press_since = if active {
                    self.half_press_since.or(Some(Instant::now()))
                } else {
                    None
                };
                Ok(json!({
                    "active": active,
                    "focusStatus": session.focus_indication().map(|f| f.status()),
                }))
            }
            Err(e) => {
                let mapped = TetherError::from_session(e_clone(&e));
                self.handle_session_error(e);
                Err(mapped)
            }
        }
    }

    fn start_live(&mut self) -> TResult<Value> {
        if self.paused {
            return Err(TetherError::new(
                "CONTROL_LOCKED",
                "Tether is paused. Resume to use Live View.",
            ));
        }
        if self.live_on {
            if let Some((stream, _)) = self.inner.live.stream() {
                return Ok(json!({ "streamId": stream, "state": "streaming" }));
            }
        }
        let epoch = self.epoch;
        let session = self.ready_session()?;
        if let Err(e) = session.start_live_view() {
            let mapped = TetherError::from_session(e_clone(&e));
            self.handle_session_error(e);
            return Err(mapped);
        }
        let stream = self.inner.live.open(epoch);
        self.live_on = true;
        self.next_live = Instant::now();
        self.next_stats = Instant::now() + Duration::from_secs(2);
        emit(
            &self.inner.app,
            "tether-live-state",
            json!({ "v": 1, "shootId": self.shoot_id, "epoch": epoch, "streamId": stream, "state": "streaming" }),
        );
        Ok(json!({ "streamId": stream, "state": "streaming" }))
    }

    fn stop_live(&mut self, reason: Option<String>) {
        if !self.live_on {
            return;
        }
        self.live_on = false;
        if let Some(s) = self.session.as_mut() {
            s.stop_live_view();
        }
        self.inner.live.close();
        emit(
            &self.inner.app,
            "tether-live-state",
            json!({ "v": 1, "shootId": self.shoot_id, "epoch": self.epoch, "streamId": null, "state": "off", "reason": reason }),
        );
    }

    fn fetch_live(&mut self) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        let started = Instant::now();
        match session.fetch_live_frame() {
            Ok(Some(frame)) => {
                let _ = self.inner.live.publish(
                    self.epoch,
                    frame.width as u32,
                    frame.height as u32,
                    1,
                    frame.jpeg,
                );
                let spent = started.elapsed();
                self.next_live = Instant::now() + Duration::from_millis(33).saturating_sub(spent);
            }
            Ok(None) => self.next_live = Instant::now() + Duration::from_millis(30),
            Err(e) => {
                let message = e_text(&e);
                if !self.handle_session_error(e) {
                    self.want_live = false;
                    self.stop_live(Some(message));
                }
            }
        }
    }
}

/// The command still targets the bound shoot and, when it names one, the actor's current
/// connection.
fn check_stamp(
    stamp: &Stamp,
    bound_shoot: Option<&str>,
    actor_shoot: Option<&str>,
    epoch: u64,
) -> TResult<()> {
    if bound_shoot != Some(stamp.shoot_id.as_str()) {
        return Err(TetherError::stale_session());
    }
    match stamp.epoch {
        Some(e) if e != epoch || actor_shoot != Some(stamp.shoot_id.as_str()) => {
            Err(TetherError::new(
                "STALE_SESSION",
                "The camera reconnected. Refresh and try again.",
            ))
        }
        _ => Ok(()),
    }
}

fn auto_reconnect_enabled(settings: &Value) -> bool {
    settings["tether"]["autoReconnect"].as_bool() != Some(false)
}

/// Whether a reopened body is the one the shoot was using. Without a serial number only the very
/// same ImageCaptureCore device and model count.
fn same_body(previous: &DeviceDesc, device_id: &str, model: &str, serial: &str) -> bool {
    if previous.serial.is_empty() {
        previous.device_id == device_id && previous.model == model.trim()
    } else {
        previous.serial == serial.trim()
    }
}

/// Whether a reopened Wi-Fi camera is the one the shoot was using: the same PTP/IP responder
/// GUID and model, and the same serial when both report one. An address alone proves nothing.
fn same_wifi_body(
    previous: &DeviceDesc,
    model: &str,
    serial: &str,
    responder_guid: Option<[u8; 16]>,
) -> bool {
    let serial = serial.trim();
    previous
        .route
        .as_ref()
        .is_some_and(|r| r.same_body(model, responder_guid))
        && (previous.serial.is_empty() || serial.is_empty() || previous.serial == serial)
}

/// A stable name for one camera body, saved with a stopped shoot so resuming reattaches only
/// that body: its serial number, else its PTP/IP responder GUID. Neither means no proof.
fn body_key(model: &str, serial: &str, responder_guid: Option<[u8; 16]>) -> Option<String> {
    let (model, serial) = (model.trim(), serial.trim());
    let id = if !serial.is_empty() {
        format!("serial:{serial}")
    } else {
        format!("guid:{}", transfer::hex(&responder_guid?))
    };
    let hash = transfer::Sha256::digest(format!("photocull-camera:{model}:{id}").as_bytes());
    Some(transfer::hex(&hash)[..32].to_string())
}

/// The body a resumed shoot expects; any other camera is refused rather than adopted.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedBody {
    device_id: String,
    model: String,
    body_key: Option<String>,
}

impl ExpectedBody {
    fn matches(&self, device_id: &str, model: &str, body_key: Option<&str>) -> bool {
        match (self.body_key.as_deref(), body_key) {
            (Some(expected), Some(found)) => expected == found,
            (None, None) => self.device_id == device_id && self.model == model.trim(),
            _ => false,
        }
    }
}

/// The camera the actor still holds, unless its link is closed.
fn held_device(snapshot: &Value) -> Option<String> {
    (snapshot["connection"]["state"] != "offline")
        .then(|| snapshot["device"]["deviceId"].as_str().map(String::from))
        .flatten()
}

/// The camera to remember with a stopping shoot: only one attached during that shoot.
fn attached_camera(snapshot: &Value, shoot_id: &str) -> Value {
    if snapshot["shootId"] == shoot_id {
        snapshot["device"].clone()
    } else {
        Value::Null
    }
}

/// The device to reopen after a loss. Another Sony body is only a candidate when its serial
/// number can be checked after opening.
fn reconnect_target(device: &DeviceDesc, candidates: &[IccDevice]) -> Option<String> {
    if let Some(d) = candidates.iter().find(|d| d.id == device.device_id) {
        return Some(d.id.clone());
    }
    if device.serial.is_empty() {
        return None;
    }
    let sony: Vec<&IccDevice> = candidates
        .iter()
        .filter(|d| d.usb_vendor_id == icc::SONY_USB_VENDOR || d.name.contains(&device.model))
        .collect();
    (sony.len() == 1).then(|| sony[0].id.clone())
}

/// The string the session understands for a panel value: numbers are steps for detent
/// controls and plain values for ranges; lists take only their choice IDs.
fn wire_value(prop: Option<&CameraProperty>, value: &SetValue) -> TResult<String> {
    let invalid = || TetherError::new("UNSUPPORTED", "Invalid setting value.").field("value");
    let n = match value {
        SetValue::Text(s) => return Ok(s.clone()),
        SetValue::Number(n) => *n,
    };
    if !n.is_finite() || n.fract() != 0.0 || n.abs() > 1e12 {
        return Err(invalid());
    }
    let n = n as i64;
    match prop {
        Some(p) if p.relative => {
            if n == 0 {
                Err(invalid())
            } else {
                Ok(format!("{n:+}"))
            }
        }
        Some(p) if p.kind == PropertyKind::Range => Ok(n.to_string()),
        _ => Err(TetherError::new(
            "UNSUPPORTED",
            "Choose one of the camera's values for this setting.",
        )
        .field("value")),
    }
}

/// `SessionError` is not `Clone`; this keeps the mapped meaning for replies.
fn e_clone(e: &SessionError) -> SessionError {
    use SessionError as S;
    match e {
        S::Transport(t) => S::Transport(match t {
            TransportError::Removed => TransportError::Removed,
            TransportError::InUse => TransportError::InUse,
            TransportError::Permission => TransportError::Permission,
            TransportError::TimedOut => TransportError::TimedOut,
            TransportError::Limit => TransportError::Limit,
            other => TransportError::native(other.to_string()),
        }),
        S::Response { opcode, code } => S::Response {
            opcode: *opcode,
            code: *code,
        },
        S::Removed { shutter_uncertain } => S::Removed {
            shutter_uncertain: *shutter_uncertain,
        },
        S::SessionLost => S::SessionLost,
        S::StaleRevision { current } => S::StaleRevision { current: *current },
        S::Locked(m) => S::Locked(m.clone()),
        S::Unsupported(m) => S::Unsupported(m.clone()),
        S::InvalidValue(m) => S::InvalidValue(m.clone()),
        S::NotApplied(m) => S::NotApplied(m.clone()),
        S::Cancelled => S::Cancelled,
        S::QueueFault(m) => S::QueueFault(m.clone()),
        S::Incomplete { expected, received } => S::Incomplete {
            expected: *expected,
            received: *received,
        },
        S::LiveViewUnavailable(m) => S::LiveViewUnavailable(m.clone()),
        S::NotSonyRemote(m) => S::NotSonyRemote(m.clone()),
        S::Negotiation(m) => S::Negotiation(m.clone()),
        S::Protocol(p) => S::Negotiation(p.to_string()),
    }
}

fn property_json(p: &CameraProperty) -> Value {
    let value = match p.number {
        Some(n) => Value::from(n),
        None => json!(p.value),
    };
    let mut v = json!({
        "key": p.key,
        "label": p.label,
        "kind": p.kind.as_str(),
        "value": value,
        "display": p.display,
        "access": p.access.as_str(),
        "propRev": p.prop_rev,
    });
    if !p.choices.is_empty() {
        v["choices"] = p
            .choices
            .iter()
            .map(|c| json!({ "id": c.id, "label": c.label }))
            .collect();
    }
    if let Some(r) = &p.range {
        v["range"] = json!({ "min": r.min, "max": r.max, "step": r.step, "unit": r.unit });
    }
    if let Some(reason) = &p.reason {
        v["reason"] = reason.clone().into();
    }
    if p.relative {
        v["relative"] = true.into();
        // Without choices the only writes are inc/dec or a signed step.
        v["stepOnly"] = p.choices.is_empty().into();
    }
    v
}

fn action_json(a: &ActionCap) -> Value {
    json!({ "key": a.key, "available": a.available, "reason": a.reason })
}

#[allow(clippy::too_many_arguments)]
fn emit_transfer(
    inner: &Inner,
    shoot_id: Option<&str>,
    epoch: u64,
    exposure_id: Option<&str>,
    member_id: Option<&str>,
    phase: &str,
    bytes: u64,
    total: Option<u64>,
    mbps: Option<f64>,
) {
    let seq = inner.transfer_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let root = inner
        .binding
        .lock()
        .unwrap()
        .as_ref()
        .map(|b| b.root.clone());
    let free = root.and_then(|r| transfer::free_space(&r).ok());
    emit(
        &inner.app,
        "tether-transfer",
        json!({
            "v": 1,
            "shootId": shoot_id,
            "epoch": epoch,
            "seq": seq,
            "exposureId": exposure_id,
            "memberId": member_id,
            "phase": phase,
            "bytes": bytes,
            "total": total,
            "queued": inner.outstanding.load(Ordering::SeqCst),
            "receiving": inner.receiving.load(Ordering::SeqCst),
            "mbps": mbps.map(|m| (m * 10.0).round() / 10.0),
            "freeBytes": free,
        }),
    );
}

fn journal_issue(app: &AppHandle, shoot_id: &str, member_id: &str, e: &TetherError) {
    if e.journaled {
        return;
    }
    let _ = node_blocking(
        app,
        "tether-journal",
        json!([shoot_id, "issue", { "memberId": member_id, "code": journal_code(&e.code), "message": e.message, "retryable": e.retryable }]),
    );
}

fn journal_staged(
    app: &AppHandle,
    shoot_id: &str,
    plan: &MemberPlan,
    receipt: &StageReceipt,
    shot: &Value,
) {
    let detail = staged_detail(plan, receipt, shot);
    if let Err(e) = node_blocking(app, "tether-journal", json!([shoot_id, "staged", detail])) {
        crate::logs::write(&format!("tether staged journal {}: {}", e.code, e.message));
    }
}

fn staged_detail(plan: &MemberPlan, receipt: &StageReceipt, shot: &Value) -> Value {
    json!({
        "memberId": plan.member_id,
        "bytes": receipt.bytes,
        "sha256": receipt.sha256,
        "stageRelPath": plan.stage_rel,
        "shot": shot,
    })
}

/// Keeps a photo the disk refused, within a fixed memory budget. False when it does not fit.
fn retain(
    inner: &Inner,
    binding: &Binding,
    plan: &MemberPlan,
    payload: icc::Orphan,
    shot: Value,
    epoch: u64,
) -> bool {
    let mut kept = inner.recovery.lock().unwrap();
    let used: usize = kept.values().map(|r| r.payload.bytes().len()).sum();
    if payload.bytes().is_empty()
        || kept.len() >= RECOVERY_COUNT
        || used + payload.bytes().len() > RECOVERY_BYTES
    {
        return false;
    }
    kept.insert(
        plan.member_id.clone(),
        Retained {
            shoot_id: binding.shoot_id.clone(),
            exposure_id: plan.exposure_id.clone(),
            plan: plan.clone(),
            payload,
            shot,
            epoch,
        },
    );
    true
}

/// Writes a retained photo to its stage file, replacing the partial bytes of the failed attempt.
fn write_retained(root: &Path, retained: &Retained) -> TResult<StageReceipt> {
    transfer::stage_path(root, &retained.plan.stage_rel)
        .and_then(|path| transfer::stage_complete(path, retained.payload.bytes()))
        .map_err(TetherError::from_transfer)
}

/// Retries a photo held in memory: stage it, record it, then publish as usual. It stays in memory
/// until the stage file is durable.
fn spawn_rewrite(inner: Arc<Inner>, binding: Binding, member_id: String) {
    let retained = {
        let mut kept = inner.recovery.lock().unwrap();
        match kept.remove(&member_id) {
            Some(r) if r.shoot_id == binding.shoot_id => r,
            Some(r) => {
                kept.insert(member_id, r);
                return;
            }
            None => return,
        }
    };
    inner.outstanding.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        rewrite_retained(inner.clone(), binding, member_id, retained).await;
        inner.outstanding.fetch_sub(1, Ordering::SeqCst);
    });
}

async fn rewrite_retained(
    inner: Arc<Inner>,
    binding: Binding,
    member_id: String,
    retained: Retained,
) {
    let root = binding.root.clone();
    let written = tauri::async_runtime::spawn_blocking(move || {
        let result = write_retained(&root, &retained);
        (result, retained)
    })
    .await;
    let Ok((result, retained)) = written else {
        return;
    };
    match result {
        Ok(receipt) => {
            let (app, shoot) = (inner.app.clone(), binding.shoot_id.clone());
            let plan = retained.plan.clone();
            let shot = retained.shot.clone();
            let epoch = retained.epoch;
            let staged = tauri::async_runtime::spawn_blocking({
                let (receipt, shot) = (receipt.clone(), shot.clone());
                move || journal_staged(&app, &shoot, &plan, &receipt, &shot)
            })
            .await;
            if staged.is_err() {
                inner.recovery.lock().unwrap().insert(member_id, retained);
                return;
            }
            let plan = retained.plan.clone();
            drop(retained);
            spawn_publish(inner, binding, plan, receipt, shot, epoch);
        }
        Err(e) => {
            *inner.drain_hold.lock().unwrap() = Some(e.code.clone());
            let message = format!("{} The photo is still held in memory.", e.message);
            inner
                .recovery
                .lock()
                .unwrap()
                .insert(member_id.clone(), retained);
            let _ = node(
                &inner.app,
                "tether-journal",
                json!([binding.shoot_id, "issue", { "memberId": member_id, "code": journal_code(&e.code), "message": message, "retryable": true }]),
            )
            .await;
        }
    }
}

fn spawn_publish(
    inner: Arc<Inner>,
    binding: Binding,
    plan: MemberPlan,
    receipt: StageReceipt,
    shot: Value,
    epoch: u64,
) {
    inner.outstanding.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let _guard = inner.publish_lock.lock().await;
        let result = publish(
            &inner,
            &binding,
            &plan.member_id,
            &plan.name,
            &plan.stage_rel,
            receipt,
            shot,
        )
        .await;
        inner.outstanding.fetch_sub(1, Ordering::SeqCst);
        match result {
            Ok(_) => emit_transfer(
                &inner,
                Some(&binding.shoot_id),
                epoch,
                Some(&plan.exposure_id),
                Some(&plan.member_id),
                "ingested",
                0,
                plan.declared,
                None,
            ),
            Err(e) => {
                crate::logs::write(&format!("tether publish {}: {}", e.code, e.message));
                if !e.journaled {
                    let app = inner.app.clone();
                    let code = e.code.clone();
                    let _ = node(
                        &app,
                        "tether-journal",
                        json!([binding.shoot_id, "issue", { "memberId": plan.member_id, "code": journal_code(&code), "message": e.message, "retryable": e.retryable }]),
                    )
                    .await;
                }
                emit_transfer(
                    &inner,
                    Some(&binding.shoot_id),
                    epoch,
                    Some(&plan.exposure_id),
                    Some(&plan.member_id),
                    "failed",
                    0,
                    plan.declared,
                    None,
                );
            }
        }
    });
}

fn journal_code(code: &str) -> &str {
    match code {
        "CAMERA_LOST" | "IO_ERROR" | "NO_SPACE" | "INCOMPLETE" | "DEST_CHANGED" | "NAME_TAKEN"
        | "UNSUPPORTED" | "INVALID_FORMAT" => code,
        _ => "IO_ERROR",
    }
}

/// Splits Node's `finalRelPath` into a validated folder and a plain file name.
fn final_target(binding: &Binding, final_rel: &str) -> TResult<PathBuf> {
    let (dir, name) = final_rel.rsplit_once('/').unwrap_or(("", final_rel));
    let plain = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.starts_with('.');
    if !plain {
        return Err(TetherError::new(
            "NAME_INVALID",
            "The reserved filename is not valid.",
        ));
    }
    let folder =
        transfer::resolve_dir(&binding.library_root, dir).map_err(TetherError::from_transfer)?;
    Ok(folder.join(name))
}

fn stage_kept_member(root: &Path, rel: &str, member: &CompositionMember) -> TResult<()> {
    let dir = checked_composition_dir(root)?;
    if member.path.parent() != Some(dir.as_path()) {
        return Err(TetherError::new(
            "DEST_CHANGED",
            "The test shot changed folders.",
        ));
    }
    let source = fs::symlink_metadata(&member.path).map_err(composition_io)?;
    if !source.is_file() || source.len() != member.receipt.bytes {
        return Err(TetherError::new(
            "INCOMPLETE",
            "The staged test shot changed.",
        ));
    }
    let stage = transfer::stage_path(root, rel).map_err(TetherError::from_transfer)?;
    match fs::symlink_metadata(&stage) {
        Ok(meta) if meta.is_file() => {
            let (bytes, sha256) = transfer::sha256_file(&stage).map_err(composition_io)?;
            if (StageReceipt { bytes, sha256 }) == member.receipt {
                remove_if_present(&stage.with_extension("copying"))?;
                return transfer::sync_dir(stage.parent().unwrap()).map_err(composition_io);
            }
            return Err(TetherError::new(
                "INCOMPLETE",
                "The capture staging file changed.",
            ));
        }
        Ok(_) => {
            return Err(TetherError::new(
                "DEST_CHANGED",
                "The capture staging file changed.",
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(composition_io(e)),
    }
    let tmp = stage.with_extension("copying");
    remove_if_present(&tmp)?;
    let mut writer = StageWriter::create(tmp.clone(), member.receipt.bytes)
        .map_err(TetherError::from_transfer)?;
    let mut file = fs::File::open(&member.path)
        .map_err(composition_io)?
        .take(member.receipt.bytes + 1);
    io::copy(&mut file, &mut writer).map_err(composition_io)?;
    if writer.finish().map_err(TetherError::from_transfer)? != member.receipt {
        remove_if_present(&tmp)?;
        return Err(TetherError::new(
            "INCOMPLETE",
            "The staged test shot changed.",
        ));
    }
    transfer::publish_no_replace(&tmp, &stage).map_err(TetherError::from_transfer)?;
    transfer::sync_dir(stage.parent().unwrap()).map_err(composition_io)?;
    Ok(())
}

// Kept outside the capture folder so a folder supplied by someone else cannot request a promotion.
fn keep_dir(data: &Path, root: &Path) -> PathBuf {
    let hash = transfer::Sha256::digest(root.as_os_str().as_encoded_bytes());
    data.join("tether-keeps").join(transfer::hex(&hash))
}

fn keep_file(data: &Path, root: &Path, seq: u64) -> PathBuf {
    keep_dir(data, root).join(format!("{seq}.json"))
}

#[derive(Serialize, Deserialize)]
struct KeptMember {
    name: String,
    raw: bool,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
struct KeepPromotion {
    shoot_id: String,
    seq: u64,
    key: String,
    epoch: u64,
    meta: Value,
    members: Vec<KeptMember>,
    /// The shot folder, with its identity, that was current when Keep was chosen.
    #[serde(default)]
    target: Value,
}

impl KeepPromotion {
    fn from_shot(shot: &CompositionShot) -> Self {
        let mut members: Vec<_> = shot
            .members
            .iter()
            .map(|m| KeptMember {
                name: m.name.clone(),
                raw: m.kind == FileKind::Raw,
                bytes: m.receipt.bytes,
                sha256: m.receipt.sha256.clone(),
            })
            .collect();
        members.sort_by_key(|m| !m.raw);
        let mut meta = shot.camera_meta.clone();
        if let Some(fields) = meta.as_object_mut() {
            fields.remove("flash");
        }
        Self {
            shoot_id: shot.shoot_id.clone(),
            seq: shot.test_seq,
            key: shot.promotion_key.clone(),
            epoch: shot.epoch,
            meta,
            members,
            target: Value::Null,
        }
    }

    fn read(path: &Path) -> TResult<Self> {
        let file = fs::File::open(path).map_err(composition_io)?;
        serde_json::from_reader(file.take(64 << 10))
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))
    }

    fn pending(data: &Path, root: &Path) -> TResult<Vec<Self>> {
        let dir = keep_dir(data, root);
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(composition_io(e)),
        };
        let mut pending = Vec::new();
        for entry in entries {
            let path = entry.map_err(composition_io)?.path();
            if path.extension().is_some_and(|e| e == "json") {
                pending.push(Self::read(&path)?);
            }
            if path.extension().is_some_and(|e| e == "tmp") {
                remove_if_present(&path)?;
            }
        }
        pending.sort_by_key(|p| p.seq);
        Ok(pending)
    }

    fn record(self, data: &Path, root: &Path) -> TResult<Self> {
        let path = keep_file(data, root, self.seq);
        if path.try_exists().map_err(composition_io)? {
            let saved = Self::read(&path)?;
            if saved.key != self.key {
                return Err(TetherError::new("STALE_SHOT", "A newer test shot arrived."));
            }
            return Ok(saved);
        }
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir).map_err(composition_io)?;
        let tmp = path.with_extension("tmp");
        let mut file = fs::File::create(&tmp).map_err(composition_io)?;
        serde_json::to_writer(&mut file, &self)
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
        file.sync_all().map_err(composition_io)?;
        drop(file);
        fs::rename(tmp, path.as_path()).map_err(composition_io)?;
        for parent in [dir, dir.parent().unwrap(), data] {
            transfer::sync_dir(parent).map_err(composition_io)?;
        }
        Ok(self)
    }

    fn member(&self, root: &Path, kept: &KeptMember) -> (String, CompositionMember) {
        let kind = if kept.raw {
            FileKind::Raw
        } else {
            FileKind::Jpeg
        };
        let role = kind.role();
        let id = transfer::hex(&transfer::Sha256::digest(
            format!("{}:{role}", self.key).as_bytes(),
        ));
        let path = root.join(COMPOSITION_DIR).join(format!(
            "test-{}-{role}.{}",
            self.seq,
            kind.extension().to_ascii_lowercase()
        ));
        (
            id,
            CompositionMember {
                path,
                name: kept.name.clone(),
                kind,
                receipt: StageReceipt {
                    bytes: kept.bytes,
                    sha256: kept.sha256.clone(),
                },
            },
        )
    }

    fn finish(&self, data: &Path, root: &Path) -> TResult<()> {
        if root
            .join(COMPOSITION_DIR)
            .try_exists()
            .map_err(composition_io)?
        {
            let dir = checked_composition_dir(root)?;
            for kept in &self.members {
                remove_if_present(&self.member(root, kept).1.path)?;
            }
            transfer::sync_dir(&dir).map_err(composition_io)?;
        }
        let path = keep_file(data, root, self.seq);
        remove_if_present(&path)?;
        transfer::sync_dir(path.parent().unwrap()).map_err(composition_io)
    }
}

async fn keep_composition(
    inner: &Arc<Inner>,
    binding: &Binding,
    promotion: &KeepPromotion,
) -> TResult<Value> {
    let _guard = inner.publish_lock.lock().await;
    let app = &inner.app;
    let shoot = &binding.shoot_id;
    let existing = node(
        app,
        "tether-journal",
        json!([shoot, "lookupKeep", { "key": promotion.key }]),
    )
    .await?;
    let members: Vec<_> = promotion
        .members
        .iter()
        .map(|m| promotion.member(&binding.root, m))
        .collect();
    let stage_rel = |id: &str| format!("{}/{id}.part", transfer::STAGE_DIR);
    let exposure_id = if let Some(exposure_id) = existing["exposureId"].as_str() {
        exposure_id.to_string()
    } else {
        let mut staged = Vec::new();
        let mut roles = Vec::new();
        for (id, member) in &members {
            stage_kept_member(&binding.root, &stage_rel(id), member)?;
            roles.push(member.kind.role());
            staged.push(json!({ "memberId": id, "originalName": member.name, "bytes": member.receipt.bytes, "sha256": member.receipt.sha256 }));
        }
        let mut exposure = json!({ "key": promotion.key, "staged": staged });
        if !promotion.target.is_null() {
            exposure["target"] = promotion.target.clone();
        }
        let accepted = node(
            app,
            "tether-accept",
            json!([
                shoot,
                promotion.epoch,
                null,
                exposure,
                roles,
                promotion.meta
            ]),
        )
        .await?;
        str_field(&accepted, "exposureId")?
    };
    let mut filename = Value::Null;
    for (id, member) in members {
        if let Some(name) = existing["ingested"][&id].as_str() {
            if filename.is_null() {
                filename = json!(name);
            }
            let stage = transfer::stage_path(&binding.root, &stage_rel(&id))
                .map_err(TetherError::from_transfer)?;
            if stage.try_exists().map_err(composition_io)? {
                let metadata = fs::symlink_metadata(&stage).map_err(composition_io)?;
                if !metadata.is_file()
                    || transfer::sha256_file(&stage).map_err(composition_io)?
                        != (member.receipt.bytes, member.receipt.sha256)
                {
                    return Err(TetherError::new(
                        "INCOMPLETE",
                        "The capture staging file changed.",
                    ));
                }
                remove_if_present(&stage)?;
            }
            continue;
        }
        let bytes = member.receipt.bytes;
        let published = publish(
            inner,
            binding,
            &id,
            &member.name,
            &stage_rel(&id),
            member.receipt,
            promotion.meta.clone(),
        )
        .await?;
        if filename.is_null() {
            filename = published["filename"].clone();
        }
        emit_transfer(
            inner,
            Some(shoot),
            promotion.epoch,
            Some(&exposure_id),
            Some(&id),
            "ingested",
            0,
            Some(bytes),
            None,
        );
    }
    let mut reply = json!({ "kept": true, "exposureId": exposure_id, "filename": filename });
    if let Err(e) = promotion.finish(&inner.data_dir, &binding.root) {
        reply["cleanupWarning"] = json!(e.message);
    }
    Ok(reply)
}

/// Reserve → exclusive publish → ingest for one staged member. A reserved plan is reused, and a
/// name taken by another writer goes back to allocation with that suffix excluded.
async fn publish(
    inner: &Arc<Inner>,
    binding: &Binding,
    member_id: &str,
    original_name: &str,
    stage_rel: &str,
    receipt: StageReceipt,
    shot: Value,
) -> TResult<Value> {
    let app = &inner.app;
    let shoot = &binding.shoot_id;
    let (root, rel, name) = (
        binding.root.clone(),
        stage_rel.to_string(),
        original_name.to_string(),
    );
    blocking(move || {
        let stage = transfer::stage_path(&root, &rel).map_err(TetherError::from_transfer)?;
        // An already published member has no stage file left; its bytes were checked before.
        if !stage.exists() {
            return Ok(());
        }
        transfer::validate_staged_signature(&stage, &name).map_err(TetherError::from_transfer)
    })
    .await?;
    for _ in 0..8 {
        let plan = node(
            app,
            "tether-reserve",
            json!([shoot, member_id, { "bytes": receipt.bytes, "sha256": receipt.sha256 }, shot]),
        )
        .await?;
        let final_rel = str_field(&plan, "finalRelPath")?;
        let claim = str_field(&plan, "claimId")?;
        let dir_id = plan["dirId"].as_str().map(String::from);
        let target = final_target(binding, &final_rel)?;
        let stage =
            transfer::stage_path(&binding.root, stage_rel).map_err(TetherError::from_transfer)?;
        let expected = receipt.clone();
        let outcome = blocking(move || {
            if std::fs::symlink_metadata(&stage).is_err() {
                // Already published by an earlier attempt: only the identical file counts.
                let missing = || TetherError::new("INCOMPLETE", "The staged capture is missing.");
                let meta = std::fs::symlink_metadata(&target).map_err(|_| missing())?;
                let (bytes, sha) = transfer::sha256_file(&target).map_err(|_| missing())?;
                if meta.is_file() && bytes == expected.bytes && sha == expected.sha256 {
                    return Ok(Some((bytes, transfer::file_identity(&meta))));
                }
                return Err(missing());
            }
            let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
                return Err(TetherError::new(
                    "NAME_INVALID",
                    "The reserved filename is not valid.",
                ));
            };
            let name = name.to_string_lossy();
            // Re-checked against the folder recorded at acceptance, pinned through publication;
            // the stage must still hold the journaled bytes.
            match transfer::publish_verified(&stage, dir, dir_id.as_deref(), &name, &expected) {
                Ok(published) => Ok(Some((published.bytes, published.identity))),
                Err(TransferError::Taken(_)) => Ok(None),
                Err(e) => Err(TetherError::from_transfer(e)),
            }
        })
        .await?;
        let Some((bytes, identity)) = outcome else {
            node(
                app,
                "tether-journal",
                json!([shoot, "conflict", { "memberId": member_id, "claimId": claim }]),
            )
            .await?;
            continue;
        };
        let mut published = json!({ "finalRelPath": final_rel, "bytes": bytes });
        if let (Some(dev), Some(ino)) = (identity.dev, identity.ino) {
            published["dev"] = dev.into();
            published["ino"] = ino.into();
        }
        let mut ingested = node(
            app,
            "tether-ingest",
            json!([shoot, member_id, claim, published]),
        )
        .await?;
        ingested["filename"] = final_rel.rsplit('/').next().into();
        return Ok(ingested);
    }
    Err(TetherError::new(
        "NAME_TAKEN",
        "No free filename could be reserved for this capture.",
    ))
}

/// The staged receipt Node journaled for a member, which a retry must match wherever the bytes are.
fn journaled_receipt(record: &Value) -> Option<StageReceipt> {
    let bytes = record["bytes"].as_u64().filter(|&b| b > 0)?;
    let sha256 = record["sha256"].as_str()?.to_ascii_lowercase();
    (sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(StageReceipt { bytes, sha256 })
}

/// Finishes a member that already has a complete stage file, or was already published, after a
/// restart or recovery.
fn spawn_recover(
    inner: Arc<Inner>,
    binding: Binding,
    member_id: String,
    original_name: String,
    receipt: Option<StageReceipt>,
) {
    let stage_rel = format!("{}/{}.part", transfer::STAGE_DIR, member_id);
    inner.outstanding.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let _guard = inner.publish_lock.lock().await;
        let receipt = receipt.ok_or_else(|| {
            TetherError::new(
                "INCOMPLETE",
                "This capture has no journaled transfer receipt.",
            )
        });
        let result = match receipt {
            Ok(receipt) => {
                publish(
                    &inner,
                    &binding,
                    &member_id,
                    &original_name,
                    &stage_rel,
                    receipt,
                    Value::Null,
                )
                .await
            }
            Err(e) => Err(e),
        };
        inner.outstanding.fetch_sub(1, Ordering::SeqCst);
        if let Err(e) = result {
            crate::logs::write(&format!("tether recovery {}: {}", e.code, e.message));
            if !e.journaled {
                let _ = node(
                    &inner.app,
                    "tether-journal",
                    json!([binding.shoot_id, "issue", { "memberId": member_id, "code": journal_code(&e.code), "message": e.message, "retryable": true }]),
                )
                .await;
            }
        }
    });
}

fn resume_records(inner: &Arc<Inner>, binding: &Binding, records: &Value) {
    for record in records.as_array().into_iter().flatten() {
        let Some(member_id) = record["memberId"].as_str() else {
            continue;
        };
        if valid_id(member_id, "memberId").is_err() {
            continue;
        }
        let state = record["state"].as_str().unwrap_or("");
        let action = record["action"].as_str().unwrap_or("");
        let staged = matches!(state, "staged" | "reserved" | "published");
        if matches!(action, "publish" | "reserve") || (staged && action != "replayed") {
            let name = record["originalName"].as_str().unwrap_or_default();
            spawn_recover(
                inner.clone(),
                binding.clone(),
                member_id.to_string(),
                name.to_string(),
                journaled_receipt(record),
            );
        }
    }
}

// ---------- Loopback image fetch ----------

fn http_get(
    port: u16,
    token: &str,
    route: &str,
    limit: usize,
) -> TResult<(Option<String>, Vec<u8>)> {
    use std::net::{SocketAddr, TcpStream};
    if !route.starts_with("/image/") || route.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(TetherError::new("UNSUPPORTED", "Invalid image route."));
    }
    if token.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(TetherError::new("IO_ERROR", "Invalid backend credentials."));
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let io_err =
        |e: io::Error| TetherError::new("IO_ERROR", format!("Loading the photo failed: {e}"));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(io_err)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(io_err)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(io_err)?;
    let request = format!(
        "GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-photocull-token: {token}\r\nAccept: image/jpeg\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(io_err)?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 64 << 10];
    let header_end = loop {
        let n = stream.read(&mut buf).map_err(io_err)?;
        if n == 0 {
            return Err(TetherError::new(
                "IO_ERROR",
                "The photo server closed the connection.",
            ));
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if raw.len() > 32 << 10 {
            return Err(TetherError::new(
                "IO_ERROR",
                "The photo server reply is malformed.",
            ));
        }
    };
    let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut length = None;
    let mut chunked = false;
    let mut content_type = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse::<usize>().ok(),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            "content-type" => content_type = Some(value.to_ascii_lowercase()),
            _ => {}
        }
    }
    if status != 200 {
        return Err(TetherError::new(
            if status == 404 {
                "STALE_REV"
            } else {
                "IO_ERROR"
            },
            format!("The photo is not available ({status})."),
        ));
    }
    if length.is_some_and(|n| n > limit) {
        return Err(TetherError::new(
            "UNSUPPORTED",
            "The photo is too large to analyze.",
        ));
    }
    let mut body = raw[header_end..].to_vec();
    loop {
        if let Some(n) = length {
            if body.len() >= n {
                body.truncate(n);
                break;
            }
        }
        if body.len() > limit + (1 << 20) {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "The photo is too large to analyze.",
            ));
        }
        let n = stream.read(&mut buf).map_err(io_err)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    if chunked {
        body = wifi::dechunk(&body)
            .ok_or_else(|| TetherError::new("IO_ERROR", "The photo reply is malformed."))?;
    } else if length.is_some_and(|n| body.len() != n) {
        return Err(TetherError::new(
            "INCOMPLETE",
            "The photo reply was cut short.",
        ));
    }
    if body.len() > limit {
        return Err(TetherError::new(
            "UNSUPPORTED",
            "The photo is too large to analyze.",
        ));
    }
    Ok((content_type, body))
}

/// Resolves a Library photo through Node and loads its JPEG from the authenticated loopback server.
async fn session_jpeg(
    app: &AppHandle,
    session: &str,
    id: &str,
    kind: &str,
    original: bool,
    content_rev: Option<u64>,
    limit: usize,
) -> TResult<(Value, Vec<u8>)> {
    let request = |rev: u64| json!([session, id, kind, original, rev]);
    let frame = match node(
        app,
        "tether-session-frame",
        request(content_rev.unwrap_or(0)),
    )
    .await
    {
        Err(e) if content_rev.is_none() && e.code == "STALE_REV" && e.current_rev.is_some() => {
            node(
                app,
                "tether-session-frame",
                request(e.current_rev.unwrap_or(0)),
            )
            .await?
        }
        other => other?,
    };
    let route = str_field(&frame, "route")?;
    let backend = app
        .try_state::<Backend>()
        .ok_or_else(|| TetherError::new("IO_ERROR", "PhotoCull's backend is not running."))?;
    let port = backend.info["port"].as_u64().unwrap_or(0) as u16;
    let token = backend.info["token"].as_str().unwrap_or("").to_string();
    if port == 0 {
        return Err(TetherError::new(
            "IO_ERROR",
            "The photo server is not available.",
        ));
    }
    let (_, bytes) = blocking(move || http_get(port, &token, &route, limit)).await?;
    Ok((frame, bytes))
}

// ---------- Overlay rasterization ----------

fn looks_like_svg(name: &str, bytes: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".svg") || lower.ends_with(".svgz") {
        return true;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
    head.contains("<svg")
        || (head.trim_start().starts_with("<?xml") && !bytes.starts_with(&[0x89, b'P']))
}

/// Decodes PNG/JPEG within the overlay bounds and re-encodes an oriented RGBA PNG.
fn rasterize_overlay(bytes: &[u8]) -> TResult<(Vec<u8>, u32, u32)> {
    use lightcraft_codecs::{DecodeOptions, Format};
    if bytes.len() > OVERLAY_INPUT_LIMIT {
        return Err(TetherError::new(
            "UNSUPPORTED",
            "Overlay images must be 32 MB or smaller.",
        ));
    }
    match lightcraft_codecs::sniff(bytes) {
        Some(Format::Png | Format::Jpeg) => {}
        _ => {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "Choose a PNG or JPEG image for the overlay.",
            ))
        }
    }
    let header = lightcraft_codecs::read_header(bytes).ok();
    if let Some(h) = header {
        if h.width as u64 * h.height as u64 > OVERLAY_SOURCE_PIXELS {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "Overlay images can have at most 32 megapixels.",
            ));
        }
    }
    let decoded = lightcraft_codecs::decode(
        bytes,
        DecodeOptions {
            max_size: Some((OVERLAY_EDGE, OVERLAY_EDGE)),
            max_pixels: OVERLAY_SOURCE_PIXELS,
        },
    )
    .map_err(|e| {
        TetherError::new(
            "UNSUPPORTED",
            format!("The overlay image could not be read: {e}"),
        )
    })?;
    let orientation = lightcraft_geom::Orientation::from_exif(decoded.orientation);
    let image = decoded.to_srgb8().into_oriented(orientation);
    let (w, h) = (image.width as u32, image.height as u32);
    let png = lightcraft_codecs::encode_png(
        &lightcraft_codecs::EncodeImage::rgba8(&image),
        &lightcraft_codecs::EncodeMeta::default(),
    )
    .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
    Ok((png, w, h))
}

fn overlay_dir(inner: &Inner) -> PathBuf {
    inner.data_dir.join("tether").join("overlays")
}

fn store_overlay(dir: &Path, png: &[u8]) -> TResult<(String, String)> {
    std::fs::create_dir_all(dir).map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
    let sha = transfer::hex(&transfer::Sha256::digest(png));
    let asset_id = format!("ov-{}", &sha[..32]);
    let target = dir.join(format!("{asset_id}.png"));
    if let Ok((bytes, existing)) = transfer::sha256_file(&target) {
        if bytes == png.len() as u64 && existing == sha {
            return Ok((asset_id, sha));
        }
        return Err(TetherError::new(
            "IO_ERROR",
            "An overlay cache file is damaged.",
        ));
    }
    let temp = dir.join(format!(".{asset_id}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
        f.write_all(png)
            .and_then(|_| f.sync_all())
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
    }
    let published = transfer::publish_no_replace(&temp, &target);
    let _ = std::fs::remove_file(&temp);
    match published {
        Ok(_) | Err(TransferError::Taken(_)) => Ok((asset_id, sha)),
        Err(e) => Err(TetherError::from_transfer(e)),
    }
}

// ---------- Tauri commands ----------

fn layout_root(root: &Path, layout: &str) -> PathBuf {
    if layout == "session" {
        root.join("Capture")
    } else {
        root.to_path_buf()
    }
}

/// Validates a destination root: a real folder, accepted by `check` before anything is written,
/// whose staging area accepts exclusive publication. Returns the root and the identity `check`
/// approved; a folder replaced meanwhile is refused before and after staging is created.
fn preflight_root(
    path: &Path,
    check: impl FnOnce(&Path) -> TResult<()>,
) -> TResult<(PathBuf, Option<String>)> {
    let root = dunce::canonicalize(path)
        .map_err(|_| TetherError::new("DEST_CHANGED", "The capture folder is not available."))?;
    transfer::resolve_dir(&root, "").map_err(TetherError::from_transfer)?;
    let identity = transfer::dir_identity(&root);
    check(&root)?;
    same_root(&root, &identity)?;
    let stage = transfer::stage_dir(&root).map_err(TetherError::from_transfer)?;
    same_root(&root, &identity)?;
    let token = transfer::hex(&transfer::Sha256::digest(
        format!("{}:{:?}", std::process::id(), Instant::now()).as_bytes(),
    ));
    let probe = stage.join(format!("probe-{}.part", &token[..16]));
    let published = stage.join(format!("probe-{}.done", &token[..16]));
    let result = (|| -> TResult<()> {
        let mut w = StageWriter::create(probe.clone(), 16).map_err(TetherError::from_transfer)?;
        w.write_all(b"photocull").map_err(|e| {
            TetherError::new(
                "IO_ERROR",
                format!("The capture folder is not writable: {e}"),
            )
        })?;
        w.finish().map_err(TetherError::from_transfer)?;
        transfer::publish_no_replace(&probe, &published).map_err(TetherError::from_transfer)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&probe);
    let _ = std::fs::remove_file(&published);
    result?;
    Ok((root, identity))
}

/// Refuses a root that is no longer the folder first resolved at this path.
fn same_root(root: &Path, identity: &Option<String>) -> TResult<()> {
    let current = dunce::canonicalize(root).ok();
    if current.as_deref() != Some(root) || transfer::dir_identity(root) != *identity {
        return Err(TetherError::new(
            "DEST_CHANGED",
            "The capture folder was moved or replaced while tethering started. Choose it again.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn tether_open(
    window: WebviewWindow,
    app: AppHandle,
    tether: State<'_, TetherManager>,
    session: Option<String>,
    use_open_folder: bool,
    layout: String,
    include_shots: bool,
    resume: Option<String>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            if let Some(s) = &session {
                valid_id(s, "session")?;
            }
            if let Some(shoot_id) = &resume {
                valid_id(shoot_id, "resume")?;
            }
            let chosen = if resume.is_some() {
                None
            } else if use_open_folder {
                let s = session
                    .clone()
                    .ok_or_else(|| TetherError::new("STALE_SESSION", "Open a folder first."))?;
                let folder = node(&app, "session-folder", json!([s])).await?;
                Some(PathBuf::from(
                    folder.as_str().ok_or_else(TetherError::stale_session)?,
                ))
            } else {
                window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .set_title("Choose the capture folder")
                    .blocking_pick_folder()
                    .and_then(|p| p.into_path().ok())
            };
            if chosen.is_none() && resume.is_none() {
                return Ok(Value::Null);
            }
            let _shoot_guard = tether.inner.shoot_lock.lock().await;
            // A resumed shoot names its own folder and layout; the renderer never passes a path.
            let (chosen, layout, include_shots, folder_id) = match &resume {
                Some(shoot_id) => {
                    let target = node(&app, "tether-resume-target", json!([shoot_id])).await?;
                    (
                        PathBuf::from(str_field(&target, "root")?),
                        str_field(&target, "layout")?,
                        target["includeShots"].as_bool().unwrap_or(false),
                        target["folderId"].clone(),
                    )
                }
                None => (chosen.unwrap(), layout, include_shots, Value::Null),
            };
            if layout != "single" && layout != "session" {
                return Err(
                    TetherError::new("UNSUPPORTED", "Invalid capture layout.").field("layout")
                );
            }
            let rebinding = tether.binding();
            if let Some(bound) = &rebinding {
                let same = dunce::canonicalize(&chosen).is_ok_and(|root| root == bound.root);
                if resume.is_some() || !same {
                    return Err(TetherError::new(
                        "CAMERA_BUSY",
                        "Stop the current tethered shoot first.",
                    ));
                }
            }
            let check_app = app.clone();
            let root = blocking(move || {
                preflight_root(&chosen, |root| {
                    // Camera cards and a resumed folder that was replaced are refused read-only,
                    // before any staging folder exists.
                    node_blocking(
                        &check_app,
                        "tether-check-destination",
                        json!([root.to_string_lossy(), folder_id]),
                    )
                    .map(|_| ())
                })
            })
            .await?;
            let (root, identity) = root;
            let identity = identity.map(|id| json!({ "folderId": id }));
            let bound = node(
                &app,
                "tether-bind",
                json!([
                    root.to_string_lossy(),
                    identity,
                    layout,
                    include_shots,
                    session,
                    resume
                ]),
            )
            .await?;
            let shoot_id = str_field(&bound, "shootId")?;
            let attached = match bound["session"]["id"].as_str() {
                Some(session_id) => {
                    let binding = Binding {
                        shoot_id: shoot_id.clone(),
                        session: session_id.to_string(),
                        library_root: layout_root(&root, &layout),
                        root,
                    };
                    tether
                        .ask(|tx| Cmd::Bind(binding, bound["recoveries"].clone(), tx))
                        .await
                }
                None => Err(TetherError::new(
                    "IO_ERROR",
                    "The backend returned no Library session.",
                )),
            };
            // A newly opened sidecar shoot stays open only when the camera side is bound too.
            let issues = match attached {
                Ok(issues) => issues,
                Err(e) => {
                    if rebinding.is_none() {
                        let _ = node(&app, "tether-journal", json!([shoot_id, "close", {}])).await;
                    }
                    return Err(e);
                }
            };
            Ok(json!({
                "shootId": shoot_id,
                "session": bound["session"],
                "configRev": bound["configRev"],
                "libraryRev": bound["libraryRev"],
                "issues": issues,
            }))
        }
        .await,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tether_location(
    window: WebviewWindow,
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    expected_config_rev: u64,
    op: String,
    parent_rel: Option<String>,
    leaf: Option<String>,
    relative: Option<String>,
    activate: Option<bool>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            let binding = tether.check(&shoot_id, None)?;
            let library_root = binding.library_root.clone();
            let relative = match op.as_str() {
                "choose" => {
                    let picked = window
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .set_title("Choose the next capture folder")
                        .set_directory(&library_root)
                        .blocking_pick_folder()
                        .and_then(|p| p.into_path().ok());
                    let Some(picked) = picked else {
                        return Ok(Value::Null);
                    };
                    let root = library_root.clone();
                    blocking(move || {
                        let picked = dunce::canonicalize(&picked).map_err(|_| {
                            TetherError::new("DEST_CHANGED", "That folder is not available.")
                        })?;
                        let rest = picked.strip_prefix(&root).map_err(|_| {
                            TetherError::new(
                                "DEST_CHANGED",
                                "Choose a folder inside the shoot's capture folder.",
                            )
                        })?;
                        let parts: Vec<String> = rest
                            .components()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                            .collect();
                        let rel = parts.join("/");
                        transfer::resolve_dir(&root, &rel).map_err(TetherError::from_transfer)?;
                        Ok(rel)
                    })
                    .await?
                }
                "create" => {
                    let parent = parent_rel.unwrap_or_default();
                    let leaf = leaf.ok_or_else(|| {
                        TetherError::new("NAME_INVALID", "Enter a folder name.").field("leaf")
                    })?;
                    let root = library_root.clone();
                    blocking(move || {
                        transfer::create_child_dir(&root, &parent, leaf.trim())
                            .map(|(_, rel)| rel)
                            .map_err(TetherError::from_transfer)
                    })
                    .await?
                }
                "set" => {
                    let rel = relative.unwrap_or_default();
                    let root = library_root.clone();
                    let checked = rel.clone();
                    blocking(move || {
                        transfer::resolve_dir(&root, &checked).map_err(TetherError::from_transfer)
                    })
                    .await?;
                    rel
                }
                _ => {
                    return Err(
                        TetherError::new("UNSUPPORTED", "Unknown location operation.").field("op"),
                    )
                }
            };
            let dir = transfer::resolve_dir(&library_root, &relative)
                .map_err(TetherError::from_transfer)?;
            let identity = transfer::dir_identity(&dir);
            let result = node(
                &app,
                "tether-set-location",
                json!([
                    shoot_id,
                    expected_config_rev,
                    relative,
                    identity,
                    activate.unwrap_or(true)
                ]),
            )
            .await?;
            let free = transfer::free_space(&dir).ok();
            Ok(json!({
                "configRev": result["configRev"],
                "location": result["location"],
                "space": { "freeBytes": free },
            }))
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_devices(tether: State<'_, TetherManager>) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(tether.device_list(true).await))
}

/// Runs one bounded SSDP window on a worker and adds what it finds to the camera list.
#[tauri::command]
pub async fn tether_discover_wifi(tether: State<'_, TetherManager>) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            let found = blocking(|| Ok(wifi::discover(wifi::DEFAULT_WINDOW))).await?;
            merge_discovery(&tether.inner, &found);
            let mut list = tether.device_list(false).await?;
            if let Some(hint) = found.hint {
                list["hint"] = hint.into();
            }
            Ok(list)
        }
        .await,
    ))
}

/// Adds a camera by its numeric IPv4 address. For Access Authentication the camera's host key is
/// checked against the confirmed pin; an unknown or changed key comes back with its fingerprint
/// for the photographer to compare with the camera before confirming it.
#[tauri::command]
pub async fn tether_add_wifi(
    tether: State<'_, TetherManager>,
    address: String,
    auth_mode: String,
    username: Option<String>,
    password: Option<String>,
    accept_fingerprint: Option<String>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            let ip = wifi::parse_camera_address(&address)
                .map_err(|m| TetherError::new("UNSUPPORTED", m).field("address"))?;
            let mode = match auth_mode.as_str() {
                "auto" => None,
                "ssh" => Some(WifiAuth::Ssh),
                "plain" => Some(WifiAuth::Plain),
                _ => {
                    return Err(
                        TetherError::new("UNSUPPORTED", "Invalid authentication mode.")
                            .field("authMode"),
                    )
                }
            };
            if username
                .as_deref()
                .is_some_and(|u| !wifi::valid_username(u))
            {
                return Err(
                    TetherError::new("UNSUPPORTED", "Invalid camera user name.").field("username")
                );
            }
            if password
                .as_deref()
                .is_some_and(|p| p.is_empty() || p.len() > 256 || p.contains(['\n', '\r', '\0']))
            {
                return Err(
                    TetherError::new("UNSUPPORTED", "Invalid camera password.").field("password")
                );
            }
            if accept_fingerprint
                .as_deref()
                .is_some_and(|f| !f.starts_with("SHA256:") || f.len() > 80)
            {
                return Err(TetherError::new("UNSUPPORTED", "Invalid fingerprint.")
                    .field("acceptFingerprint"));
            }
            let inner = tether.inner.clone();
            let device_id = blocking(move || {
                add_wifi(&inner, ip, mode, username, password, accept_fingerprint)
            })
            .await?;
            let list = tether.device_list(false).await?;
            let device = list["devices"]
                .as_array()
                .and_then(|all| all.iter().find(|d| d["deviceId"] == device_id.as_str()))
                .cloned()
                .unwrap_or(Value::Null);
            Ok(json!({ "device": device, "devices": list["devices"] }))
        }
        .await,
    ))
}

impl TetherManager {
    /// USB devices and Wi-Fi candidates; a failing USB backend never hides Wi-Fi cameras.
    async fn device_list(&self, usb_required: bool) -> TResult<Value> {
        let inner = self.inner.clone();
        let usb = blocking(move || Ok(inner.browser.devices().map_err(|e| e_text(&e)))).await?;
        let snapshot = if self.inner.actor.lock().unwrap().is_some() {
            self.ask(Cmd::Snapshot).await.ok()
        } else {
            None
        };
        let active = snapshot.as_ref().and_then(held_device);
        let (usb, usb_error) = match usb {
            Ok(list) => (list, None),
            Err(message) => (Vec::new(), Some(message)),
        };
        let mut devices: Vec<Value> = usb
            .iter()
            .map(|d| {
                let availability = if Some(&d.id) == active.as_ref() {
                    "connected"
                } else if d.active {
                    "busy"
                } else if !d.can_send_ptp && d.usb_vendor_id != icc::SONY_USB_VENDOR {
                    "unsupported"
                } else {
                    "available"
                };
                json!({
                    "deviceId": d.id,
                    "model": d.name,
                    "transport": "usb-icc",
                    "availability": availability,
                })
            })
            .collect();
        let wifi: Vec<Value> = {
            let mut state = self.inner.wifi.lock().unwrap();
            load_remembered(&self.inner.data_dir, &mut state);
            state.prune(Instant::now(), active.as_deref());
            state
                .candidates
                .iter()
                .map(|(id, c)| {
                    wifi_json(id, c, active.as_deref(), state.passwords.contains_key(id))
                })
                .collect()
        };
        if let Some(message) = &usb_error {
            if usb_required && wifi.is_empty() {
                return Err(TetherError::new("UNSUPPORTED", message.clone()));
            }
        }
        devices.extend(wifi);
        let state = self.inner.state.lock().unwrap().0;
        let mut out = json!({
            "state": state.as_str(),
            "devices": devices,
            "activeDeviceId": active,
            "epoch": self.inner.epoch.load(Ordering::SeqCst),
        });
        if let Some(message) = usb_error {
            out["usbError"] = message.into();
        }
        Ok(out)
    }
}

fn wifi_json(id: &str, c: &WifiCandidate, active: Option<&str>, has_password: bool) -> Value {
    let model = [&c.model, &c.name]
        .into_iter()
        .find(|m| !m.is_empty())
        .cloned()
        .unwrap_or_else(|| "Sony camera".into());
    json!({
        "deviceId": id,
        "model": model,
        "name": if c.name.is_empty() { Value::Null } else { c.name.clone().into() },
        "transport": "wifi-ptpip",
        "availability": if active == Some(id) { "connected" } else { "available" },
        "address": c.address.to_string(),
        "auth": c.auth.as_str(),
        "username": c.username,
        "sshAdvertised": c.ssh_advertised,
        "discovered": c.discovered,
        "remembered": c.responder_guid.is_some(),
        "needsCredentials": c.auth == WifiAuth::Ssh && !has_password,
    })
}

fn merge_discovery(inner: &Inner, found: &wifi::Discovery) {
    let mut state = inner.wifi.lock().unwrap();
    load_remembered(&inner.data_dir, &mut state);
    state.merge(&found.cameras, &found.departed, Instant::now());
}

fn add_wifi(
    inner: &Inner,
    address: Ipv4Addr,
    mode: Option<WifiAuth>,
    username: Option<String>,
    password: Option<String>,
    accept_fingerprint: Option<String>,
) -> TResult<String> {
    let id = format!("{WIFI_PREFIX}{address}");
    let (mut candidate, has_password) = {
        let mut state = inner.wifi.lock().unwrap();
        load_remembered(&inner.data_dir, &mut state);
        let candidate = state
            .candidates
            .get(&id)
            .cloned()
            .unwrap_or_else(|| WifiCandidate::new(address, ""));
        (candidate, state.passwords.contains_key(&id))
    };
    let known = known_hosts(&inner.data_dir);
    let auth = match mode {
        Some(auth) => auth,
        None => wifi::auto_auth(&candidate, wifi::has_pin(&known, &candidate.alias))
            .map_err(auth_choice)?,
    };
    if auth == WifiAuth::Ssh {
        let username = username
            .or_else(|| candidate.username.clone())
            .ok_or_else(credentials_required)?;
        if password.is_none() && !has_password {
            return Err(credentials_required());
        }
        candidate.username = Some(username);
        if let Some(password) = password {
            inner
                .wifi
                .lock()
                .unwrap()
                .passwords
                .insert(id.clone(), password);
        }
        let keys = wifi::scan_host_keys(address, Duration::from_secs(5)).map_err(ssh_error)?;
        let status = wifi::check_host_key(&known, &candidate.alias, &keys)
            .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
        let unconfirmed = match status {
            wifi::HostKeyStatus::Verified => None,
            wifi::HostKeyStatus::Unverified(key) => Some(("SSH_HOST_KEY_UNVERIFIED", key)),
            wifi::HostKeyStatus::Changed(key) => Some(("SSH_HOST_KEY_CHANGED", key)),
        };
        if let Some((code, key)) = unconfirmed {
            if accept_fingerprint.as_deref() != Some(key.fingerprint.as_str()) {
                let message = if code == "SSH_HOST_KEY_CHANGED" {
                    format!("The camera's SSH key changed to {}. Trust it only if it matches Access Authen. Info on the camera.", key.fingerprint)
                } else {
                    format!("Check that {} matches the fingerprint in Access Authen. Info on the camera, then confirm it.", key.fingerprint)
                };
                let mut e = TetherError::new(code, message).retryable(false);
                e.fingerprint = Some(key.fingerprint);
                return Err(e);
            }
            wifi::pin_host_key(&known, &candidate.alias, &key)
                .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
        }
    }
    candidate.auth = auth;
    inner
        .wifi
        .lock()
        .unwrap()
        .candidates
        .insert(id.clone(), candidate);
    Ok(id)
}

fn auth_choice_required() -> TetherError {
    auth_choice(
        "Choose whether this camera uses Access Authentication (SSH) or connects without it.",
    )
}

fn auth_choice(message: &str) -> TetherError {
    TetherError::new("AUTH_CHOICE_REQUIRED", message)
        .retryable(false)
        .field("authMode")
}

fn connect_cancelled() -> TetherError {
    TetherError::new("CAMERA_LOST", "Connecting was cancelled.").retryable(false)
}

fn credentials_required() -> TetherError {
    TetherError::new(
        "SSH_CREDENTIALS_REQUIRED",
        "Enter the user name and password from the camera's Access Authen. Info.",
    )
    .retryable(false)
}

fn ssh_error(e: wifi::SshError) -> TetherError {
    use wifi::SshError as E;
    match e {
        E::HostKey(m) => TetherError::new("SSH_HOST_KEY_CHANGED", m).retryable(false),
        E::Authentication(m) => TetherError::new("SSH_AUTH_FAILED", m).retryable(false),
        E::Unreachable(m) => TetherError::new("CAMERA_UNREACHABLE", m).retryable(true),
        E::Unavailable(m) => TetherError::new("UNSUPPORTED", m).retryable(false),
        E::Failed(m) => TetherError::new("IO_ERROR", m),
        E::Cancelled => connect_cancelled(),
    }
}

/// Wi-Fi wording for connection failures; USB keeps its own.
fn wifi_connect_error(e: SessionError) -> TetherError {
    match &e {
        SessionError::Transport(TransportError::Permission) => TetherError::new(
            "PAIRING_REFUSED",
            "The camera declined PhotoCull. Choose PC Remote Function → Pairing on the camera and connect again.",
        )
        .retryable(true),
        SessionError::Transport(TransportError::InUse) => TetherError::new(
            "CAMERA_BUSY",
            "Another device is connected to the camera. Disconnect the smartphone or other computer and try again.",
        ),
        SessionError::Transport(TransportError::TimedOut) => TetherError::new(
            "CAMERA_UNREACHABLE",
            "The camera did not answer over Wi-Fi. Check that PC Remote is on and the camera is on this network; for a first connection, confirm PhotoCull on the camera.",
        )
        .retryable(true),
        SessionError::Transport(TransportError::Native { domain, code, .. })
            if domain == "PTP/IP" =>
        {
            let kind = i32::try_from(*code)
                .ok()
                .filter(|c| *c != 0)
                .map(|c| io::Error::from_raw_os_error(c).kind());
            match kind.map(wifi::reach) {
                Some(wifi::Reach::Denied) => TetherError::new(
                    "LOCAL_NETWORK_DENIED",
                    "PhotoCull may not use the local network. Allow it in System Settings → Privacy & Security → Local Network, then try again.",
                )
                .retryable(true),
                Some(wifi::Reach::Refused) => TetherError::new(
                    "CAMERA_UNREACHABLE",
                    "The camera refused the connection. If Access Authentication is on, add the camera with SSH.",
                )
                .retryable(true),
                Some(wifi::Reach::Unreachable) => TetherError::new(
                    "CAMERA_UNREACHABLE",
                    "No camera answered at that address. Check that the camera and this computer share a network and PC Remote is on.",
                )
                .retryable(true),
                _ => TetherError::new("CAMERA_LOST", "The camera could not be reached over Wi-Fi."),
            }
        }
        SessionError::NotSonyRemote(model) => TetherError::new(
            "UNSUPPORTED",
            format!("{model} is not in PC Remote mode. Turn on PC Remote on the camera and connect again."),
        )
        .retryable(true),
        _ => TetherError::from_session(e),
    }
}

fn ssh_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tether").join("ssh")
}

fn known_hosts(data_dir: &Path) -> PathBuf {
    ssh_dir(data_dir).join("known_hosts")
}

fn remembered_path(data_dir: &Path) -> PathBuf {
    data_dir.join("tether").join("wifi-cameras.json")
}

/// Reads cameras remembered from earlier verified connections, once per run.
fn load_remembered(data_dir: &Path, state: &mut WifiState) {
    if state.loaded {
        return;
    }
    state.loaded = true;
    let Ok(text) = std::fs::read_to_string(remembered_path(data_dir)) else {
        return;
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let text_of = |v: &Value| {
        v.as_str()
            .unwrap_or("")
            .chars()
            .take(128)
            .collect::<String>()
    };
    for e in entries {
        let Some(address) = e["address"]
            .as_str()
            .and_then(|a| wifi::parse_camera_address(a).ok())
        else {
            continue;
        };
        let auth = match e["auth"].as_str() {
            Some("ssh") => WifiAuth::Ssh,
            Some("plain") => WifiAuth::Plain,
            _ => continue,
        };
        // The alias reaches ssh's option parser, so it must stay a single plain token.
        let alias = e["alias"]
            .as_str()
            .filter(|a| {
                a.starts_with("photocull-camera-")
                    && a.len() <= 96
                    && a.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            })
            .map(String::from)
            .unwrap_or_else(|| wifi::host_alias(&address.to_string()));
        state
            .candidates
            .entry(format!("{WIFI_PREFIX}{address}"))
            .or_insert(WifiCandidate {
                address,
                name: text_of(&e["name"]),
                model: text_of(&e["model"]),
                udn: text_of(&e["udn"]),
                auth,
                ssh_advertised: None,
                username: e["username"]
                    .as_str()
                    .filter(|u| wifi::valid_username(u))
                    .map(String::from),
                alias,
                discovered: false,
                expires_at: None,
                responder_guid: e["responderGuid"].as_str().and_then(wifi::parse_uuid),
            });
    }
}

/// Records a verified connection: address, identity and route, never a password.
fn remember_wifi(inner: &Inner, device_id: &str, model: &str, responder_guid: Option<[u8; 16]>) {
    let entries: Vec<Value> = {
        let mut state = inner.wifi.lock().unwrap();
        if let Some(c) = state.candidates.get_mut(device_id) {
            c.responder_guid = responder_guid;
            if !model.is_empty() {
                c.model = model.to_string();
            }
        }
        state
            .candidates
            .values()
            .filter(|c| c.responder_guid.is_some())
            .filter_map(|c| {
                Some(json!({
                    "address": c.address.to_string(),
                    "model": c.model,
                    "name": c.name,
                    "udn": c.udn,
                    "auth": c.auth.as_str()?,
                    "username": c.username,
                    "alias": c.alias,
                    "responderGuid": c.responder_guid.as_ref().map(wifi::format_uuid),
                }))
            })
            .collect()
    };
    let path = remembered_path(&inner.data_dir);
    let tmp = path.with_extension("json.tmp");
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| {
            std::fs::write(
                &tmp,
                serde_json::to_vec_pretty(&entries).unwrap_or_default(),
            )
        })
        .and_then(|_| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[tauri::command]
pub async fn tether_connect(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    device_id: String,
    expect: Option<ExpectedBody>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            tether.check(&shoot_id, None)?;
            if device_id.is_empty() || device_id.len() > 256 {
                return Err(TetherError::new("UNSUPPORTED", "Invalid camera.").field("deviceId"));
            }
            tether.ask(|tx| Cmd::Connect(device_id, expect, tx)).await
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_control(
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    op: String,
    test_seq: Option<u64>,
    force_single: Option<bool>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            let composition = match op.as_str() {
                "composition-on" => Some(CompositionOp::On),
                "composition-off" => Some(CompositionOp::Off),
                "composition-discard" => Some(CompositionOp::Discard(test_seq)),
                "composition-keep" => {
                    Some(CompositionOp::Keep(test_seq, force_single.unwrap_or(false)))
                }
                _ => None,
            };
            let checked = (op != "stop" && composition.is_none()).then_some(epoch);
            let binding = tether.check(&shoot_id, checked)?;
            let stamp = Stamp {
                shoot_id: shoot_id.clone(),
                epoch: checked,
            };
            if let Some(op) = composition {
                let _shoot_guard = tether.inner.shoot_lock.lock().await;
                return tether.ask(|tx| Cmd::Composition(stamp, op, tx)).await;
            }
            match op.as_str() {
                "pause" => tether.ask(|tx| Cmd::Pause(stamp, true, tx)).await,
                "resume" => tether.ask(|tx| Cmd::Pause(stamp, false, tx)).await,
                "refresh" => tether.ask(|tx| Cmd::Refresh(stamp, tx)).await,
                "reconnect" => tether.ask(|tx| Cmd::Reconnect(stamp, tx)).await,
                "fel" => tether.ask(|tx| Cmd::Fel(stamp, tx)).await,
                "disconnect" => {
                    tether.inner.cancel.store(true, Ordering::SeqCst);
                    tether.inner.abort_connect();
                    tether.ask(|tx| Cmd::Disconnect(stamp, tx)).await
                }
                "stop" => {
                    tether.inner.cancel.store(true, Ordering::SeqCst);
                    tether.inner.abort_connect();
                    let _shoot_guard = tether.inner.shoot_lock.lock().await;
                    tether.check(&shoot_id, None)?;
                    // The camera is remembered with the shoot so a resumed session can reconnect to it.
                    let mut camera = Value::Null;
                    if tether.inner.actor.lock().unwrap().is_some() {
                        if let Ok(snapshot) = tether.ask(Cmd::Snapshot).await {
                            camera = attached_camera(&snapshot, &shoot_id);
                        }
                        let _ = tether.ask(|tx| Cmd::Disconnect(stamp.clone(), tx)).await;
                    }
                    drop(tether.inner.publish_lock.lock().await);
                    let closed = node(
                        &app,
                        "tether-journal",
                        json!([binding.shoot_id, "close", { "camera": camera }]),
                    )
                    .await?;
                    let mut guard = tether.inner.binding.lock().unwrap();
                    if guard.as_ref().is_some_and(|b| b.shoot_id == shoot_id) {
                        *guard = None;
                    }
                    drop(guard);
                    tether.inner.composition_mode.store(false, Ordering::SeqCst);
                    tether.inner.composition_shot.lock().unwrap().take();
                    emit(
                        &app,
                        "tether-composition",
                        composition_payload(&shoot_id, false, None),
                    );
                    Ok(closed_shoot(
                        &tether.inner.data_dir,
                        &binding.root,
                        &closed["pending"],
                        tether.inner.epoch.load(Ordering::SeqCst),
                    ))
                }
                _ => Err(TetherError::new("UNSUPPORTED", "Unknown tether operation.").field("op")),
            }
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_set_property(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    key: String,
    value: Value,
    expected_prop_rev: u64,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            tether.check(&shoot_id, Some(epoch))?;
            let value = match value {
                Value::String(s) if s.len() <= 64 => SetValue::Text(s),
                Value::Number(n) => SetValue::Number(n.as_f64().unwrap_or(f64::NAN)),
                _ => {
                    return Err(
                        TetherError::new("UNSUPPORTED", "Invalid setting value.").field("value")
                    )
                }
            };
            if key.len() > 64 {
                return Err(TetherError::new("UNSUPPORTED", "Unknown setting.").field("key"));
            }
            let stamp = Stamp {
                shoot_id,
                epoch: Some(epoch),
            };
            tether
                .ask(|tx| Cmd::SetProperty(stamp, key, value, expected_prop_rev, tx))
                .await
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_trigger(
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    request_id: String,
    primary_seq: Option<u64>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(async move {
        let shoot_guard = tether.inner.shoot_lock.lock().await;
        let binding = tether.check(&shoot_id, Some(epoch))?;
        valid_id(&request_id, "requestId")?;
        let stamp = Stamp {
            shoot_id: shoot_id.clone(),
            epoch: Some(epoch),
        };
        if tether.inner.composition_mode.load(Ordering::SeqCst) {
            let outcome = tether.ask(|tx| Cmd::Trigger(stamp, None, tx)).await;
            return match outcome {
                Ok(CaptureOutcome::Released) => Ok(json!({ "requestId": request_id, "state": "released", "status": "released", "testShot": true })),
                Ok(CaptureOutcome::FocusNotAcquired) => Err(TetherError::new(
                    "CONTROL_LOCKED", "The camera could not focus, so it did not take the picture.",
                ).retryable(true)),
                Err(e) if e.uncertain => Ok(json!({
                    "requestId": request_id, "state": "outcomeUnknown", "reason": e.message,
                })),
                Err(e) => Err(e),
            };
        }
        let shoot = &binding.shoot_id;
        let created = node(
            &app,
            "tether-request",
            json!([shoot, request_id, primary_seq, "create"]),
        )
        .await?;
        if created["dispatchAllowed"].as_bool() != Some(true) {
            return Ok(json!({ "requestId": request_id, "state": created["state"] }));
        }
        let preflight = stamp.clone();
        if let Err(e) = tether.ask(|tx| Cmd::Preflight(preflight, tx)).await {
            let _ = node(&app, "tether-request", json!([shoot, request_id, null, "resolve", "failed"])).await;
            return Err(e);
        }
        let dispatched = node(
            &app,
            "tether-request",
            json!([shoot, request_id, null, "dispatch"]),
        )
        .await?;
        if dispatched["dispatchAllowed"].as_bool() != Some(true) {
            return Ok(json!({ "requestId": request_id, "state": dispatched["state"] }));
        }
        let (confirm_tx, confirm_rx) = oneshot::channel();
        tether
            .inner
            .confirmations
            .lock()
            .unwrap()
            .insert(request_id.clone(), confirm_tx);
        let id = request_id.clone();
        let outcome = tether.ask(|tx| Cmd::Trigger(stamp, Some(id), tx)).await;
        drop(shoot_guard);
        let resolve = |result: &'static str| {
            let app = app.clone();
            let args = json!([shoot, request_id, null, "resolve", result]);
            async move { node(&app, "tether-request", args).await }
        };
        match outcome {
            Ok(CaptureOutcome::Released) => {
                match tokio::time::timeout(SHUTTER_WAIT, confirm_rx).await {
                    Ok(Ok(exposure_id)) => Ok(json!({
                        "requestId": request_id,
                        "state": "confirmed",
                        "exposureId": exposure_id,
                    })),
                    _ => {
                        // The shutter was released but no photo has claimed this request: never
                        // report it as confirmed, and never let it claim a later shot's photo.
                        tether.inner.confirmations.lock().unwrap().remove(&request_id);
                        tether
                            .inner
                            .timed_out
                            .lock()
                            .unwrap()
                            .push(request_id.clone());
                        let resolved = resolve("outcomeUnknown").await?;
                        if resolved["state"] == "confirmed" {
                            return Ok(json!({
                                "requestId": request_id,
                                "state": "confirmed",
                                "exposureId": resolved["exposureId"],
                            }));
                        }
                        Ok(json!({
                            "requestId": request_id,
                            "state": "outcomeUnknown",
                            "exposureId": null,
                            "reason": "The camera released the shutter, but no photo arrived in time.",
                        }))
                    }
                }
            }
            Ok(CaptureOutcome::FocusNotAcquired) => {
                tether.inner.confirmations.lock().unwrap().remove(&request_id);
                resolve("failed").await?;
                Err(TetherError::new(
                    "CONTROL_LOCKED",
                    "The camera could not focus, so it did not take the picture.",
                )
                .retryable(true))
            }
            Err(e) => {
                tether.inner.confirmations.lock().unwrap().remove(&request_id);
                let unknown = e.uncertain;
                let state = resolve(if unknown { "outcomeUnknown" } else { "failed" }).await;
                if unknown {
                    return Ok(json!({
                        "requestId": request_id,
                        "state": state.ok().and_then(|s| s["state"].as_str().map(String::from)).unwrap_or_else(|| "outcomeUnknown".into()),
                        "reason": e.message,
                    }));
                }
                Err(e)
            }
        }
    }
    .await))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tether_focus(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    action: String,
    hold_id: Option<String>,
    direction: Option<String>,
    size: Option<u8>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            // A release must always reach the camera, even from a stale panel.
            if action != "release" {
                tether.check(&shoot_id, Some(epoch))?;
            }
            if let Some(h) = &hold_id {
                valid_id(h, "holdId")?;
            }
            let op = match action.as_str() {
                "press" => FocusOp::Press(hold_id.ok_or_else(|| {
                    TetherError::new("UNSUPPORTED", "A focus hold needs an ID.").field("holdId")
                })?),
                "release" => FocusOp::Release(hold_id),
                "pulse" => FocusOp::Pulse,
                "step" => {
                    let near = match direction.as_deref() {
                        Some("near") => true,
                        Some("far") => false,
                        _ => {
                            return Err(TetherError::new("UNSUPPORTED", "Choose near or far.")
                                .field("direction"))
                        }
                    };
                    let size = size.filter(|s| (1..=3).contains(s)).ok_or_else(|| {
                        TetherError::new("UNSUPPORTED", "Step size must be 1, 2 or 3.")
                            .field("size")
                    })?;
                    FocusOp::Step { near, size }
                }
                _ => {
                    return Err(
                        TetherError::new("UNSUPPORTED", "Unknown focus action.").field("action")
                    )
                }
            };
            let stamp = Stamp {
                shoot_id,
                epoch: Some(epoch),
            };
            tether.ask(|tx| Cmd::Focus(stamp, op, tx)).await
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_live(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    enabled: bool,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            tether.check(&shoot_id, Some(epoch))?;
            let stamp = Stamp {
                shoot_id,
                epoch: Some(epoch),
            };
            tether.ask(|tx| Cmd::Live(stamp, enabled, tx)).await
        }
        .await,
    ))
}

#[tauri::command]
pub async fn tether_live_frame(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    epoch: u64,
    stream_id: String,
    after_seq: u64,
) -> Result<Response, Value> {
    let tether = tether.inner().clone();
    tether
        .check(&shoot_id, Some(epoch))
        .map_err(|e| e.to_value())?;
    let hub = &tether.inner.live;
    match hub.wait(&stream_id, epoch, after_seq, POLL_TIMEOUT).await {
        Ok(Some(frame)) => {
            let header = hub.header(&stream_id, epoch, Some(&frame), after_seq);
            Ok(Response::new(live::pack_frame(&header, &frame.jpeg)))
        }
        Ok(None) => {
            let header = hub.header(&stream_id, epoch, None, after_seq);
            Ok(Response::new(live::pack_frame(&header, &[])))
        }
        Err(LiveError::Closed) | Err(LiveError::Invalid(_)) => {
            Err(TetherError::new("STREAM_CLOSED", "Live View stopped.")
                .retryable(false)
                .to_value())
        }
    }
}

#[tauri::command]
pub fn tether_composition_frame(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    test_seq: u64,
    preview_rev: Option<u64>,
) -> Result<Response, Value> {
    tether.check(&shoot_id, None).map_err(|e| e.to_value())?;
    let slot = tether.inner.composition_shot.lock().unwrap();
    composition_frame(
        slot.as_ref().filter(|s| s.shoot_id == shoot_id),
        test_seq,
        preview_rev,
    )
    .map(Response::new)
    .map_err(|e| e.to_value())
}

fn composition_frame(
    slot: Option<&CompositionShot>,
    seq: u64,
    rev: Option<u64>,
) -> TResult<Vec<u8>> {
    let shot = slot
        .filter(|s| s.test_seq == seq)
        .ok_or_else(|| TetherError::new("STALE_SHOT", "A newer test shot arrived."))?;
    if rev.is_some_and(|rev| rev != shot.preview_rev) {
        return Err(TetherError::new(
            "STALE_SHOT",
            "The test shot preview changed.",
        ));
    }
    if shot.preview_jpeg.is_empty() {
        return Err(TetherError::new(
            "NO_PREVIEW",
            "This test shot has no embedded JPEG preview.",
        ));
    }
    let header = json!({ "testSeq": shot.test_seq, "previewRev": shot.preview_rev, "width": shot.preview_width,
        "height": shot.preview_height, "mime": "image/jpeg" });
    Ok(live::pack_frame(&header, &shot.preview_jpeg))
}

#[tauri::command]
pub async fn tether_review_frame(
    app: AppHandle,
    session: String,
    id: String,
    kind: String,
    original: bool,
    content_rev: u64,
) -> Result<Response, Value> {
    let result: TResult<Response> = async {
        valid_id(&session, "session")?;
        valid_id(&id, "id")?;
        if kind != "preview" && kind != "full" {
            return Err(TetherError::new("UNSUPPORTED", "Invalid frame kind.").field("kind"));
        }
        let (frame, jpeg) = session_jpeg(
            &app,
            &session,
            &id,
            &kind,
            original,
            Some(content_rev),
            REVIEW_LIMIT,
        )
        .await?;
        if jpeg.len() < 4 || jpeg[..2] != [0xFF, 0xD8] {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "This photo has no JPEG rendition to analyze.",
            ));
        }
        let scanned = protocol::codec::jpeg_scan(&jpeg)
            .ok()
            .map(|(w, h, _)| (w as u64, h as u64));
        // The JPEG's own frame header describes these pixels; Node's sizes are the source's.
        let (width, height) = match scanned {
            Some((w, h)) => (Some(w), Some(h)),
            None => (frame["width"].as_u64(), frame["height"].as_u64()),
        };
        let header = json!({
            "v": 1,
            "id": id,
            "contentRev": frame["contentRev"],
            "width": width,
            "height": height,
            "jpegBytes": jpeg.len(),
        });
        Ok(Response::new(live::pack_frame(&header, &jpeg)))
    }
    .await;
    result.map_err(|e| e.to_value())
}

#[tauri::command]
pub async fn tether_overlay_pick(
    window: WebviewWindow,
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    source: String,
    session: Option<String>,
    id: Option<String>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(async move {
        tether.check(&shoot_id, None)?;
        if source == "clear" {
            let cleared = node(&app, "tether-asset", json!([shoot_id, "clear"])).await?;
            if let Some(asset_id) = cleared["assetId"].as_str() {
                if valid_id(asset_id, "assetId").is_ok() && cleared["inUse"].as_bool() == Some(false) {
                    let path = overlay_dir(&tether.inner).join(format!("{asset_id}.png"));
                    let _ = blocking(move || {
                        match std::fs::remove_file(&path) {
                            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                                Err(TetherError::new("IO_ERROR", e.to_string()))
                            }
                            _ => Ok(()),
                        }
                    })
                    .await;
                }
            }
            return Ok(Value::Null);
        }
        let (name, bytes) = match source.as_str() {
            "file" => {
                let picked = window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .set_title("Choose an overlay image")
                    .add_filter("Images", &["png", "jpg", "jpeg", "svg"])
                    .blocking_pick_file()
                    .and_then(|p| p.into_path().ok());
                let Some(path) = picked else { return Ok(Value::Null) };
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let bytes = blocking(move || {
                    let meta = std::fs::metadata(&path)
                        .map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
                    if meta.len() > OVERLAY_INPUT_LIMIT as u64 {
                        return Err(TetherError::new("UNSUPPORTED", "Overlay images must be 32 MB or smaller."));
                    }
                    std::fs::read(&path).map_err(|e| TetherError::new("IO_ERROR", e.to_string()))
                })
                .await?;
                (name, bytes)
            }
            "session" => {
                let session = session.ok_or_else(|| TetherError::new("UNSUPPORTED", "Choose a photo.").field("session"))?;
                let id = id.ok_or_else(|| TetherError::new("UNSUPPORTED", "Choose a photo.").field("id"))?;
                valid_id(&session, "session")?;
                valid_id(&id, "id")?;
                let (_, bytes) = session_jpeg(&app, &session, &id, "preview", false, None, OVERLAY_INPUT_LIMIT).await?;
                (String::new(), bytes)
            }
            _ => return Err(TetherError::new("UNSUPPORTED", "Unknown overlay source.").field("source")),
        };
        if looks_like_svg(&name, &bytes) {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "SVG overlays are not supported yet: PhotoCull cannot rasterize SVG safely. Export the overlay as PNG and choose that file.",
            ));
        }
        let dir = overlay_dir(&tether.inner);
        let (png, width, height, asset_id, sha) = blocking(move || {
            let (png, w, h) = rasterize_overlay(&bytes)?;
            let (asset_id, sha) = store_overlay(&dir, &png)?;
            Ok((png, w, h, asset_id, sha))
        })
        .await?;
        node(
            &app,
            "tether-asset",
            json!([shoot_id, "bind", { "assetId": asset_id, "sha256": sha, "width": width, "height": height, "bytes": png.len() }]),
        )
        .await?;
        Ok(json!({ "assetId": asset_id, "width": width, "height": height }))
    }
    .await))
}

#[tauri::command]
pub async fn tether_overlay_image(
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    asset_id: String,
) -> Result<Response, Value> {
    let tether = tether.inner().clone();
    let result: TResult<Response> = async {
        tether.check(&shoot_id, None)?;
        valid_id(&asset_id, "assetId")?;
        let asset = node(
            &app,
            "tether-asset",
            json!([shoot_id, "lookup", { "assetId": asset_id }]),
        )
        .await?;
        if asset.is_null() {
            return Err(TetherError::new(
                "UNSUPPORTED",
                "The overlay image is no longer available. Choose it again.",
            ));
        }
        let expected = str_field(&asset, "sha256")?.to_lowercase();
        let path = overlay_dir(&tether.inner).join(format!("{asset_id}.png"));
        let bytes = blocking(move || {
            let meta = std::fs::symlink_metadata(&path).map_err(|_| {
                TetherError::new(
                    "UNSUPPORTED",
                    "The overlay image is no longer available. Choose it again.",
                )
            })?;
            if !meta.is_file() || meta.len() > OVERLAY_INPUT_LIMIT as u64 {
                return Err(TetherError::new(
                    "UNSUPPORTED",
                    "The overlay image is damaged. Choose it again.",
                ));
            }
            let bytes =
                std::fs::read(&path).map_err(|e| TetherError::new("IO_ERROR", e.to_string()))?;
            if transfer::hex(&transfer::Sha256::digest(&bytes)) != expected {
                return Err(TetherError::new(
                    "UNSUPPORTED",
                    "The overlay image is damaged. Choose it again.",
                ));
            }
            Ok(bytes)
        })
        .await?;
        Ok(Response::new(bytes))
    }
    .await;
    result.map_err(|e| e.to_value())
}

#[tauri::command]
pub async fn tether_recover(
    app: AppHandle,
    tether: State<'_, TetherManager>,
    shoot_id: String,
    exposure_id: String,
    member_id: Option<String>,
    op: String,
    name: Option<String>,
) -> Result<Value, String> {
    let tether = tether.inner().clone();
    Ok(envelope(
        async move {
            let _shoot = tether.inner.shoot_lock.lock().await;
            let binding = tether.check(&shoot_id, None)?;
            valid_id(&exposure_id, "exposureId")?;
            if let Some(m) = &member_id {
                valid_id(m, "memberId")?;
            }
            if !matches!(
                op.as_str(),
                "retry" | "finishSingle" | "saveSeparate" | "repairName"
            ) {
                return Err(TetherError::new("UNSUPPORTED", "Unknown recovery action.").field("op"));
            }
            if op == "repairName" {
                let n = name.as_deref().unwrap_or("").trim();
                transfer::validate_component(n).map_err(TetherError::from_transfer)?;
            }
            let mut detail = json!({ "action": op, "exposureId": exposure_id });
            if let Some(m) = &member_id {
                detail["memberId"] = m.clone().into();
            }
            if let Some(n) = &name {
                detail["name"] = n.trim().into();
            }
            let result = node(
                &app,
                "tether-journal",
                json!([shoot_id, "recovery", detail]),
            )
            .await?;
            // The photographer has dealt with what stopped saving; photos may leave the camera again.
            *tether.inner.drain_hold.lock().unwrap() = None;
            let records: Vec<Value> = result["records"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|r| r["exposureId"].as_str() == Some(&exposure_id))
                .collect();
            if op == "finishSingle" {
                // The photographer gave up on the missing files of this exposure.
                tether
                    .inner
                    .recovery
                    .lock()
                    .unwrap()
                    .retain(|_, r| r.exposure_id != exposure_id);
            }
            for record in &records {
                let Some(member) = record["memberId"].as_str() else {
                    continue;
                };
                if member_id.as_deref().is_some_and(|m| m != member) {
                    continue;
                }
                let held_in_memory = tether.inner.recovery.lock().unwrap().contains_key(member);
                if held_in_memory && record["state"].as_str() != Some("held") {
                    spawn_rewrite(tether.inner.clone(), binding.clone(), member.to_string());
                } else if matches!(record["state"].as_str(), Some("staged" | "reserved")) {
                    let name = record["originalName"].as_str().unwrap_or_default();
                    spawn_recover(
                        tether.inner.clone(),
                        binding.clone(),
                        member.to_string(),
                        name.to_string(),
                        journaled_receipt(record),
                    );
                }
            }
            let issue = records
                .iter()
                .find(|r| r["state"].as_str() == Some("held"))
                .map(|r| json!({ "code": r["code"], "message": r["message"] }));
            let state = if records.is_empty() {
                "complete"
            } else if issue.is_some() {
                "needsAttention"
            } else {
                "transferring"
            };
            Ok(json!({ "exposureId": exposure_id, "state": state, "issue": issue }))
        }
        .await,
    ))
}

#[tauri::command]
pub fn tether_presented(
    tether: State<'_, TetherManager>,
    shoot_id: String,
    exposure_id: String,
    ordinal: u64,
    quality: String,
) -> Value {
    if tether.check(&shoot_id, None).is_ok()
        && valid_id(&exposure_id, "exposureId").is_ok()
        && ordinal > 0
        && (quality == "quick" || quality == "settled")
    {
        crate::logs::write(&format!("tether presented ordinal {ordinal} ({quality})"));
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composition_routes_both_members_together_and_discards_late_test_arrivals() {
        let raw = ObjectInfo {
            sequence_number: 41,
            filename: "DSC00041.ARW".into(),
            ..Default::default()
        };
        let jpeg = ObjectInfo {
            filename: "dsc00041.JPG".into(),
            ..raw.clone()
        };
        let next = ObjectInfo {
            sequence_number: 42,
            filename: "DSC00042.ARW".into(),
            ..raw.clone()
        };
        let raw = CompositionCohort::new(1, &raw, FileKind::Raw);
        let jpeg = CompositionCohort::new(1, &jpeg, FileKind::Jpeg);
        let next = CompositionCohort::new(1, &next, FileKind::Raw);
        let mut cohorts = CaptureCohorts::default();
        assert_eq!(cohorts.test_disposition(&raw, false), None);
        assert_eq!(
            cohorts.test_disposition(&raw, true),
            Some(TestDisposition {
                new_shot: true,
                discard: false
            })
        );
        cohorts.remember_test(raw.clone());
        cohorts.latest_test = Some(raw);
        assert_eq!(
            cohorts.test_disposition(&jpeg, true),
            Some(TestDisposition {
                new_shot: false,
                discard: false
            })
        );
        assert_eq!(
            cohorts.test_disposition(&next, true),
            Some(TestDisposition {
                new_shot: true,
                discard: false
            })
        );
        cohorts.latest_test = None;
        assert_eq!(
            cohorts.test_disposition(&jpeg, false),
            Some(TestDisposition {
                new_shot: false,
                discard: true
            })
        );
        cohorts.pending_test = Some(Instant::now());
        assert_eq!(
            cohorts.check_transition(false, false).unwrap_err().code,
            "CAPTURE_PENDING"
        );
        assert_eq!(
            cohorts.check_transition(true, false).unwrap_err().code,
            "CAPTURE_PENDING"
        );
        cohorts.pending_test = Some(Instant::now() - SHUTTER_WAIT);
        cohorts.check_transition(false, false).unwrap();
        assert!(cohorts.pending_test.is_none());
        assert_eq!(cohorts.test_disposition(&next, false), None);
        cohorts.awaiting_quiet_queue = true;
        assert_eq!(cohorts.test_disposition(&next, true), None);
        cohorts.awaiting_quiet_queue = false;
        cohorts.kept_single.push_back(jpeg.clone());
        assert_eq!(cohorts.test_disposition(&jpeg, true), None);
        cohorts.last_regular = Some(next.clone());
        assert_eq!(cohorts.test_disposition(&next, true), None);
    }

    #[test]
    fn composition_selects_the_largest_complete_raw_preview_and_preserves_camera_jpegs() {
        let jpeg = |width: u16, height: u16, thumbnail: &[u8]| {
            let mut bytes = vec![0xff, 0xd8];
            if !thumbnail.is_empty() {
                bytes.extend_from_slice(&[0xff, 0xe1]);
                bytes.extend_from_slice(&(2 + thumbnail.len() as u16).to_be_bytes());
                bytes.extend_from_slice(thumbnail);
            }
            bytes.extend_from_slice(&[0xff, 0xc0, 0, 11, 8]);
            bytes.extend_from_slice(&height.to_be_bytes());
            bytes.extend_from_slice(&width.to_be_bytes());
            bytes.extend_from_slice(&[1, 1, 0x11, 0]);
            bytes.extend_from_slice(&[0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
            bytes.extend_from_slice(&[0xff, 0x00, 0xff, 0xd0, 0xff, 0xd9]);
            bytes
        };
        let thumbnail = jpeg(120, 80, &[]);
        let full = jpeg(2048, 1365, &thumbnail);
        let mut raw = b"II*\0\xff\xd8\xff\xe1\xff\xff".to_vec();
        raw.extend_from_slice(&thumbnail);
        raw.extend_from_slice(b"raw data");
        raw.extend_from_slice(&full);
        raw.extend_from_slice(&jpeg(3000, 2000, &[])[..12]);
        assert_eq!(embedded_jpeg(&raw), Some((full.as_slice(), 2048, 1365)));
        assert!(embedded_jpeg(&raw[raw.len() - 12..]).is_none());
        let outer = jpeg(80, 50, &full);
        assert_eq!(embedded_jpeg(&outer), Some((full.as_slice(), 2048, 1365)));
        assert!(embedded_jpeg(&jpeg(16000, 16000, &[])).is_none());
        let root = CompositionTestDir::new();
        let raw_path = root.0.join("sample.ARW");
        let offset = 64u32 << 20;
        let mut file = fs::File::create(&raw_path).unwrap();
        file.write_all(b"II*\0\x08\0\0\0\x02\0").unwrap();
        for (tag, value) in [(0x0201u16, offset), (0x0202, full.len() as u32)] {
            file.write_all(&tag.to_le_bytes()).unwrap();
            file.write_all(&[4, 0, 1, 0, 0, 0]).unwrap();
            file.write_all(&value.to_le_bytes()).unwrap();
        }
        file.write_all(&[0; 4]).unwrap();
        file.seek(SeekFrom::Start(u64::from(offset))).unwrap();
        file.write_all(&full).unwrap();
        drop(file);
        assert_eq!(
            read_test_image(&raw_path, "sample.ARW", FileKind::Raw, json!({}))
                .unwrap()
                .1,
            Some((full.clone(), 2048, 1365))
        );
        let mut jpeg = full;
        jpeg.extend_from_slice(b"padding");
        let path = root.0.join("sample.JPG");
        fs::write(&path, &jpeg).unwrap();
        assert_eq!(
            read_test_image(&path, "sample.JPG", FileKind::Jpeg, json!({}))
                .unwrap()
                .1,
            Some((jpeg, 2048, 1365))
        );
    }

    struct CompositionTestDir(PathBuf);

    impl CompositionTestDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("photocull-composition-{}", unique_suffix(0)));
            fs::create_dir(&dir).unwrap();
            Self(dunce::canonicalize(dir).unwrap())
        }
    }

    impl Drop for CompositionTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_shot(dir: &Path, test_seq: u64, kinds: &[FileKind]) -> CompositionShot {
        CompositionShot {
            shoot_id: "shoot".into(),
            test_seq,
            epoch: 1,
            promotion_key: format!("composition:test:{test_seq}"),
            captured_at: "2026-11-25T10:00:00".into(),
            members: kinds
                .iter()
                .map(|&kind| {
                    let path = dir.join(format!(
                        "test-{test_seq}-{}.{}",
                        kind.role(),
                        kind.extension().to_ascii_lowercase()
                    ));
                    let receipt =
                        transfer::stage_complete(path.clone(), kind.extension().as_bytes())
                            .unwrap();
                    CompositionMember {
                        path,
                        name: format!("DSC001.{ext}", ext = kind.extension()),
                        kind,
                        receipt,
                    }
                })
                .collect(),
            expected_roles: vec![HostRole::Jpeg, HostRole::Raw],
            preview_rev: 0,
            preview_jpeg: Vec::new(),
            preview_width: 0,
            preview_height: 0,
            camera_meta: json!({ "iso": 100, "aperture": 8, "shutter": "1/200", "focalLength": 50 }),
        }
    }

    #[test]
    fn composition_replaces_both_members_and_cleans_only_test_files() {
        let root = CompositionTestDir::new();
        let dir = composition_dir(&root.0).unwrap();
        let unrelated = dir.join("notes");
        fs::write(&unrelated, b"notes").unwrap();
        let shot = |test_seq, kinds: &[FileKind]| test_shot(&dir, test_seq, kinds);
        let mut current = Some(shot(1, &[FileKind::Jpeg, FileKind::Raw]));
        let payload = composition_payload("shoot", true, current.as_ref());
        assert_eq!(payload["format"], "raw");
        assert_eq!(payload["meta"]["focalLength"], "50mm");
        replace_composition(
            &root.0,
            &root.0,
            &mut current,
            Some(shot(2, &[FileKind::Jpeg])),
        )
        .unwrap();
        assert_eq!(current.as_ref().unwrap().test_seq, 2);
        assert!(!dir.join("test-1-raw.arw").exists());
        assert!(!dir.join("test-1-jpeg.jpg").exists());
        assert!(dir.join("test-2-jpeg.jpg").is_file());
        clean_composition(&root.0, &root.0).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert_eq!(fs::read(&unrelated).unwrap(), b"notes");
        fs::remove_file(unrelated).unwrap();
        clean_composition(&root.0, &root.0).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn keep_waits_for_the_companion_and_actions_acknowledge_only_the_selected_shot() {
        let root = CompositionTestDir::new();
        let dir = composition_dir(&root.0).unwrap();
        let mut shot = test_shot(&dir, 8, &[FileKind::Jpeg]);
        let payload = composition_payload("shoot", true, Some(&shot));
        assert_eq!(payload["pairComplete"], false);
        assert_eq!(payload["roles"], json!(["jpeg"]));
        let pending = shot.check_keep(false).unwrap_err();
        assert_eq!(
            (pending.code.as_str(), pending.message.as_str()),
            (
                "PAIR_PENDING",
                "Waiting for the RAW companion before keeping this shot."
            )
        );
        shot.check_keep(true).unwrap();
        let raw = test_shot(&dir, 8, &[FileKind::Raw]).members.pop().unwrap();
        shot.add_companion(raw, Value::Null, None);
        shot.check_keep(false).unwrap();
        let payload = composition_payload("shoot", true, Some(&shot));
        assert_eq!(payload["roles"], json!(["jpeg", "raw"]));
        assert_eq!(payload["pairComplete"], true);
        for op in [
            CompositionOp::Keep(Some(7), true),
            CompositionOp::Discard(Some(7)),
        ] {
            assert_eq!(op.selected_seq(Some(&shot)).unwrap_err().code, "STALE_SHOT");
        }
        for op in [
            CompositionOp::Keep(None, false),
            CompositionOp::Discard(Some(8)),
        ] {
            assert_eq!(op.selected_seq(Some(&shot)).unwrap(), Some(8));
        }
        assert_eq!(
            KeepPromotion::from_shot(&shot)
                .members
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            ["DSC001.ARW", "DSC001.JPG"]
        );
    }

    #[test]
    fn flash_and_preview_revisions_follow_the_staged_exposure() {
        let root = CompositionTestDir::new();
        let dir = composition_dir(&root.0).unwrap();
        let mut shot = test_shot(&dir, 1, &[FileKind::Raw]);
        for (flags, expected, kind) in [
            (0x19, "Fired", FileKind::Raw),
            (0x18, "Did not fire", FileKind::Jpeg),
        ] {
            let mut tiff = b"II*\0\x08\0\0\0\x01\0\x69\x87\x04\0\x01\0\0\0\x1a\0\0\0\0\0\0\0\x01\0\x09\x92\x03\0\x01\0\0\0".to_vec();
            tiff.extend_from_slice(&[flags, 0, 0, 0, 0, 0, 0, 0]);
            let bytes = if kind == FileKind::Raw {
                tiff
            } else {
                let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
                jpeg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
                jpeg.extend_from_slice(b"Exif\0\0");
                jpeg.extend_from_slice(&tiff);
                jpeg.extend_from_slice(&[0xff, 0xd9]);
                jpeg
            };
            shot.camera_meta = composition_metadata(json!({}), &bytes, kind);
            assert_eq!(
                composition_payload("shoot", true, Some(&shot))["meta"]["flash"],
                expected
            );
        }
        shot.preview_rev = 1;
        shot.preview_jpeg = vec![1];
        let jpeg = test_shot(&dir, 1, &[FileKind::Jpeg]).members.pop().unwrap();
        shot.add_companion(jpeg, Value::Null, Some((vec![2], 600, 400)));
        assert_eq!(
            composition_payload("shoot", true, Some(&shot))["previewRev"],
            2
        );
        assert_eq!(
            composition_frame(Some(&shot), 0, Some(2)).unwrap_err().code,
            "STALE_SHOT"
        );
        assert_eq!(
            composition_frame(Some(&shot), 1, Some(1)).unwrap_err().code,
            "STALE_SHOT"
        );
        let frame = composition_frame(Some(&shot), 1, Some(2)).unwrap();
        let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
        assert_eq!(
            header,
            json!({"testSeq": 1, "previewRev": 2, "width": 600, "height": 400, "mime": "image/jpeg"})
        );
        assert_eq!(frame[4 + length..], [2]);
    }

    #[test]
    fn interrupted_keep_protects_selected_files_through_cleanup_and_reopen() {
        let root = CompositionTestDir::new();
        let data = CompositionTestDir::new();
        let dir = composition_dir(&root.0).unwrap();
        let mut slot = Some(test_shot(&dir, 7, &[FileKind::Raw, FileKind::Jpeg]));
        let intent = KeepPromotion::from_shot(slot.as_ref().unwrap())
            .record(&data.0, &root.0)
            .unwrap();
        let stage_first = |intent: &KeepPromotion| {
            let (id, member) = intent.member(&root.0, &intent.members[0]);
            let rel = format!("{}/{id}.part", transfer::STAGE_DIR);
            stage_kept_member(&root.0, &rel, &member).unwrap();
            transfer::stage_path(&root.0, &rel).unwrap()
        };
        let stage = stage_first(&intent);
        let (id, second) = intent.member(&root.0, &intent.members[1]);
        fs::write(&second.path, b"bad").unwrap();
        let rel = format!("{}/{id}.part", transfer::STAGE_DIR);
        assert_eq!(
            stage_kept_member(&root.0, &rel, &second).unwrap_err().code,
            "INCOMPLETE"
        );
        replace_composition(&data.0, &root.0, &mut slot, None).unwrap();
        clean_composition(&data.0, &root.0).unwrap();
        let reopened = KeepPromotion::pending(&data.0, &root.0)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(fs::read(dir.join("test-7-raw.arw")).unwrap(), b"ARW");
        assert_eq!(fs::read(&second.path).unwrap(), b"bad");
        assert_eq!(stage_first(&reopened), stage);
        fs::write(&second.path, b"JPG").unwrap();
        stage_kept_member(&root.0, &rel, &second).unwrap();
        for (stage, name) in [
            (stage, "kept.ARW"),
            (transfer::stage_path(&root.0, &rel).unwrap(), "kept.JPG"),
        ] {
            transfer::publish_no_replace(&stage, &root.0.join(name)).unwrap();
        }
        reopened.finish(&data.0, &root.0).unwrap();
        clean_composition(&data.0, &root.0).unwrap();
        assert!(!dir.exists());
        assert!(!keep_file(&data.0, &root.0, 7).exists());
        assert_eq!(fs::read(root.0.join("kept.ARW")).unwrap(), b"ARW");
        assert_eq!(fs::read(root.0.join("kept.JPG")).unwrap(), b"JPG");
    }

    #[test]
    fn close_reports_offline_with_a_cleanup_warning_when_the_scratch_directory_changed() {
        let root = CompositionTestDir::new();
        let dir = composition_dir(&root.0).unwrap();
        fs::remove_dir(&dir).unwrap();
        fs::write(&dir, b"foreign file").unwrap();
        let reply = closed_shoot(&root.0, &root.0, &json!(2), 3);
        assert_eq!(reply["state"], "offline");
        assert_eq!(reply["epoch"], 3);
        assert_eq!(reply["pending"], 2);
        assert!(reply["cleanupWarning"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
        assert_eq!(fs::read(dir).unwrap(), b"foreign file");
    }

    #[test]
    fn keep_staging_checks_the_test_receipt_and_preserves_the_test_file() {
        let root = CompositionTestDir::new();
        let path = composition_dir(&root.0).unwrap().join("test-1-raw.arw");
        let data = b"II*\0synthetic raw";
        let member = CompositionMember {
            receipt: transfer::stage_complete(path.clone(), data).unwrap(),
            path,
            name: "DSC001.ARW".into(),
            kind: FileKind::Raw,
        };
        let rel = ".photocull-tether/keep.part";
        stage_kept_member(&root.0, rel, &member).unwrap();
        stage_kept_member(&root.0, rel, &member).unwrap();
        let stage = transfer::stage_path(&root.0, rel).unwrap();
        assert_eq!(fs::read(&stage).unwrap(), data);
        assert_eq!(fs::read(&member.path).unwrap(), data);
        fs::remove_file(&stage).unwrap();
        fs::write(&member.path, b"II*\0different raw").unwrap();
        assert_eq!(
            stage_kept_member(&root.0, rel, &member).unwrap_err().code,
            "INCOMPLETE"
        );
        assert!(!stage.exists());
    }

    #[test]
    fn node_error_detail_maps_to_stable_codes() {
        let failure = Failure {
            message: "x".into(),
            detail: Some(
                json!({ "code": "STALE_REV", "message": "Changed", "retryable": true, "currentRev": 7 }),
            ),
        };
        let e = TetherError::from_backend(failure);
        assert_eq!((e.code.as_str(), e.current_rev), ("STALE_REV", Some(7)));
        let e = TetherError::from_backend(Failure::from("plain"));
        assert_eq!(e.code, "IO_ERROR");
        let odd = Failure {
            message: "x".into(),
            detail: Some(json!({ "code": "WHATEVER", "message": "m" })),
        };
        assert_eq!(TetherError::from_backend(odd).code, "IO_ERROR");
    }

    #[test]
    fn final_targets_stay_inside_the_library() {
        let root = std::env::temp_dir().join(format!("photocull-final-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Blue")).unwrap();
        let binding = Binding {
            shoot_id: "s".into(),
            session: "x".into(),
            root: root.clone(),
            library_root: root.clone(),
        };
        assert_eq!(
            final_target(&binding, "Blue/A-0001.ARW").unwrap(),
            root.join("Blue/A-0001.ARW")
        );
        assert_eq!(final_target(&binding, "A.JPG").unwrap(), root.join("A.JPG"));
        for bad in ["../x.ARW", "Blue/", "Blue/../x", "Missing/x.ARW", ".hidden"] {
            assert!(final_target(&binding, bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn commands_are_checked_against_the_connection_they_were_issued_for() {
        let stamp = |epoch| Stamp {
            shoot_id: "a".into(),
            epoch,
        };
        assert!(check_stamp(&stamp(Some(3)), Some("a"), Some("a"), 3).is_ok());
        assert!(check_stamp(&stamp(None), Some("a"), None, 9).is_ok());
        // Queued behind a reconnect, for another shoot, or for a connection the actor never made.
        for (s, bound, actor, epoch) in [
            (stamp(Some(3)), Some("a"), Some("a"), 4),
            (stamp(Some(3)), Some("b"), Some("a"), 3),
            (stamp(None), None, None, 0),
            (stamp(Some(3)), Some("a"), Some("b"), 3),
            (stamp(Some(0)), Some("a"), None, 0),
        ] {
            let e = check_stamp(&s, bound, actor, epoch).unwrap_err();
            assert_eq!(e.code, "STALE_SESSION");
        }
    }

    #[test]
    fn wifi_connect_failures_keep_their_typed_codes() {
        #[cfg(windows)]
        let (denied, refused, unreachable) = (10013, 10061, 10065);
        #[cfg(target_os = "macos")]
        let (denied, refused, unreachable) = (13, 61, 65);
        #[cfg(not(any(windows, target_os = "macos")))]
        let (denied, refused, unreachable) = (13, 111, 113);
        let os = |code: i64| {
            SessionError::Transport(TransportError::Native {
                domain: "PTP/IP".into(),
                code,
                message: String::new(),
            })
        };
        let cases = [
            (
                SessionError::Transport(TransportError::Permission),
                "PAIRING_REFUSED",
            ),
            (
                SessionError::Transport(TransportError::InUse),
                "CAMERA_BUSY",
            ),
            (
                SessionError::Transport(TransportError::TimedOut),
                "CAMERA_UNREACHABLE",
            ),
            (os(denied), "LOCAL_NETWORK_DENIED"),
            (os(refused), "CAMERA_UNREACHABLE"),
            (os(unreachable), "CAMERA_UNREACHABLE"),
            (os(0), "CAMERA_LOST"),
        ];
        for (error, code) in cases {
            let mapped = wifi_connect_error(error);
            assert_eq!(mapped.code, code, "{}", mapped.message);
            assert!(mapped.retryable, "{code}");
        }
        let auth = ssh_error(wifi::SshError::Authentication("wrong password".into()));
        assert_eq!(
            (auth.code.as_str(), auth.retryable),
            ("SSH_AUTH_FAILED", false)
        );
        let gone = ssh_error(wifi::SshError::Unreachable("no route".into()));
        assert_eq!(gone.code, "CAMERA_UNREACHABLE");
        let cancelled = ssh_error(wifi::SshError::Cancelled);
        assert!(
            !cancelled.retryable,
            "a cancelled connection is not retried"
        );
    }

    #[test]
    fn automatic_reconnection_follows_the_preference() {
        assert!(auto_reconnect_enabled(
            &json!({ "tether": { "autoReconnect": true } })
        ));
        assert!(!auto_reconnect_enabled(
            &json!({ "tether": { "autoReconnect": false } })
        ));
        assert!(auto_reconnect_enabled(&json!({})), "the default reconnects");
    }

    #[test]
    fn recovery_only_trusts_a_complete_journaled_receipt() {
        let sha = "AB".repeat(32);
        let receipt = journaled_receipt(&json!({ "bytes": 10, "sha256": sha })).unwrap();
        assert_eq!((receipt.bytes, receipt.sha256), (10, "ab".repeat(32)));
        for record in [
            json!({ "bytes": 10 }),
            json!({ "bytes": 0, "sha256": "ab".repeat(32) }),
            json!({ "bytes": 10, "sha256": "ab".repeat(31) }),
            json!({ "bytes": 10, "sha256": "zz".repeat(32) }),
        ] {
            assert!(journaled_receipt(&record).is_none(), "{record}");
        }
    }

    #[test]
    fn reconnecting_never_guesses_a_body_without_a_serial() {
        let device = |id: &str, vendor| IccDevice {
            id: id.into(),
            name: "ILCE-7M3".into(),
            usb_vendor_id: vendor,
            usb_product_id: 0,
            can_send_ptp: true,
            active: false,
        };
        let anonymous = DeviceDesc {
            device_id: "old".into(),
            model: "ILCE-7M3".into(),
            ..DeviceDesc::default()
        };
        let other = [device("new", icc::SONY_USB_VENDOR)];
        assert_eq!(reconnect_target(&anonymous, &other), None);
        let back = [
            device("new", icc::SONY_USB_VENDOR),
            device("old", icc::SONY_USB_VENDOR),
        ];
        assert_eq!(reconnect_target(&anonymous, &back).as_deref(), Some("old"));
        // With a serial the sole Sony body is tried, and the serial decides after opening.
        let known = DeviceDesc {
            serial: "0001".into(),
            ..anonymous.clone()
        };
        assert_eq!(reconnect_target(&known, &other).as_deref(), Some("new"));
        assert!(same_body(&known, "new", "ILCE-7M3", "0001 "));
        assert!(!same_body(&known, "old", "ILCE-7M3", "0002"));
        assert!(same_body(&anonymous, "old", "ILCE-7M3 ", ""));
        assert!(!same_body(&anonymous, "new", "ILCE-7M3", ""));
        assert!(!same_body(&anonymous, "old", "ILCE-7CM2", ""));
    }

    #[test]
    fn a_resumed_shoot_attaches_only_its_own_body() {
        let first = body_key("ILCE-7M4", "0001", None).unwrap();
        assert_eq!(first.len(), 32);
        assert_eq!(
            body_key("ILCE-7M4 ", " 0001", Some([9; 16])),
            Some(first.clone())
        );
        assert_ne!(body_key("ILCE-7M4", "0002", None), Some(first.clone()));
        assert_ne!(
            body_key("ILCE-7M4", "", Some([1; 16])),
            body_key("ILCE-7M4", "", Some([2; 16]))
        );
        assert_eq!(body_key("ILCE-7M4", "", None), None);
        let expect = |body_key: Option<&str>| ExpectedBody {
            device_id: "usb-1".into(),
            model: "ILCE-7M4".into(),
            body_key: body_key.map(String::from),
        };
        // A serial or responder decides, wherever the body is plugged in.
        assert!(expect(Some(&first)).matches("usb-9", "ILCE-7M4", Some(&first)));
        let other = body_key("ILCE-7M4", "0002", None).unwrap();
        assert!(!expect(Some(&first)).matches("usb-1", "ILCE-7M4", Some(&other)));
        assert!(!expect(Some(&first)).matches("usb-1", "ILCE-7M4", None));
        // Without either, only the same device and model count.
        assert!(expect(None).matches("usb-1", "ILCE-7M4 ", None));
        assert!(!expect(None).matches("usb-2", "ILCE-7M4", None));
        assert!(!expect(None).matches("usb-1", "ILCE-7CM2", None));
        assert!(!expect(None).matches("usb-1", "ILCE-7M4", Some(&first)));
    }

    #[test]
    fn a_stopped_link_frees_its_camera_and_belongs_to_its_shoot() {
        let snapshot = |state: &str, shoot: Value| json!({ "shootId": shoot, "device": { "deviceId": "usb-1", "model": "ILCE-7M4" }, "connection": { "state": state } });
        assert_eq!(
            held_device(&snapshot("ready", json!("a"))).as_deref(),
            Some("usb-1")
        );
        assert_eq!(
            held_device(&snapshot("reconnecting", json!("a"))).as_deref(),
            Some("usb-1")
        );
        assert_eq!(held_device(&snapshot("offline", json!("a"))), None);
        assert_eq!(
            attached_camera(&snapshot("offline", json!("a")), "a")["deviceId"],
            "usb-1"
        );
        assert_eq!(
            attached_camera(&snapshot("offline", json!("a")), "b"),
            Value::Null
        );
        assert_eq!(
            attached_camera(&snapshot("offline", Value::Null), "b"),
            Value::Null
        );
    }

    #[test]
    fn a_keep_recorded_before_its_folder_was_saved_still_reads() {
        let saved = json!({ "shoot_id": "s", "seq": 3, "key": "composition:k", "epoch": 1, "meta": {}, "members": [] });
        let promotion: KeepPromotion = serde_json::from_value(saved).unwrap();
        assert_eq!(promotion.target, Value::Null);
        let target = json!({ "relative": "Day 1/Blue", "dirId": "1:2" });
        let promotion = KeepPromotion {
            target: target.clone(),
            ..promotion
        };
        let reread: KeepPromotion =
            serde_json::from_value(serde_json::to_value(&promotion).unwrap()).unwrap();
        assert_eq!(reread.target, target);
    }

    #[test]
    fn a_wifi_reconnect_must_find_the_same_responder() {
        let guid = [7u8; 16];
        let mut camera = WifiCandidate::new("192.168.1.40".parse().unwrap(), "");
        camera.auth = WifiAuth::Plain;
        let mut route = AttachedWifiRoute::attach(&camera, Path::new("/nonexistent")).unwrap();
        route.responder_guid = Some(guid);
        route.model = "ILCE-7CM2".into();
        let previous = DeviceDesc {
            device_id: "wifi:192.168.1.40".into(),
            model: "ILCE-7CM2".into(),
            wifi: true,
            route: Some(route),
            ..DeviceDesc::default()
        };
        assert!(same_wifi_body(&previous, "ILCE-7CM2 ", "", Some(guid)));
        assert!(!same_wifi_body(&previous, "ILCE-7CM2", "", Some([8; 16])));
        let with_serial = DeviceDesc {
            serial: "0001".into(),
            ..previous.clone()
        };
        assert!(!same_wifi_body(
            &with_serial,
            "ILCE-7CM2",
            "0002",
            Some(guid)
        ));
        let unattached = DeviceDesc {
            route: None,
            ..previous
        };
        assert!(!same_wifi_body(&unattached, "ILCE-7CM2", "", Some(guid)));
    }

    #[test]
    fn panel_values_are_numbers_for_ranges_and_steps_for_detents() {
        let prop = |kind, relative, choices: Vec<protocol::session::Choice>| CameraProperty {
            key: "k",
            label: "K",
            code: 0xD20F,
            kind,
            value: Some("15E0".into()),
            display: "5600K".into(),
            access: protocol::session::Access::ReadWrite,
            choices,
            range: None,
            reason: None,
            prop_rev: 1,
            relative,
            number: (kind == PropertyKind::Range).then_some(5600),
        };
        let kelvin = prop(PropertyKind::Range, false, vec![]);
        assert_eq!(property_json(&kelvin)["value"], json!(5600));
        assert_eq!(
            wire_value(Some(&kelvin), &SetValue::Number(5600.0)).unwrap(),
            "5600"
        );
        assert_eq!(
            wire_value(Some(&kelvin), &SetValue::Text("5600".into())).unwrap(),
            "5600"
        );
        assert!(wire_value(Some(&kelvin), &SetValue::Number(5600.5)).is_err());

        let aperture = prop(PropertyKind::Range, true, vec![]);
        let json = property_json(&aperture);
        assert_eq!(
            (json["relative"].clone(), json["stepOnly"].clone()),
            (json!(true), json!(true))
        );
        assert_eq!(
            wire_value(Some(&aperture), &SetValue::Number(-2.0)).unwrap(),
            "-2"
        );
        assert_eq!(
            wire_value(Some(&aperture), &SetValue::Number(1.0)).unwrap(),
            "+1"
        );
        assert!(wire_value(Some(&aperture), &SetValue::Number(0.0)).is_err());

        let list = prop(PropertyKind::Enum, false, vec![]);
        assert_eq!(property_json(&list)["value"], json!("15E0"));
        assert!(wire_value(Some(&list), &SetValue::Number(4.0)).is_err());
        assert_eq!(
            wire_value(Some(&list), &SetValue::Text("0004".into())).unwrap(),
            "0004"
        );
    }

    #[test]
    fn a_refused_destination_is_left_untouched() {
        let root = std::env::temp_dir().join(format!("photocull-card-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let refused = preflight_root(&root, |_| {
            Err(TetherError::new(
                "UNSUPPORTED",
                "Camera cards cannot be tether destinations.",
            ))
        });
        assert_eq!(refused.unwrap_err().code, "UNSUPPORTED");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let (accepted, _) = preflight_root(&root, |_| Ok(())).unwrap();
        assert!(accepted.join(transfer::STAGE_DIR).is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_replaced_while_it_is_checked_gets_no_staging_folder() {
        let root = std::env::temp_dir().join(format!("photocull-swap-{}", std::process::id()));
        let moved = root.with_extension("moved");
        std::fs::create_dir_all(&root).unwrap();
        let replaced = preflight_root(&root, |checked| {
            std::fs::rename(checked, &moved).unwrap();
            std::fs::create_dir(checked).unwrap();
            Ok(())
        });
        assert_eq!(replaced.unwrap_err().code, "DEST_CHANGED");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 0);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&moved).unwrap();
    }

    #[test]
    fn a_power_cycled_body_without_capture_dates_never_matches_an_earlier_connection() {
        let info = |capture_date: &str| ObjectInfo {
            sequence_number: 1,
            capture_date: capture_date.into(),
            ..ObjectInfo::default()
        };
        // SequenceNumber restarts at power-up; without a date the connection tells shots apart.
        let undated = info("");
        let (shot, object) = provider_keys("BODY", "c1", 1, &undated, "DSC00001.ARW");
        assert_eq!(shot, "sony:BODY:cohort:c1:epoch:1:1:DSC00001");
        assert_eq!(
            object,
            "sony:BODY:cohort:c1:epoch:1:1:DSC00001:DSC00001.ARW"
        );
        assert_ne!(
            provider_keys("BODY", "c1", 2, &undated, "DSC00001.ARW").0,
            shot
        );
        assert_ne!(
            provider_keys("BODY", "c1", 2, &info("garbage"), "DSC00001.ARW").0,
            provider_keys("BODY", "c1", 1, &info("garbage"), "DSC00001.ARW").0
        );
        // Epochs restart with every launch; the launch cohort keeps them apart.
        let (a, b) = (launch_cohort(), launch_cohort());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_ne!(
            provider_keys("BODY", &a, 1, &undated, "DSC00001.ARW").0,
            provider_keys("BODY", &b, 1, &undated, "DSC00001.ARW").0
        );
        // A real capture time identifies the photo across reconnects and launches.
        let dated = info("20261125T101112");
        assert_eq!(
            provider_keys("BODY", &a, 1, &dated, "DSC00001.ARW"),
            provider_keys("BODY", &b, 2, &dated, "DSC00001.ARW")
        );
        assert_eq!(
            provider_keys("BODY", "c1", 2, &dated, "dsc00001.arw").1,
            "sony:BODY:20261125T101112:1:DSC00001:DSC00001.ARW"
        );
    }

    #[test]
    fn a_timed_out_request_never_claims_a_later_photo() {
        let now = Instant::now();
        let mut pending: VecDeque<(String, Instant)> =
            [("old".to_string(), now), ("new".to_string(), now)].into();
        let mut timed_out = vec!["old".to_string()];
        prune_pending(&mut pending, &mut timed_out);
        assert_eq!(pending.front().map(|(id, _)| id.as_str()), Some("new"));
        assert!(timed_out.is_empty());
        prune_pending(&mut pending, &mut timed_out);
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn draining_stops_before_memory_for_unsaved_photos_runs_out() {
        assert!(!recovery_full(0, 0));
        assert!(!recovery_full(RECOVERY_COUNT - 1, 64 << 20));
        assert!(recovery_full(RECOVERY_COUNT, 0));
        // Room must remain for one more photo of typical size, or it would be pulled and lost.
        assert!(recovery_full(1, RECOVERY_BYTES - (64 << 20)));
    }

    #[test]
    fn svg_overlays_are_recognized() {
        assert!(looks_like_svg("a.SVG", b"\x89PNG"));
        assert!(looks_like_svg("x", b"<?xml version=\"1.0\"?><svg/>"));
        assert!(!looks_like_svg("a.png", b"\x89PNG\r\n\x1a\n"));
    }
}
