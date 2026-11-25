//! The newest Live View frame and its single long-poll waiter.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const POLL_TIMEOUT: Duration = Duration::from_millis(500);
pub const MAX_JPEG: usize = 8 << 20;
pub const MAX_PIXELS: u64 = 24_000_000;

#[derive(Clone)]
pub struct Frame {
    pub seq: u64,
    pub camera_mono_ms: u64,
    pub width: u32,
    pub height: u32,
    pub orientation: u16,
    pub jpeg: Arc<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveError {
    /// The stream ID or epoch is not the open stream.
    Closed,
    /// The frame failed validation.
    Invalid(&'static str),
}

struct Slot {
    stream_id: Option<String>,
    epoch: u64,
    seq: u64,
    frame: Option<Frame>,
    waiter: u64,
    dropped: u64,
    delivered: u64,
    window_start: Option<Instant>,
}

/// Holds only the latest frame. A new waiter supersedes an older one.
pub struct LiveViewHub {
    slot: Mutex<Slot>,
    notify: Notify,
    started: Instant,
    next_stream: Mutex<u64>,
}

impl Default for LiveViewHub {
    fn default() -> Self {
        LiveViewHub {
            slot: Mutex::new(Slot {
                stream_id: None,
                epoch: 0,
                seq: 0,
                frame: None,
                waiter: 0,
                dropped: 0,
                delivered: 0,
                window_start: None,
            }),
            notify: Notify::new(),
            started: Instant::now(),
            next_stream: Mutex::new(0),
        }
    }
}

pub fn validate_frame(width: u32, height: u32, jpeg: &[u8]) -> Result<(), LiveError> {
    if jpeg.len() < 4 || jpeg.len() > MAX_JPEG {
        return Err(LiveError::Invalid("frame size"));
    }
    if jpeg[..2] != [0xFF, 0xD8] {
        return Err(LiveError::Invalid("not a JPEG"));
    }
    if width == 0 || height == 0 || width as u64 * height as u64 > MAX_PIXELS {
        return Err(LiveError::Invalid("frame dimensions"));
    }
    Ok(())
}

/// `[u32 LE header length][JSON header][bytes]`, the Develop binary envelope.
pub fn pack_frame(header: &Value, bytes: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + header.len() + bytes.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(bytes);
    out
}

impl LiveViewHub {
    pub fn mono_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Opens a new stream for `epoch`, discarding any previous frame.
    pub fn open(&self, epoch: u64) -> String {
        let id = {
            let mut n = self.next_stream.lock().unwrap();
            *n += 1;
            format!("lv-{epoch}-{}", *n)
        };
        let mut slot = self.slot.lock().unwrap();
        slot.stream_id = Some(id.clone());
        slot.epoch = epoch;
        slot.frame = None;
        slot.dropped = 0;
        slot.delivered = 0;
        slot.window_start = Some(Instant::now());
        drop(slot);
        self.notify.notify_waiters();
        id
    }

    /// Closes the stream and releases every outstanding poll.
    pub fn close(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.stream_id = None;
        slot.frame = None;
        drop(slot);
        self.notify.notify_waiters();
    }

    pub fn stream(&self) -> Option<(String, u64)> {
        let slot = self.slot.lock().unwrap();
        slot.stream_id.clone().map(|id| (id, slot.epoch))
    }

    /// Replaces the slot with a newer frame; an unread frame counts as dropped.
    pub fn publish(
        &self,
        epoch: u64,
        width: u32,
        height: u32,
        orientation: u16,
        jpeg: Vec<u8>,
    ) -> Result<u64, LiveError> {
        validate_frame(width, height, &jpeg)?;
        let mut slot = self.slot.lock().unwrap();
        if slot.stream_id.is_none() || slot.epoch != epoch {
            return Err(LiveError::Closed);
        }
        slot.seq += 1;
        if slot.frame.is_some() {
            slot.dropped += 1;
        }
        let seq = slot.seq;
        slot.frame = Some(Frame {
            seq,
            camera_mono_ms: self.started.elapsed().as_millis() as u64,
            width,
            height,
            orientation,
            jpeg: Arc::new(jpeg),
        });
        drop(slot);
        self.notify.notify_waiters();
        Ok(seq)
    }

    /// `(delivered fps over the current window, dropped frames)`, then starts a new window.
    pub fn take_stats(&self) -> (f64, u64) {
        let mut slot = self.slot.lock().unwrap();
        let elapsed = slot
            .window_start
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let fps = if elapsed > 0.0 {
            slot.delivered as f64 / elapsed
        } else {
            0.0
        };
        let dropped = slot.dropped;
        slot.delivered = 0;
        slot.dropped = 0;
        slot.window_start = Some(Instant::now());
        ((fps * 10.0).round() / 10.0, dropped)
    }

    /// Waits up to `timeout` for a frame newer than `after_seq`. `Ok(None)` on timeout or when a
    /// newer waiter took over; `Err(Closed)` once the stream stops.
    pub async fn wait(
        &self,
        stream_id: &str,
        epoch: u64,
        after_seq: u64,
        timeout: Duration,
    ) -> Result<Option<Frame>, LiveError> {
        let me = {
            let mut slot = self.slot.lock().unwrap();
            if slot.stream_id.as_deref() != Some(stream_id) || slot.epoch != epoch {
                return Err(LiveError::Closed);
            }
            slot.waiter += 1;
            slot.waiter
        };
        self.notify.notify_waiters();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut slot = self.slot.lock().unwrap();
                if slot.stream_id.as_deref() != Some(stream_id) || slot.epoch != epoch {
                    return Err(LiveError::Closed);
                }
                if slot.waiter != me {
                    return Ok(None);
                }
                if let Some(frame) = slot.frame.as_ref().filter(|f| f.seq > after_seq) {
                    let frame = frame.clone();
                    slot.frame = None;
                    slot.delivered += 1;
                    return Ok(Some(frame));
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(None);
            }
        }
    }

    pub fn header(
        &self,
        stream_id: &str,
        epoch: u64,
        frame: Option<&Frame>,
        after_seq: u64,
    ) -> Value {
        match frame {
            Some(f) => json!({
                "v": 1,
                "streamId": stream_id,
                "epoch": epoch,
                "seq": f.seq,
                "cameraMonoMs": f.camera_mono_ms,
                "width": f.width,
                "height": f.height,
                "orientation": f.orientation,
                "jpegBytes": f.jpeg.len(),
            }),
            None => json!({
                "v": 1,
                "streamId": stream_id,
                "epoch": epoch,
                "seq": after_seq,
                "cameraMonoMs": self.mono_ms(),
                "width": 0,
                "height": 0,
                "orientation": 1,
                "jpegBytes": 0,
            }),
        }
    }
}
