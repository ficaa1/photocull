//! Missed-shot backfill from the camera card: which storages count as a card, an incremental scan
//! for photos taken since the shoot began, and the pull queue that yields to live captures. Only
//! read operations exist here; nothing on the card is ever deleted or changed.

use super::ptp::{self, format, FileKind, ObjectInfo};
use super::session::{Result, SonySession};
use super::transport::PtpTransport;

/// Consecutive photos older than the window, newest first, after which a storage is done.
pub const OLDER_RUN_LIMIT: usize = 64;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardObject {
    pub storage_id: u32,
    pub handle: u32,
    pub info: ObjectInfo,
    pub kind: FileKind,
    pub stamp: String,
}

#[derive(Debug)]
pub enum CardAccess {
    /// The card cannot be read over this connection; the reason is for the photographer.
    Unavailable(&'static str),
    Listed(CardScan),
}

/// Reads ObjectInfo a few objects at a time so the camera worker can serve live captures between
/// steps. Each storage is read newest handle first and ends after a long run of older photos.
#[derive(Debug)]
pub struct CardScan {
    /// `(storage, handle)` per storage in ascending handle order; taken from the end.
    pending: Vec<Vec<(u32, u32)>>,
    since: Option<String>,
    older_run: usize,
    pub storages: Vec<u32>,
    pub listed: usize,
    pub inspected: usize,
    pub found: Vec<CardObject>,
    pub undated: usize,
}

impl CardScan {
    /// Lists card storages and their objects. Refusals become `Unavailable`; only transport
    /// failures are errors.
    pub fn open<T: PtpTransport>(
        session: &mut SonySession<T>,
        since: Option<String>,
    ) -> Result<CardAccess> {
        let Some(ids) = session.storage_ids()? else {
            return Ok(CardAccess::Unavailable(NOT_LISTED));
        };
        let storages: Vec<u32> = ids.into_iter().filter(|id| is_card_storage(*id)).collect();
        let mut pending = Vec::new();
        let mut readable = Vec::new();
        for storage in &storages {
            let Some(mut handles) = session.object_handles(*storage)? else {
                continue;
            };
            handles.retain(|h| *h != 0 && *h >> 16 != 0xFFFF);
            handles.sort_unstable();
            handles.dedup();
            readable.push(*storage);
            pending.push(handles.into_iter().map(|h| (*storage, h)).collect());
        }
        if readable.is_empty() {
            return Ok(CardAccess::Unavailable(if storages.is_empty() {
                NOT_LISTED
            } else {
                NO_CARD
            }));
        }
        let listed = pending.iter().map(Vec::len).sum();
        Ok(CardAccess::Listed(CardScan {
            pending,
            since,
            older_run: 0,
            storages: readable,
            listed,
            inspected: 0,
            found: Vec::new(),
            undated: 0,
        }))
    }

    pub fn finished(&self) -> bool {
        self.pending.is_empty()
    }

    /// Inspects up to `batch` objects; true once the scan is complete.
    pub fn step<T: PtpTransport>(
        &mut self,
        session: &mut SonySession<T>,
        batch: usize,
    ) -> Result<bool> {
        for _ in 0..batch {
            let Some(storage) = self.pending.last_mut() else {
                break;
            };
            let Some((storage_id, handle)) = storage.pop() else {
                self.pending.pop();
                self.older_run = 0;
                continue;
            };
            self.inspected += 1;
            let Some(info) = session.object_info(handle)? else {
                continue;
            };
            if info.object_format == format::ASSOCIATION || info.association_type != 0 {
                continue;
            }
            let kind = ptp::kind_from_info(info.object_format, &info.filename);
            if !matches!(kind, FileKind::Raw | FileKind::Jpeg) {
                continue;
            }
            let Some(stamp) = capture_stamp(&info) else {
                self.undated += 1;
                continue;
            };
            if self.since.as_ref().is_some_and(|since| stamp < *since) {
                self.older_run += 1;
                if self.older_run >= OLDER_RUN_LIMIT {
                    self.pending.pop();
                    self.older_run = 0;
                }
                continue;
            }
            self.older_run = 0;
            self.found.push(CardObject {
                storage_id,
                handle,
                info,
                kind,
                stamp,
            });
        }
        if self.pending.last().is_some_and(Vec::is_empty) {
            self.pending.pop();
            self.older_run = 0;
        }
        Ok(self.pending.is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullStep {
    /// Pull this object of this exposure group next.
    Item {
        group: usize,
        item: usize,
    },
    /// A live capture is in flight; it goes first.
    Wait,
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
}

/// Pulls exposure groups one object at a time. Pause and Cancel take effect between groups, so a
/// RAW+JPEG pair is never split by them; a live capture waits for at most one object.
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
        }
    }

    pub fn next(&self, live_busy: bool) -> PullStep {
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
        if live_busy {
            return PullStep::Wait;
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

    pub fn paused(&self) -> bool {
        self.paused
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

    pub fn groups_done(&self) -> usize {
        self.group.min(self.sizes.len())
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
    fn a_live_capture_waits_for_at_most_one_object_and_pairs_are_never_split() {
        let mut q = PullQueue::new(vec![2, 1, 0, 2]);
        assert_eq!(q.progress(), (1, 3));
        assert_eq!(q.next(false), PullStep::Item { group: 0, item: 0 });
        assert_eq!(q.next(true), PullStep::Wait);
        q.advance(Outcome::Pulled);
        // Pause and Cancel wait for the JPEG of the pair in progress.
        q.set_paused(true);
        q.cancel();
        assert_eq!(q.next(false), PullStep::Item { group: 0, item: 1 });
        q.advance(Outcome::Failed);
        assert_eq!((q.shots, q.pulled, q.failed, q.groups_done()), (1, 1, 1, 1));
        assert_eq!(q.next(false), PullStep::Cancelled);

        let mut q = PullQueue::new(vec![1, 2, 2]);
        q.set_paused(true);
        assert_eq!(q.next(false), PullStep::Paused);
        q.set_paused(false);
        assert_eq!(q.next(false), PullStep::Item { group: 0, item: 0 });
        q.finish_group(Outcome::Present);
        assert_eq!(q.progress(), (2, 3));
        q.advance(Outcome::Present);
        q.advance(Outcome::Pulled);
        q.finish_group(Outcome::Failed);
        assert_eq!(q.next(false), PullStep::Finished);
        assert_eq!(
            (q.shots, q.pulled, q.failed, q.present, q.groups_done()),
            (1, 1, 2, 2, 3)
        );
        // Nothing more is counted once finished.
        q.advance(Outcome::Pulled);
        q.finish_group(Outcome::Pulled);
        assert_eq!(q.pulled, 1);
        assert_eq!(PullQueue::new(vec![]).next(false), PullStep::Finished);
    }
}
