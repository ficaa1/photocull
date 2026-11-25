//! Missed-shot backfill: after a reconnect, or when the photographer asks, photos the camera saved
//! to its card during the shoot but never delivered are read from the card and go through the same
//! staging, journal and publication as live captures. The card is only read, never changed.
//!
//! Each actor turn does at most one card transaction, and only while no live capture is announced,
//! queued, awaited or being received, so a shutter, Pause, Cancel or Disconnect waits for one
//! transaction at most.

use super::protocol::card::{
    self, CardObject, CardRead, CardScan, Outcome, PullQueue, PullStep, ReadStep, ScanStep,
};
use super::*;

/// Lets the camera's own capture queue drain after a reconnect before the card is read.
const AUTO_DELAY: Duration = Duration::from_secs(3);
/// Publications in flight above which the card waits.
const PUBLISH_BACKLOG: usize = 4;
/// A released shutter keeps the card idle this long for its photo.
const SHUTTER_GRACE: Duration = Duration::from_secs(4);
/// Card objects planned per Node call.
const PLAN_BATCH: usize = 128;

const EMPTY: &str = "The card shows no photos over this connection. It may be empty, or the camera may keep its files hidden in PC Remote mode.";

pub(super) enum BackfillOp {
    Start,
    Pause,
    Resume,
    Cancel,
}

/// A Test Shot released over this connection; its frame stays on the card.
pub(super) struct TestRelease {
    body: String,
    at_ms: u64,
    epoch: u64,
}

pub(super) struct Backfill {
    pass: u64,
    epoch: u64,
    auto: bool,
    paused: bool,
    cancelling: bool,
    body: String,
    host_roles: Vec<&'static str>,
    listed: usize,
    truncated: bool,
    /// Exposures the ledger already held in full.
    already: usize,
    /// Frames left on the card as possible Test Shots.
    held: usize,
    deferred: usize,
    /// Capture times, as `YYYY:MM:DD hh:mm:ss`, of files on the computer or journaled on their way.
    settled: Vec<String>,
    /// The earliest capture time a later pass must read again.
    unsettled: Option<String>,
    /// Some listed file could not be placed in time, so nothing is marked synced.
    blind: bool,
    phase: Phase,
    last_emit: Instant,
}

enum Phase {
    Scanning(CardScan),
    Planning {
        objects: Vec<CardObject>,
        next: usize,
        releases: Vec<u64>,
        groups: Vec<Vec<CardObject>>,
    },
    Pulling {
        groups: Vec<Vec<CardObject>>,
        queue: PullQueue,
        prepared: Option<Prepared>,
        reading: Option<Reading>,
    },
}

/// Node's answer for the group being pulled: a member per file to read, or why there is none.
struct Prepared {
    group: usize,
    members: Vec<PreparedMember>,
}

#[derive(Clone)]
enum PreparedMember {
    Read(MemberPlan),
    Present,
    Deferred,
    ClaimedLive(String),
}

struct Reading {
    item: usize,
    object: CardObject,
    plan: MemberPlan,
    read: CardRead,
    writer: StageWriter,
    started: Instant,
}

impl Backfill {
    /// Release the stage path before live delivery opens it, then recheck the journal on the card's turn.
    pub(super) fn claim_live_member(&mut self, member_id: &str) {
        let Phase::Pulling {
            prepared: Some(prepared),
            reading,
            ..
        } = &mut self.phase
        else {
            return;
        };
        for member in &mut prepared.members {
            if matches!(member, PreparedMember::Read(plan) if plan.member_id == member_id) {
                *member = PreparedMember::ClaimedLive(member_id.to_owned());
            }
        }
        if reading
            .as_ref()
            .is_some_and(|r| r.plan.member_id == member_id)
        {
            *reading = None;
        }
    }

    fn note_unsettled(&mut self, object: &CardObject) {
        match capture_time(&object.info) {
            Some(t) if self.unsettled.as_ref().map_or(true, |u| t < *u) => self.unsettled = Some(t),
            Some(_) => {}
            None => self.blind = true,
        }
    }

    fn record(&mut self, object: &CardObject, outcome: Outcome) {
        match outcome {
            Outcome::Pulled | Outcome::Present => match capture_time(&object.info) {
                Some(t) => self.settled.push(t),
                None => self.blind = true,
            },
            Outcome::Failed | Outcome::Deferred => self.note_unsettled(object),
        }
    }

