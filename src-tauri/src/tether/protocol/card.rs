//! Missed-shot backfill from the camera card: which storages count as a card, an incremental scan
//! for photos taken since the shoot began, and the pull queue that yields to live captures. Only
//! read operations exist here; nothing on the card is ever deleted or changed.

use super::codec::QueueSignal;
use super::ptp::{self, format, op, FileKind, ObjectInfo};
use super::session::{Result, SonySession};
use super::transport::PtpTransport;
use std::time::Duration;

/// Objects inspected per pass, newest handle first. Handles say nothing certain about capture
/// order, so every listed object up to this cap is read.
pub const MAX_INVENTORY: usize = 4096;
/// One GetPartialObject, so a shutter or Cancel waits for this much at most.
pub const READ_CHUNK: u32 = 2 << 20;

const NOT_LISTED: &str = "This connection does not show the camera’s memory card. Sony cameras in PC Remote mode often keep the card hidden; nothing was changed.";
const NO_CARD: &str = "No readable memory card is visible over this connection.";

/// A present logical volume, not an empty slot or Sony's virtual capture store (`0xFFFFxxxx`).
pub fn is_card_storage(storage_id: u32) -> bool {
    storage_id & 0xFFFF != 0 && storage_id >> 16 != 0 && storage_id >> 16 != 0xFFFF
}

/// `YYYYMMDDThhmmss`, which sorts in capture order.
pub fn capture_stamp(info: &ObjectInfo) -> Option<String> {
    info.capture_date_parts().map(|(d, t)| format!("{d}T{t}"))
}

/// A live capture the camera has announced or queued goes before any card read.
pub fn live_capture_waiting<T: PtpTransport>(session: &SonySession<T>) -> bool {
    session.object_announced() || session.queue_signal() != QueueSignal::Empty
}