    /// The newest capture time below every file still unsettled.
    fn synced_through(&self) -> Option<&String> {
        if self.blind {
            return None;
        }
        self.settled
            .iter()
            .filter(|t| self.unsettled.as_ref().map_or(true, |u| *t < u))
            .max()
    }

    fn state(&self) -> &'static str {
        match &self.phase {
            _ if self.cancelling => "cancelling",
            Phase::Pulling { queue, reading, .. } => {
                if reading.is_none() && queue.next() == PullStep::Paused {
                    "paused"
                } else {
                    "pulling"
                }
            }
            _ if self.paused => "paused",
            _ => "scanning",
        }
    }
}

pub(super) fn auto_backfill_enabled(settings: &Value) -> bool {
    settings["tether"]["autoBackfill"].as_bool() != Some(false)
}

/// `YYYY:MM:DD hh:mm:ss` as the scan's `YYYYMMDDThhmmss`.
fn card_stamp(wall: &str) -> Option<String> {
    let stamp = wall.replace(':', "").replacen(' ', "T", 1);
    (stamp.len() == 15 && stamp.as_bytes()[8] == b'T').then_some(stamp)
}

fn card_object_json(object: &CardObject) -> Value {
    json!({
        "handle": object.handle,
        "storageId": object.storage_id,
        "name": object_name(&object.info, object.kind),
        "role": object.kind.role(),
        "bytes": object.info.compressed_size,
        "captureTime": capture_time(&object.info),
    })
}

/// Files of one exposure sort together: capture second, then stem.
fn exposure_order(object: &CardObject) -> (String, String) {
    let name = object_name(&object.info, object.kind);
    (object.stamp.clone(), file_stem(&name).to_lowercase())
}

/// The end of the planning batch from `start`, never splitting an exposure.
fn batch_end(objects: &[CardObject], start: usize) -> usize {
    let mut end = (start + PLAN_BATCH).min(objects.len());
    while end < objects.len() && exposure_order(&objects[end - 1]) == exposure_order(&objects[end])
    {
        end += 1;
    }
    end
}

/// A Test Shot's photo arrived, so its card frame is known by capture time and name instead.
pub(super) fn resolve_test_release(releases: &mut Vec<TestRelease>, body: &str, epoch: u64) {
    let mut candidates = releases
        .iter()
        .enumerate()
        .filter(|(_, r)| r.body == body && r.epoch == epoch);
    if let Some((index, _)) = candidates.next() {
        if candidates.next().is_none() {
            releases.remove(index);
        }
    }
}

fn pulling(groups: Vec<Vec<CardObject>>) -> Phase {
    Phase::Pulling {
        queue: PullQueue::new(groups.iter().map(Vec::len).collect()),
        groups,
        prepared: None,
        reading: None,
    }
}