/// GetObject reports no progress, so a whole-file read gets the time a slow link needs for it.
pub fn whole_read_timeout(declared: u64, wifi: bool) -> Duration {
    let floor: u64 = if wifi { 1 << 20 } else { 4 << 20 };
    (Duration::from_secs(10) + Duration::from_secs(declared / floor)).min(Duration::from_secs(120))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardObject {
    pub storage_id: u32,
    pub handle: u32,
    pub info: ObjectInfo,
    pub kind: FileKind,
    pub stamp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanStep {
    /// A live capture is waiting; nothing was sent.
    Yield,
    Working,
    Done,
    /// The card cannot be read over this connection; the reason is for the photographer.
    Unavailable(&'static str),
}

#[derive(Debug)]
enum Stage {
    Storages,
    Handles(Vec<u32>),
    Objects,
}

/// Lists the card one transaction per step so the camera worker serves live captures between
/// steps: storage IDs, then each storage's handles, then ObjectInfo newest handle first.
#[derive(Debug)]
pub struct CardScan {
    since: Option<String>,
    stage: Stage,
    /// `(handle, storage)` in ascending order; taken from the end.
    pending: Vec<(u32, u32)>,
    pub storages: Vec<u32>,
    pub listed: usize,
    pub inspected: usize,
    /// More objects were listed than one pass inspects.
    pub truncated: bool,
    pub found: Vec<CardObject>,
    /// RAW or JPEG files without a capture time.
    pub undated: usize,
    /// Objects whose ObjectInfo the camera refused.
    pub refused: usize,
}

impl CardScan {
    pub fn new(since: Option<String>) -> Self {
        CardScan {
            since,
            stage: Stage::Storages,
            pending: Vec::new(),
            storages: Vec::new(),
            listed: 0,
            inspected: 0,
            truncated: false,
            found: Vec::new(),
            undated: 0,
            refused: 0,
        }
    }

    /// Whether some listed object's capture time is unknown after the scan.
    pub fn blind(&self) -> bool {
        self.truncated || self.undated > 0 || self.refused > 0
    }

    /// Sends at most one read-only transaction. Refusals become `Unavailable`; only transport
    /// failures are errors.
    pub fn step<T: PtpTransport>(&mut self, session: &mut SonySession<T>) -> Result<ScanStep> {
        if live_capture_waiting(session) {
            return Ok(ScanStep::Yield);
        }
        match &mut self.stage {
            Stage::Storages => {
                let Some(mut ids) = session.storage_ids()? else {
                    return Ok(ScanStep::Unavailable(NOT_LISTED));
                };
                ids.retain(|id| is_card_storage(*id));
                ids.sort_unstable();
                ids.dedup();
                if ids.is_empty() {
                    return Ok(ScanStep::Unavailable(NOT_LISTED));
                }
                ids.reverse();
                self.stage = Stage::Handles(ids);
                Ok(ScanStep::Working)
            }
            Stage::Handles(left) => {
                let Some(storage) = left.pop() else {
                    return Ok(ScanStep::Working);
                };
                if let Some(handles) = session.object_handles(storage)? {
                    self.storages.push(storage);
                    self.pending.extend(
                        handles
                            .into_iter()
                            .filter(|h| *h != 0 && *h >> 16 != 0xFFFF)
                            .map(|h| (h, storage)),
                    );
                }
                if !left.is_empty() {
                    return Ok(ScanStep::Working);
                }
                if self.storages.is_empty() {
                    return Ok(ScanStep::Unavailable(NO_CARD));
                }
                self.pending.sort_unstable();
                self.pending.dedup_by_key(|(handle, _)| *handle);
                self.listed = self.pending.len();
                if self.listed > MAX_INVENTORY {
                    self.truncated = true;
                    self.pending.drain(..self.listed - MAX_INVENTORY);
                }
                self.stage = Stage::Objects;
                Ok(if self.pending.is_empty() {
                    ScanStep::Done
                } else {
                    ScanStep::Working
                })
            }
            Stage::Objects => {
                if let Some((handle, storage_id)) = self.pending.pop() {
                    self.inspect(session, handle, storage_id)?;
                }
                Ok(if self.pending.is_empty() {
                    ScanStep::Done
                } else {
                    ScanStep::Working
                })
            }
        }
    }

    fn inspect<T: PtpTransport>(
        &mut self,
        session: &mut SonySession<T>,
        handle: u32,
        storage_id: u32,
    ) -> Result<()> {
        self.inspected += 1;
        let Some(info) = session.object_info(handle)? else {
            self.refused += 1;
            return Ok(());
        };
        if info.object_format == format::ASSOCIATION || info.association_type != 0 {
            return Ok(());
        }
        let kind = ptp::kind_from_info(info.object_format, &info.filename);
        if !matches!(kind, FileKind::Raw | FileKind::Jpeg) {
            return Ok(());
        }
        let Some(stamp) = capture_stamp(&info) else {
            self.undated += 1;
            return Ok(());
        };
        if self.since.as_ref().is_some_and(|since| stamp < *since) {
            return Ok(());
        }
        self.found.push(CardObject {
            storage_id,
            handle,
            info,
            kind,
            stamp,
        });
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadStep {
    /// A live capture is waiting; nothing was sent.
    Yield,
    More,
    /// The camera stopped sending; `bytes` may fall short of `declared`.
    Done {
        bytes: u64,
        declared: u64,
    },
    /// The object is gone or the camera refused it.
    Gone,
}

/// Reads one card file a chunk per step where the camera offers GetPartialObject, otherwise in
/// one GetObject with a size-bound timeout.
#[derive(Debug)]
pub struct CardRead {
    handle: u32,
    declared: u64,
    offset: u64,
    partial: bool,
}

impl CardRead {
    /// Refuses, before anything is read, a file larger than `max` or of unknown size.
    // ImageCaptureCore hands over a whole GetObject payload in memory before Rust sees its size.
    pub fn new<T: PtpTransport>(
        session: &SonySession<T>,
        object: &CardObject,
        max: u64,
    ) -> std::result::Result<Self, String> {
        let declared = object.info.compressed_size;
        if declared == 0 || declared == u32::MAX || declared as u64 > max {
            return Err(format!(
                "{} is too large or of unknown size to read from the camera card; it stays there.",
                object.info.filename
            ));
        }
        Ok(CardRead {
            handle: object.handle,
            declared: declared as u64,
            offset: 0,
            partial: session
                .device()
                .is_some_and(|d| d.supports(op::GET_PARTIAL_OBJECT)),
        })
    }

    pub fn step<T: PtpTransport, W: std::io::Write + Send>(
        &mut self,
        session: &mut SonySession<T>,
        sink: &mut W,
        whole_timeout: Duration,
    ) -> Result<ReadStep> {
        if live_capture_waiting(session) {
            return Ok(ReadStep::Yield);
        }
        let done = |bytes| ReadStep::Done {
            bytes,
            declared: self.declared,
        };
        if !self.partial {
            return Ok(
                match session.read_object(self.handle, sink, whole_timeout)? {
                    Some(bytes) => done(bytes),
                    None => ReadStep::Gone,
                },
            );
        }
        let len = (self.declared - self.offset).min(READ_CHUNK as u64) as u32;
        match session.read_object_part(self.handle, self.offset as u32, len, sink)? {
            // A body that lists GetPartialObject but refuses it still serves GetObject.
            None if self.offset == 0 => {
                self.partial = false;
                Ok(ReadStep::More)
            }
            None => Ok(done(self.offset)),
            Some(n) => {
                self.offset += n;
                Ok(if n == 0 || self.offset >= self.declared {
                    done(self.offset)
                } else {
                    ReadStep::More
                })
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullStep {
    /// Pull this object of this exposure group next.
    Item {
        group: usize,
        item: usize,
    },
    Paused,
    Cancelled,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pulled,
    Failed,
    /// Already on the computer when its turn came.
    Present,
    /// Left for later: its photo may still arrive another way.
    Deferred,
}

/// Pulls exposure groups one object at a time. Pause and Cancel take effect between groups, so a
/// RAW+JPEG pair is never split by them.
#[derive(Debug, Clone)]
pub struct PullQueue {
    sizes: Vec<usize>,
    group: usize,
    item: usize,
    group_pulled: bool,
    paused: bool,
    cancelling: bool,
    /// Groups with at least one file pulled.
    pub shots: usize,
    pub pulled: usize,
    pub failed: usize,
    pub present: usize,
    pub deferred: usize,
}

impl PullQueue {
    pub fn new(sizes: Vec<usize>) -> Self {
        let sizes = sizes.into_iter().filter(|n| *n > 0).collect();
        PullQueue {
            sizes,
            group: 0,
            item: 0,
            group_pulled: false,
            paused: false,
            cancelling: false,
            shots: 0,
            pulled: 0,
            failed: 0,
            present: 0,
            deferred: 0,
        }
    }

    pub fn next(&self) -> PullStep {
        if self.group >= self.sizes.len() {
            return PullStep::Finished;
        }
        if self.item == 0 {
            if self.cancelling {
                return PullStep::Cancelled;
            }
            if self.paused {
                return PullStep::Paused;
            }
        }
        PullStep::Item {
            group: self.group,
            item: self.item,
        }
    }

    /// Records the outcome of the object `next` returned.
    pub fn advance(&mut self, outcome: Outcome) {
        if self.group >= self.sizes.len() {
            return;
        }
        match outcome {
            Outcome::Pulled => {
                self.pulled += 1;
                self.group_pulled = true;
            }
            Outcome::Failed => self.failed += 1,
            Outcome::Present => self.present += 1,
            Outcome::Deferred => self.deferred += 1,
        }
        self.item += 1;
        if self.item >= self.sizes[self.group] {
            self.shots += usize::from(self.group_pulled);
            self.group += 1;
            self.item = 0;
            self.group_pulled = false;
        }
    }

    /// Records the same outcome for the rest of the current group.
    pub fn finish_group(&mut self, outcome: Outcome) {
        let group = self.group;
        while self.group == group && self.group < self.sizes.len() {
            self.advance(outcome);
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn cancel(&mut self) {
        self.cancelling = true;
    }

    pub fn cancelling(&self) -> bool {
        self.cancelling
    }

    /// `(1-based group in progress, groups)`.
    pub fn progress(&self) -> (usize, usize) {
        let total = self.sizes.len();
        ((self.group + 1).min(total), total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_present_card_volumes_are_storage_to_scan() {
        assert!(is_card_storage(0x0001_0001));
        assert!(is_card_storage(0x0002_0001));
        // Empty slot, Sony's virtual capture store, and the reserved IDs.
        assert!(!is_card_storage(0x0001_0000));
        assert!(!is_card_storage(0xFFFF_C001));
        assert!(!is_card_storage(0));
        assert!(!is_card_storage(0xFFFF_FFFF));
        assert!(!is_card_storage(0x0000_0001));
    }

    #[test]
    fn pause_and_cancel_wait_for_the_pair_in_progress() {
        let mut q = PullQueue::new(vec![2, 1, 0, 2]);
        assert_eq!(q.progress(), (1, 3));
        assert_eq!(q.next(), PullStep::Item { group: 0, item: 0 });
        q.advance(Outcome::Pulled);
        q.set_paused(true);
        q.cancel();
        assert_eq!(q.next(), PullStep::Item { group: 0, item: 1 });
        q.advance(Outcome::Failed);
        assert_eq!((q.shots, q.pulled, q.failed), (1, 1, 1));
        assert_eq!(q.next(), PullStep::Cancelled);

        let mut q = PullQueue::new(vec![1, 2, 2]);
        q.set_paused(true);
        assert_eq!(q.next(), PullStep::Paused);
        q.set_paused(false);
        assert_eq!(q.next(), PullStep::Item { group: 0, item: 0 });
        q.finish_group(Outcome::Present);
        assert_eq!(q.progress(), (2, 3));
        q.advance(Outcome::Deferred);
        q.advance(Outcome::Pulled);
        q.finish_group(Outcome::Failed);
        assert_eq!(q.next(), PullStep::Finished);
        assert_eq!(
            (q.shots, q.pulled, q.failed, q.present, q.deferred),
            (1, 1, 2, 1, 1)
        );
        // Nothing more is counted once finished.
        q.advance(Outcome::Pulled);
        q.finish_group(Outcome::Pulled);
        assert_eq!(q.pulled, 1);
        assert_eq!(PullQueue::new(vec![]).next(), PullStep::Finished);
    }

    #[test]
    fn a_whole_file_read_gets_more_time_on_a_slower_link_within_a_bound() {
        let raw = 60 << 20;
        assert_eq!(whole_read_timeout(raw, false), Duration::from_secs(25));
        assert_eq!(whole_read_timeout(raw, true), Duration::from_secs(70));
        assert_eq!(
            whole_read_timeout(u32::MAX as u64, true),
            Duration::from_secs(120)
        );
    }
}