fn put_reading(job: &mut Backfill, read: Reading) {
    if let Phase::Pulling { reading, .. } = &mut job.phase {
        *reading = Some(read);
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl Actor {
    pub(super) fn backfill_command(&mut self, op: BackfillOp) -> TResult<Value> {
        match op {
            BackfillOp::Start if self.backfill.is_none() => return self.start_backfill(false),
            BackfillOp::Start | BackfillOp::Resume => self.pause_backfill(false),
            BackfillOp::Pause => self.pause_backfill(true),
            BackfillOp::Cancel => {
                if let Some(job) = self.backfill.as_mut() {
                    job.cancelling = true;
                    if let Phase::Pulling { queue, .. } = &mut job.phase {
                        queue.cancel();
                    }
                }
                if !self.end_if_settled() {
                    if let Some(job) = &self.backfill {
                        self.emit_backfill(job, job.state(), None);
                    }
                }
            }
        }
        Ok(match &self.backfill {
            Some(job) => self.backfill_payload(Some(job), job.state(), None),
            None => self.backfill_payload(None, "idle", None),
        })
    }

    fn pause_backfill(&mut self, paused: bool) {
        let Some(job) = self.backfill.as_mut() else {
            return;
        };
        job.paused = paused;
        if let Phase::Pulling { queue, .. } = &mut job.phase {
            queue.set_paused(paused);
        }
        if let Some(job) = &self.backfill {
            self.emit_backfill(job, job.state(), None);
        }
    }

    /// Queues a pass; the card is first read on a later turn, when no live capture is waiting.
    pub(super) fn start_backfill(&mut self, auto: bool) -> TResult<Value> {
        let binding = self.binding().ok_or_else(TetherError::stale_session)?;
        self.ready_session()?;
        self.backfill_due = None;
        let window = node_blocking(
            &self.inner.app,
            "tether-backfill",
            json!([binding.shoot_id, "window", { "camera": self.card_camera() }]),
        )?;
        let since = window["since"]
            .as_str()
            .and_then(card_stamp)
            .ok_or_else(|| {
                TetherError::new(
                    "UNSUPPORTED",
                    "This shoot has no start time to compare the card with.",
                )
            })?;
        self.backfill_pass += 1;
        let job = Backfill {
            pass: self.backfill_pass,
            epoch: self.epoch,
            auto,
            paused: false,
            cancelling: false,
            body: self.body_identity(),
            host_roles: self.host_roles(),
            listed: 0,
            truncated: false,
            already: 0,
            held: 0,
            deferred: 0,
            settled: Vec::new(),
            unsettled: None,
            blind: false,
            phase: Phase::Scanning(CardScan::new(Some(since))),
            last_emit: Instant::now(),
        };
        let payload = self.emit_backfill(&job, "scanning", None);
        self.backfill = Some(job);
        Ok(payload)
    }

    /// Schedules the automatic pass after a reconnect of the same body within the same shoot.
    pub(super) fn after_connect(&mut self, shoot_id: &str) {
        let body = self.body_identity();
        let connection = (shoot_id.to_string(), body.clone());
        let reconnected = self.connected.as_ref() == Some(&connection);
        self.connected = Some(connection);
        // A body whose card reads failed is read again only when the photographer asks.
        self.backfill_due =
            (reconnected && !self.card_failed.contains(&body)).then(|| Instant::now() + AUTO_DELAY);
    }

    pub(super) fn record_test_release(&mut self) {
        self.test_releases.push(TestRelease {
            body: self.body_identity(),
            at_ms: unix_ms(),
            epoch: self.epoch,
        });
    }

    pub(super) fn withdraw_test_release(&mut self) {
        self.test_releases.pop();
    }

    pub(super) fn body_identity(&self) -> String {
        let device = self.device.clone().unwrap_or_default();
        format!("{}\0{}", device.model, device.body_id())
    }

    fn card_camera(&self) -> Value {
        let device = self.device.clone().unwrap_or_default();
        camera_snapshot(&device, &ExposureSnapshot::default(), None)
    }

    /// Nothing from a live capture is waiting, arriving or held, so a card read cannot delay one.
    fn card_may_read(&self) -> bool {
        let shutter_waiting = {
            let waiters = self.inner.confirmations.lock().unwrap();
            self.pending
                .iter()
                .any(|(id, at)| waiters.contains_key(id) || at.elapsed() < SHUTTER_GRACE)
        };
        !shutter_waiting
            && self.cohorts.pending_test.is_none()
            && self.half_press_since.is_none()
            && self.inner.receiving.load(Ordering::SeqCst) == 0
            && self.inner.outstanding.load(Ordering::SeqCst) < PUBLISH_BACKLOG
            && self.inner.drain_hold.lock().unwrap().is_none()
            && self.binding().is_some()
            && self.session.as_ref().is_some_and(|s| {
                s.state() == ConnectionState::Ready && !card::live_capture_waiting(s)
            })
    }

    /// Runs one step of the pass. Ending, pausing and cancelling never wait for the card.
    pub(super) fn service_backfill(&mut self) {
        if self.backfill.is_none() {
            let due = self.backfill_due.is_some_and(|at| Instant::now() >= at);
            if due && self.card_may_read() {
                self.backfill_due = None;
                let enabled = node_blocking(&self.inner.app, "settings", json!([]))
                    .map_or(true, |settings| auto_backfill_enabled(&settings));
                if enabled {
                    if let Err(e) = self.start_backfill(true) {
                        crate::logs::write(&format!("tether backfill {}: {}", e.code, e.message));
                    }
                }
            }
            return;
        }
        if self.end_if_settled() || !self.card_may_read() {
            return;
        }
        let Some(job) = self.backfill.take() else {
            return;
        };
        match job.phase {
            Phase::Scanning(_) => self.scan_step(job),
            Phase::Planning { .. } => self.plan_step(job),
            Phase::Pulling { .. } => self.pull_step(job),
        }
    }

    /// Ends a pass that is finished, cancelled at an exposure boundary, cancelled while the card
    /// cannot be read, or left over from an earlier connection.
    fn end_if_settled(&mut self) -> bool {
        let Some(job) = &self.backfill else {
            return false;
        };
        let state = if job.epoch != self.epoch {
            Some("interrupted")
        } else {
            match &job.phase {
                Phase::Pulling {
                    queue,
                    reading: None,
                    ..
                } if matches!(queue.next(), PullStep::Finished | PullStep::Cancelled) => {
                    Some(if job.cancelling { "cancelled" } else { "done" })
                }
                Phase::Pulling { .. } if job.cancelling && !self.card_may_read() => {
                    Some("cancelled")
                }
                Phase::Scanning(_) | Phase::Planning { .. } if job.cancelling => Some("cancelled"),
                _ => None,
            }
        };
        let Some(state) = state else {
            return false;
        };
        if let Some(job) = self.backfill.take() {
            self.finish_backfill(job, state);
        }
        true
    }

    fn scan_step(&mut self, mut job: Backfill) {
        let step = match (&mut job.phase, self.session.as_mut()) {
            (Phase::Scanning(scan), Some(session)) if !job.paused => scan.step(session),
            _ => {
                self.backfill = Some(job);
                return;
            }
        };
        match step {
            Ok(ScanStep::Yield | ScanStep::Busy) => self.backfill = Some(job),
            Ok(ScanStep::Working) => {
                self.card_busy = true;
                if job.last_emit.elapsed() >= Duration::from_millis(300) {
                    job.last_emit = Instant::now();
                    self.emit_backfill(&job, "scanning", None);
                }
                self.backfill = Some(job);
            }
            Ok(ScanStep::Done) => {
                self.card_busy = true;
                let Phase::Scanning(scan) = std::mem::replace(&mut job.phase, pulling(Vec::new()))
                else {
                    return;
                };
                crate::logs::write(&format!(
                    "tether backfill: {} listed on {} storage(s), {} inspected, {} in the window, {} undated, {} refused",
                    scan.listed,
                    scan.storages.len(),
                    scan.inspected,
                    scan.found.len(),
                    scan.undated,
                    scan.refused
                ));
                job.listed = scan.listed;
                job.truncated = scan.truncated;
                job.blind = scan.blind();
                let mut objects = scan.found;
                objects.sort_by_cached_key(exposure_order);
                let releases = self
                    .test_releases
                    .iter()
                    .filter(|r| r.body == job.body)
                    .map(|r| r.at_ms)
                    .collect();
                job.phase = Phase::Planning {
                    objects,
                    next: 0,
                    releases,
                    groups: Vec::new(),
                };
                self.backfill = Some(job);
            }
            Ok(ScanStep::Unavailable(reason)) => {
                crate::logs::write(&format!("tether backfill unavailable: {reason}"));
                self.emit_backfill(&job, "unavailable", Some(reason));
            }
            Err(e) => self.card_error(job, e),
        }
    }

    /// Asks Node which card exposures are missing, one bounded batch per turn.
    fn plan_step(&mut self, mut job: Backfill) {
        let Some(binding) = self.binding() else {
            return self.finish_backfill(job, "interrupted");
        };
        if job.paused {
            self.backfill = Some(job);
            return;
        }
        let test_shots: Vec<Value> = self
            .test_shots
            .iter()
            .filter(|(body, ..)| *body == job.body)
            .map(|(_, time, stem)| json!({ "captureTime": time, "stem": stem }))
            .collect();
        let camera = self.card_camera();
        let host_roles = job.host_roles.clone();
        let Phase::Planning {
            objects,
            next,
            releases,
            groups,
        } = &mut job.phase
        else {
            return;
        };
        let end = batch_end(objects, *next);
        let batch = &objects[*next..end];
        let planned = node_blocking(
            &self.inner.app,
            "tether-backfill",
            json!([binding.shoot_id, "plan", {
                "camera": camera,
                "hostRoles": host_roles,
                "objects": batch.iter().map(card_object_json).collect::<Vec<_>>(),
                "exclude": self.unready_members(),
                "testShots": test_shots,
                "testReleases": releases,
            }]),
        );
        let planned = match planned {
            Ok(planned) => planned,
            Err(e) => return self.finish_backfill_with(job, "error", Some(&e.message)),
        };
        let index: HashMap<(u64, u64), usize> = batch
            .iter()
            .enumerate()
            .map(|(i, o)| ((o.storage_id as u64, o.handle as u64), i))
            .collect();
        let mut pulled = vec![false; batch.len()];
        for group in planned["groups"].as_array().into_iter().flatten() {
            let members: Vec<CardObject> = group["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| index.get(&(o["storageId"].as_u64()?, o["handle"].as_u64()?)))
                .map(|&i| {
                    pulled[i] = true;
                    batch[i].clone()
                })
                .collect();
            if !members.is_empty() {
                groups.push(members);
            }
        }
        let unsettled: HashSet<&str> = planned["unsettled"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut settled = Vec::new();
        let mut open = Vec::new();
        for (i, object) in batch.iter().enumerate() {
            let time = capture_time(&object.info);
            if time.as_deref().is_some_and(|t| unsettled.contains(t)) {
                open.push(object.clone());
            } else if !pulled[i] {
                settled.push(object.clone());
            }
        }
        *next = end;
        let finished = end == objects.len();
        job.already += planned["present"].as_u64().unwrap_or(0) as usize;
        job.deferred += planned["deferred"].as_u64().unwrap_or(0) as usize;
        job.held += planned["held"].as_u64().unwrap_or(0) as usize;
        for object in &settled {
            job.record(object, Outcome::Present);
        }
        for object in &open {
            job.note_unsettled(object);
        }
        self.card_busy = true;
        if finished {
            let Phase::Planning { groups, .. } =
                std::mem::replace(&mut job.phase, pulling(Vec::new()))
            else {
                return;
            };
            crate::logs::write(&format!(
                "tether backfill: {} exposure(s) missing, {} already here, {} held as possible test shots",
                groups.len(),
                job.already,
                job.held
            ));
            job.phase = pulling(groups);
            if let Phase::Pulling { queue, .. } = &mut job.phase {
                queue.set_paused(job.paused);
                if job.cancelling {
                    queue.cancel();
                }
            }
        }
        self.backfill = Some(job);
    }

    fn pull_step(&mut self, mut job: Backfill) {
        let Phase::Pulling {
            groups,
            queue,
            prepared,
            reading,
        } = &mut job.phase
        else {
            return;
        };
        if let Some(read) = reading.take() {
            return self.continue_read(job, read);
        }
        let PullStep::Item { group, item } = queue.next() else {
            self.backfill = Some(job);
            return;
        };
        let Some(binding) = self.binding() else {
            return self.finish_backfill(job, "interrupted");
        };
        self.card_busy = true;
        if prepared.as_ref().map(|p| p.group) != Some(group) {
            match self.prepare_card_group(&binding, &groups[group], None) {
                Ok(members) => *prepared = Some(Prepared { group, members }),
                Err(e) => {
                    crate::logs::write(&format!(
                        "tether backfill prepare {}: {}",
                        e.code, e.message
                    ));
                    let objects = groups[group].clone();
                    queue.finish_group(Outcome::Failed);
                    for object in &objects {
                        job.note_unsettled(object);
                    }
                    self.emit_backfill(&job, job.state(), None);
                    self.backfill = Some(job);
                    return;
                }
            }
        }
        let object = groups[group][item].clone();
        let member = &mut prepared.as_mut().unwrap().members[item];
        if let PreparedMember::ClaimedLive(member_id) = member {
            match self.prepare_card_group(&binding, std::slice::from_ref(&object), Some(member_id))
            {
                Ok(mut refreshed) => *member = refreshed.remove(0),
                Err(e) => return self.finish_backfill_with(job, "error", Some(&e.message)),
            }
        }
        let outcome = match member.clone() {
            PreparedMember::Read(plan) => match self.open_card_read(&binding, &object, plan) {
                Ok(Ok(read)) => {
                    put_reading(&mut job, Reading { item, ..read });
                    self.backfill = Some(job);
                    return;
                }
                Ok(Err(outcome)) => outcome,
                Err(message) => {
                    job.note_unsettled(&object);
                    if let Phase::Pulling { queue, .. } = &mut job.phase {
                        queue.advance(Outcome::Failed);
                    }
                    return self.finish_backfill_with(job, "error", Some(&message));
                }
            },
            PreparedMember::Deferred | PreparedMember::ClaimedLive(_) => Outcome::Deferred,
            PreparedMember::Present => Outcome::Present,
        };
        self.advance(job, &object, outcome);
    }

    fn advance(&mut self, mut job: Backfill, object: &CardObject, outcome: Outcome) {
        if let Phase::Pulling { queue, .. } = &mut job.phase {
            queue.advance(outcome);
        }
        job.record(object, outcome);
        self.emit_backfill(&job, job.state(), None);
        self.backfill = Some(job);
    }

    fn host_roles(&self) -> Vec<&'static str> {
        self.session
            .as_ref()
            .and_then(|s| s.expected_host_roles())
            .map(|roles| roles.iter().map(|r| r.as_str()).collect())
            .unwrap_or_default()
    }

    /// Members whose photo may still arrive by another way; their card copies wait.
    fn unready_members(&self) -> Vec<String> {
        let mut members: Vec<String> = self
            .inner
            .recovery
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        members.extend(
            self.late_claims
                .values()
                .filter(|c| c.epoch == self.epoch && c.created_at.elapsed() < LATE_CLAIM_TTL)
                .map(|c| c.plan.member_id.clone()),
        );
        members
    }

    /// Asks Node, right before reading, which files of this exposure are still missing; each
    /// returned plan is a member that will receive the card file.
    fn prepare_card_group(
        &self,
        binding: &Binding,
        objects: &[CardObject],
        live_claim: Option<&str>,
    ) -> TResult<Vec<PreparedMember>> {
        let mut exclude = self.unready_members();
        if let Some(member_id) = live_claim {
            exclude.push(member_id.to_owned());
        }
        let reply = node_blocking(
            &self.inner.app,
            "tether-backfill",
            json!([binding.shoot_id, "prepare", {
                "camera": self.card_camera(),
                "epoch": self.epoch,
                "exclude": exclude,
                "objects": objects.iter().map(card_object_json).collect::<Vec<_>>(),
            }]),
        )?;
        let exposure_id = reply["exposureId"].as_str().map(String::from);
        let names = |field: &str| -> HashMap<(u64, u64), Value> {
            reply[field]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| {
                    Some(((m["storageId"].as_u64()?, m["handle"].as_u64()?), m.clone()))
                })
                .collect()
        };
        let (members, deferred) = (names("members"), names("deferred"));
        let mut prepared = Vec::with_capacity(objects.len());
        for object in objects {
            let key = (object.storage_id as u64, object.handle as u64);
            let plan = match (members.get(&key), &exposure_id) {
                (Some(m), Some(exposure_id)) => PreparedMember::Read(MemberPlan {
                    exposure_id: exposure_id.clone(),
                    member_id: str_field(m, "memberId")?,
                    stage_rel: str_field(m, "stageRelPath")?,
                    status: str_field(m, "status")?,
                    name: str_field(m, "originalName")?,
                    declared: m["declaredBytes"].as_u64(),
                }),
                _ if deferred.contains_key(&key) => PreparedMember::Deferred,
                _ => PreparedMember::Present,
            };
            prepared.push(plan);
        }
        Ok(prepared)
    }

    /// Opens the member's stage file for a card read. The outer error stops the pass.
    fn open_card_read(
        &mut self,
        binding: &Binding,
        object: &CardObject,
        plan: MemberPlan,
    ) -> std::result::Result<std::result::Result<Reading, Outcome>, String> {
        let app = self.inner.app.clone();
        let shoot = binding.shoot_id.as_str();
        let failed = |e: TetherError| {
            journal_issue(&app, shoot, &plan.member_id, &e);
            Outcome::Failed
        };
        let Some(session) = self.session.as_ref() else {
            return Ok(Err(Outcome::Deferred));
        };
        let read = match CardRead::new(session, object, MAX_CAPTURE_BYTES) {
            Ok(read) => read,
            Err(message) => return Ok(Err(failed(TetherError::new("UNSUPPORTED", message)))),
        };
        let declared = object.info.compressed_size as u64;
        if let Ok(free) = transfer::free_space(&binding.root) {
            if !transfer::has_room(free, declared) {
                let e = TetherError::new(
                    "NO_SPACE",
                    "The capture disk is almost full. Free space or choose another folder; the photo stays on the card.",
                );
                failed(e.clone());
                return Err(e.message);
            }
        }
        let writer = transfer::stage_path(&binding.root, &plan.stage_rel)
            .and_then(|path| StageWriter::create(path, declared));
        match writer {
            Ok(writer) => Ok(Ok(Reading {
                item: 0,
                object: object.clone(),
                plan,
                read,
                writer,
                started: Instant::now(),
            })),
            Err(e) => Ok(Err(failed(TetherError::from_transfer(e)))),
        }
    }

    /// Reads the next part of the card file in progress.
    fn continue_read(&mut self, mut job: Backfill, mut reading: Reading) {
        let (Some(binding), Some(session)) = (self.binding(), self.session.as_mut()) else {
            put_reading(&mut job, reading);
            return self.finish_backfill(job, "interrupted");
        };
        // An orphan left by any other transaction is not this file; the card keeps its own.
        drop(session.transport_mut().take_orphan());
        self.inner.receiving.fetch_add(1, Ordering::SeqCst);
        let step = reading.read.step(session, &mut reading.writer);
        self.inner.receiving.fetch_sub(1, Ordering::SeqCst);
        drop(session.transport_mut().take_orphan());
        let object = reading.object.clone();
        let app = self.inner.app.clone();
        let shoot = binding.shoot_id.clone();
        let fail = |reading: Reading, e: TetherError| {
            drop(reading.writer);
            journal_issue(&app, &shoot, &reading.plan.member_id, &e);
            Outcome::Failed
        };
        let outcome = match step {
            Ok(ReadStep::Yield | ReadStep::Busy) => {
                put_reading(&mut job, reading);
                self.backfill = Some(job);
                return;
            }
            Ok(ReadStep::More) => {
                self.card_busy = true;
                put_reading(&mut job, reading);
                self.backfill = Some(job);
                return;
            }
            Ok(ReadStep::Gone) => {
                let name = reading.plan.name.clone();
                fail(
                    reading,
                    TetherError::new(
                        "INCOMPLETE",
                        format!("{name} could not be read from the camera card; it stays there."),
                    ),
                )
            }
            Ok(ReadStep::Done { bytes, declared }) if bytes != declared => {
                let name = reading.plan.name.clone();
                fail(
                    reading,
                    TetherError::new(
                        "INCOMPLETE",
                        format!("The camera card sent {bytes} of {declared} bytes of {name}; the photo stays on the card."),
                    ),
                )
            }
            Ok(ReadStep::Done { bytes, .. }) => {
                self.card_busy = true;
                self.publish_card_file(&binding, &object, reading, bytes)
            }
            Err(e) => {
                let error = if matches!(e, SessionError::Removed { .. }) {
                    TetherError::new(
                        "CAMERA_LOST",
                        "The camera disconnected while this photo was read from its card. It stays on the card.",
                    )
                } else {
                    TetherError::from_session(e_clone(&e))
                };
                fail(reading, error);
                job.note_unsettled(&object);
                if let Phase::Pulling { queue, .. } = &mut job.phase {
                    queue.advance(Outcome::Failed);
                }
                return self.card_error(job, e);
            }
        };
        self.advance(job, &object, outcome);
    }

    /// Verifies and journals a complete card file, then publishes it like a live capture.
    fn publish_card_file(
        &mut self,
        binding: &Binding,
        object: &CardObject,
        reading: Reading,
        bytes: u64,
    ) -> Outcome {
        let Reading {
            plan,
            writer,
            started,
            ..
        } = reading;
        let app = self.inner.app.clone();
        let shoot = binding.shoot_id.as_str();
        let failed = |e: TetherError| {
            journal_issue(&app, shoot, &plan.member_id, &e);
            Outcome::Failed
        };
        let stage = writer.path().to_path_buf();
        let receipt = match writer.finish() {
            Ok(receipt) => receipt,
            Err(e) => return failed(TetherError::from_transfer(e)),
        };
        let seconds = started.elapsed().as_secs_f64().max(1e-3);
        self.emit_transfer(&plan, "staged", bytes, Some(bytes as f64 / 1e6 / seconds));
        if let Err(e) = transfer::validate_staged_signature(&stage, &plan.name) {
            return failed(TetherError::from_transfer(e));
        }
        let device = self.device.clone().unwrap_or_default();
        let shot = camera_snapshot(&device, &ExposureSnapshot::default(), Some(&object.info));
        journal_staged(&app, shoot, &plan, &receipt, &shot);
        crate::logs::write(&format!(
            "tether backfill pulled {} ({} bytes)",
            plan.name, bytes
        ));
        spawn_publish(
            self.inner.clone(),
            binding.clone(),
            plan,
            receipt,
            shot,
            self.epoch,
        );
        Outcome::Pulled
    }

    /// A card transaction failed. A camera that keeps failing card reads is not read again by
    /// itself after a reconnect.
    fn card_error(&mut self, job: Backfill, e: SessionError) {
        let message = TetherError::from_session(e_clone(&e)).message;
        if !matches!(e, SessionError::Removed { .. }) {
            self.card_failed.insert(job.body.clone());
        }
        let ended = self.handle_session_error(e);
        let state = if ended { "interrupted" } else { "error" };
        self.finish_backfill_with(job, state, Some(&message));
    }

    fn finish_backfill(&mut self, job: Backfill, state: &str) {
        self.finish_backfill_with(job, state, None);
    }

    fn finish_backfill_with(&mut self, job: Backfill, state: &str, message: Option<&str>) {
        self.release_unread(&job);
        if state != "done" {
            self.emit_backfill(&job, state, message);
            return;
        }
        self.card_failed.remove(&job.body);
        if let (Some(through), Some(binding)) = (job.synced_through(), self.binding()) {
            if let Err(e) = node_blocking(
                &self.inner.app,
                "tether-backfill",
                json!([binding.shoot_id, "synced", { "camera": self.card_camera(), "through": through }]),
            ) {
                crate::logs::write(&format!("tether backfill synced {}: {}", e.code, e.message));
            }
        }
        if job.listed == 0 && !job.blind {
            self.emit_backfill(&job, "empty", Some(EMPTY));
        } else {
            self.emit_backfill(&job, "done", None);
        }
    }

    /// Members prepared for files the pass will not read now wait for the next pull.
    fn release_unread(&self, job: &Backfill) {
        let Phase::Pulling {
            queue,
            prepared: Some(prepared),
            reading,
            ..
        } = &job.phase
        else {
            return;
        };
        let from = match (reading, queue.next()) {
            (Some(read), _) => read.item,
            (None, PullStep::Item { group, item }) if group == prepared.group => item,
            _ => return,
        };
        let Some(shoot) = &self.shoot_id else {
            return;
        };
        let e = TetherError::new(
            "INCOMPLETE",
            "Not read from the camera card yet; it stays there for the next pull.",
        );
        for member in &prepared.members[from..] {
            if let PreparedMember::Read(plan) = member {
                journal_issue(&self.inner.app, shoot, &plan.member_id, &e);
            }
        }
    }

    /// Ends a running pass; the photos not yet pulled stay on the card for the next one.
    pub(super) fn end_backfill(&mut self, state: &str, reason: Option<&str>) -> Value {
        self.backfill_due = None;
        match self.backfill.take() {
            Some(job) => {
                self.release_unread(&job);
                self.emit_backfill(&job, state, reason)
            }
            None => self.backfill_payload(None, "idle", None),
        }
    }

    fn emit_backfill(&self, job: &Backfill, state: &str, message: Option<&str>) -> Value {
        let payload = self.backfill_payload(Some(job), state, message);
        emit(&self.inner.app, "tether-backfill", payload.clone());
        payload
    }

    fn backfill_payload(
        &self,
        job: Option<&Backfill>,
        state: &str,
        message: Option<&str>,
    ) -> Value {
        let mut payload = json!({
            "v": 1,
            "shootId": self.shoot_id,
            "epoch": job.map_or(self.epoch, |j| j.epoch),
            "state": state,
            "storageAvailable": state != "unavailable",
            "message": message,
        });
        let Some(job) = job else {
            return payload;
        };
        payload["pass"] = job.pass.into();
        payload["auto"] = job.auto.into();
        payload["paused"] = job.paused.into();
        payload["already"] = job.already.into();
        payload["held"] = job.held.into();
        payload["truncated"] = job.truncated.into();
        payload["incomplete"] = job.blind.into();
        match &job.phase {
            Phase::Scanning(scan) => {
                payload["scanned"] = scan.inspected.into();
                payload["listed"] = scan.listed.into();
                payload["found"] = scan.found.len().into();
            }
            Phase::Planning { objects, .. } => {
                payload["listed"] = job.listed.into();
                payload["found"] = objects.len().into();
            }
            Phase::Pulling { queue, .. } => {
                let (current, total) = queue.progress();
                payload["listed"] = job.listed.into();
                payload["current"] = current.into();
                payload["total"] = total.into();
                payload["shots"] = queue.shots.into();
                payload["pulled"] = queue.pulled.into();
                payload["failed"] = queue.failed.into();
                payload["deferred"] = (job.deferred + queue.deferred).into();
                payload["present"] = queue.present.into();
            }
        }
        payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ledger_window_becomes_a_card_stamp() {
        assert_eq!(
            card_stamp("2026:11:25 14:03:09").as_deref(),
            Some("20261125T140309")
        );
        assert_eq!(card_stamp("2026-11-25"), None);
        assert_eq!(card_stamp(""), None);
    }

    #[test]
    fn only_an_explicit_false_turns_off_the_automatic_pass() {
        assert!(auto_backfill_enabled(
            &json!({ "tether": { "autoBackfill": true } })
        ));
        assert!(!auto_backfill_enabled(
            &json!({ "tether": { "autoBackfill": false } })
        ));
        assert!(auto_backfill_enabled(&json!({})));
    }
}
