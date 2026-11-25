//! Missed-shot backfill: after a reconnect, or when the photographer asks, photos the camera saved
//! to its card during the shoot but never delivered are read from the card and go through the same
//! staging, journal and publication as live captures. The card is only read, never changed.

use super::protocol::card::{CardAccess, CardObject, CardScan, Outcome, PullQueue, PullStep};
use super::*;

/// Card objects inspected per actor turn, so a live capture never waits long.
const SCAN_BATCH: usize = 8;
/// Lets the camera's own capture queue drain after a reconnect before the card is read.
const AUTO_DELAY: Duration = Duration::from_secs(3);
/// Publications in flight above which the card waits.
const PUBLISH_BACKLOG: usize = 4;

pub(super) enum BackfillOp {
    Start,
    Pause,
    Resume,
    Cancel,
}

pub(super) struct Backfill {
    epoch: u64,
    auto: bool,
    paused: bool,
    /// Newest capture time seen inside the window, as `YYYY:MM:DD hh:mm:ss`.
    newest: Option<String>,
    /// Exposures the ledger already held in full.
    already: usize,
    phase: Phase,
    last_emit: Instant,
}

enum Phase {
    Scanning(CardScan),
    Pulling {
        groups: Vec<Vec<CardObject>>,
        queue: PullQueue,
        prepared: Option<(usize, Vec<Option<MemberPlan>>)>,
    },
}

enum Stop {
    Interrupted,
    Error(String),
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
    let declared = object.info.compressed_size;
    json!({
        "handle": object.handle,
        "storageId": object.storage_id,
        "name": object_name(&object.info, object.kind),
        "role": object.kind.role(),
        "bytes": if declared == u32::MAX { 0 } else { declared },
        "captureTime": capture_time(&object.info),
    })
}

impl Actor {
    pub(super) fn backfill_command(&mut self, op: BackfillOp) -> TResult<Value> {
        match op {
            BackfillOp::Start if self.backfill.is_none() => return self.start_backfill(false),
            BackfillOp::Start | BackfillOp::Resume => self.pause_backfill(false),
            BackfillOp::Pause => self.pause_backfill(true),
            BackfillOp::Cancel => {
                let at_boundary = match self.backfill.as_mut().map(|job| &mut job.phase) {
                    Some(Phase::Pulling { queue, .. }) => {
                        queue.cancel();
                        queue.next(false) == PullStep::Cancelled
                    }
                    Some(Phase::Scanning(_)) => true,
                    None => false,
                };
                if at_boundary {
                    return Ok(self.end_backfill("cancelled", None));
                }
                if let Some(job) = &self.backfill {
                    self.emit_backfill(job, job_state(job), None);
                }
            }
        }
        Ok(match &self.backfill {
            Some(job) => self.backfill_payload(Some(job), job_state(job), None),
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
            self.emit_backfill(job, job_state(job), None);
        }
    }

    pub(super) fn start_backfill(&mut self, auto: bool) -> TResult<Value> {
        let binding = self.binding().ok_or_else(TetherError::stale_session)?;
        self.ready_session()?;
        let window = node_blocking(
            &self.inner.app,
            "tether-backfill",
            json!([binding.shoot_id, "window", {}]),
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
        let session = self.ready_session()?;
        let opened = CardScan::open(session, Some(since));
        let scan = match opened {
            Ok(CardAccess::Listed(scan)) => scan,
            Ok(CardAccess::Unavailable(reason)) => {
                crate::logs::write(&format!("tether backfill unavailable: {reason}"));
                let mut payload = self.backfill_payload(None, "unavailable", Some(reason));
                payload["auto"] = auto.into();
                emit(&self.inner.app, "tether-backfill", payload.clone());
                return Ok(payload);
            }
            Err(e) => {
                let error = TetherError::from_session(e_clone(&e));
                self.handle_session_error(e);
                return Err(error);
            }
        };
        crate::logs::write(&format!(
            "tether backfill: {} objects on {} storage(s)",
            scan.listed,
            scan.storages.len()
        ));
        let job = Backfill {
            epoch: self.epoch,
            auto,
            paused: false,
            newest: None,
            already: 0,
            phase: Phase::Scanning(scan),
            last_emit: Instant::now(),
        };
        let payload = self.emit_backfill(&job, "scanning", None);
        self.backfill = Some(job);
        Ok(payload)
    }

    /// Schedules the automatic pass after a reconnect within the same shoot.
    pub(super) fn after_connect(&mut self, shoot_id: &str) {
        let reconnected = self.connected_shoot.as_deref() == Some(shoot_id);
        self.connected_shoot = Some(shoot_id.to_string());
        self.backfill_due = reconnected.then(|| Instant::now() + AUTO_DELAY);
    }

    /// Nothing from a live capture is waiting, arriving or held, so a card read cannot delay one.
    fn card_may_read(&self) -> bool {
        self.pending.is_empty()
            && self.cohorts.pending_test.is_none()
            && self.half_press_since.is_none()
            && self.inner.receiving.load(Ordering::SeqCst) == 0
            && self.inner.outstanding.load(Ordering::SeqCst) < PUBLISH_BACKLOG
            && self.inner.drain_hold.lock().unwrap().is_none()
            && self.binding().is_some()
            && self.session.as_ref().is_some_and(|s| {
                s.state() == ConnectionState::Ready
                    && !s.object_announced()
                    && s.queue_signal() == QueueSignal::Empty
            })
    }

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
        if !self.card_may_read() {
            return;
        }
        let Some(job) = self.backfill.take() else {
            return;
        };
        if job.epoch != self.epoch {
            self.emit_backfill(&job, "interrupted", None);
            return;
        }
        match job.phase {
            Phase::Scanning(_) => self.scan_step(job),
            Phase::Pulling { .. } => self.pull_step(job),
        }
    }

    fn scan_step(&mut self, mut job: Backfill) {
        if job.paused || self.session.is_none() {
            self.backfill = Some(job);
            return;
        }
        let (Phase::Scanning(scan), Some(session)) = (&mut job.phase, self.session.as_mut()) else {
            return;
        };
        let result = scan.step(session, SCAN_BATCH);
        match result {
            Ok(false) => {
                if job.last_emit.elapsed() >= Duration::from_millis(300) {
                    job.last_emit = Instant::now();
                    self.emit_backfill(&job, "scanning", None);
                }
                self.backfill = Some(job);
            }
            Ok(true) => {
                let found = match &mut job.phase {
                    Phase::Scanning(scan) => std::mem::take(&mut scan.found),
                    Phase::Pulling { .. } => Vec::new(),
                };
                self.plan_backfill(job, found);
            }
            Err(e) => {
                let message = TetherError::from_session(e_clone(&e)).message;
                let stop = if self.handle_session_error(e) {
                    Stop::Interrupted
                } else {
                    Stop::Error(message)
                };
                self.stop_backfill(job, stop);
            }
        }
    }

    fn plan_backfill(&mut self, mut job: Backfill, found: Vec<CardObject>) {
        let Some(binding) = self.binding() else {
            return self.stop_backfill(job, Stop::Interrupted);
        };
        // Test shots stay out of the shoot whatever the card holds.
        let found: Vec<CardObject> = found
            .into_iter()
            .filter(|o| {
                let stem = file_stem(&object_name(&o.info, o.kind)).to_uppercase();
                capture_time(&o.info).map_or(true, |t| !self.test_shots.contains(&(t, stem)))
            })
            .collect();
        job.newest = found.iter().filter_map(|o| capture_time(&o.info)).max();
        let groups: Vec<Vec<CardObject>> = if found.is_empty() {
            Vec::new()
        } else {
            let objects: Vec<Value> = found.iter().map(card_object_json).collect();
            let planned = node_blocking(
                &self.inner.app,
                "tether-backfill",
                json!([binding.shoot_id, "plan", {
                    "body": self.body_key(),
                    "hostRoles": self.host_roles(),
                    "objects": objects,
                }]),
            );
            let planned = match planned {
                Ok(planned) => planned,
                Err(e) => return self.stop_backfill(job, Stop::Error(e.message)),
            };
            job.already = planned["present"].as_u64().unwrap_or(0) as usize;
            let pick = |entry: &Value| {
                found
                    .iter()
                    .find(|o| {
                        entry["handle"].as_u64() == Some(o.handle as u64)
                            && entry["storageId"].as_u64() == Some(o.storage_id as u64)
                    })
                    .cloned()
            };
            planned["groups"]
                .as_array()
                .map(|groups| {
                    groups
                        .iter()
                        .filter_map(|g| {
                            let objects: Vec<CardObject> =
                                g["objects"].as_array()?.iter().filter_map(&pick).collect();
                            (!objects.is_empty()).then_some(objects)
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        crate::logs::write(&format!(
            "tether backfill: {} in the window, {} exposure(s) missing, {} already here",
            found.len(),
            groups.len(),
            job.already
        ));
        let mut queue = PullQueue::new(groups.iter().map(Vec::len).collect());
        queue.set_paused(job.paused);
        job.phase = Phase::Pulling {
            groups,
            queue,
            prepared: None,
        };
        self.pull_step(job);
    }

    fn pull_step(&mut self, mut job: Backfill) {
        let Phase::Pulling {
            groups,
            queue,
            prepared,
        } = &mut job.phase
        else {
            return;
        };
        let (group, item) = match queue.next(false) {
            PullStep::Finished => return self.finish_backfill(job, "done"),
            PullStep::Cancelled => return self.finish_backfill(job, "cancelled"),
            PullStep::Paused | PullStep::Wait => {
                self.backfill = Some(job);
                return;
            }
            PullStep::Item { group, item } => (group, item),
        };
        let Some(binding) = self.binding() else {
            return self.stop_backfill(job, Stop::Interrupted);
        };
        if prepared.as_ref().map(|(g, _)| *g) != Some(group) {
            match self.prepare_card_group(&binding, &groups[group]) {
                Ok(plans) => *prepared = Some((group, plans)),
                Err(e) => {
                    crate::logs::write(&format!(
                        "tether backfill prepare {}: {}",
                        e.code, e.message
                    ));
                    queue.finish_group(Outcome::Failed);
                    self.emit_backfill(&job, job_state(&job), None);
                    self.backfill = Some(job);
                    return;
                }
            }
        }
        let plan = prepared
            .as_ref()
            .and_then(|(_, plans)| plans.get(item).cloned().flatten());
        let outcome = match plan {
            None => Outcome::Present,
            Some(plan) => match self.pull_card_object(&binding, &groups[group][item], plan) {
                Ok(outcome) => outcome,
                Err(stop) => {
                    queue.advance(Outcome::Failed);
                    return self.stop_backfill(job, stop);
                }
            },
        };
        queue.advance(outcome);
        self.emit_backfill(&job, job_state(&job), None);
        self.backfill = Some(job);
    }

    fn body_key(&self) -> String {
        let device = self.device.clone().unwrap_or_default();
        if device.serial.is_empty() {
            device.model
        } else {
            device.serial
        }
    }

    fn host_roles(&self) -> Vec<&'static str> {
        self.session
            .as_ref()
            .and_then(|s| s.expected_host_roles())
            .map(|roles| roles.iter().map(|r| r.as_str()).collect())
            .unwrap_or_default()
    }

    /// Asks Node, right before reading, which files of this exposure are still missing; each
    /// returned plan is a member that will receive the card file.
    fn prepare_card_group(
        &self,
        binding: &Binding,
        objects: &[CardObject],
    ) -> TResult<Vec<Option<MemberPlan>>> {
        let device = self.device.clone().unwrap_or_default();
        // Members whose photo may still arrive by another way are left alone.
        let mut exclude: Vec<String> = self
            .inner
            .recovery
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        exclude.extend(self.late_claims.values().map(|c| c.plan.member_id.clone()));
        let reply = node_blocking(
            &self.inner.app,
            "tether-backfill",
            json!([binding.shoot_id, "prepare", {
                "body": self.body_key(),
                "hostRoles": self.host_roles(),
                "epoch": self.epoch,
                "camera": camera_snapshot(&device, &ExposureSnapshot::default(), None),
                "exclude": exclude,
                "objects": objects.iter().map(card_object_json).collect::<Vec<_>>(),
            }]),
        )?;
        let exposure_id = reply["exposureId"].as_str().map(String::from);
        let members = reply["members"].as_array().cloned().unwrap_or_default();
        let mut plans = Vec::with_capacity(objects.len());
        for object in objects {
            let member = members.iter().find(|m| {
                m["handle"].as_u64() == Some(object.handle as u64)
                    && m["storageId"].as_u64() == Some(object.storage_id as u64)
            });
            let plan = match (member, &exposure_id) {
                (Some(m), Some(exposure_id)) => Some(MemberPlan {
                    exposure_id: exposure_id.clone(),
                    member_id: str_field(m, "memberId")?,
                    stage_rel: str_field(m, "stageRelPath")?,
                    status: str_field(m, "status")?,
                    name: str_field(m, "originalName")?,
                    declared: m["declaredBytes"].as_u64(),
                }),
                _ => None,
            };
            plans.push(plan);
        }
        Ok(plans)
    }

    /// Reads one card file into its member's stage file and publishes it like a live capture.
    fn pull_card_object(
        &mut self,
        binding: &Binding,
        object: &CardObject,
        plan: MemberPlan,
    ) -> std::result::Result<Outcome, Stop> {
        if !matches!(plan.status.as_str(), "announced" | "receiving") {
            return Ok(Outcome::Present);
        }
        let app = self.inner.app.clone();
        let shoot = binding.shoot_id.as_str();
        let failed = |e: TetherError| {
            journal_issue(&app, shoot, &plan.member_id, &e);
            Outcome::Failed
        };
        if let Ok(free) = transfer::free_space(&binding.root) {
            if !transfer::has_room(free, plan.declared.unwrap_or(DEFAULT_OBJECT_BUDGET)) {
                let e = TetherError::new(
                    "NO_SPACE",
                    "The capture disk is almost full. Free space or choose another folder; the photo stays on the card.",
                );
                failed(e.clone());
                return Err(Stop::Error(e.message));
            }
        }
        let limit = plan.declared.unwrap_or(0).max(MAX_CAPTURE_BYTES);
        let writer = transfer::stage_path(&binding.root, &plan.stage_rel)
            .and_then(|path| StageWriter::create(path, limit));
        let mut writer = match writer {
            Ok(writer) => writer,
            Err(e) => return Ok(failed(TetherError::from_transfer(e))),
        };
        let device = self.device.clone().unwrap_or_default();
        let Some(session) = self.session.as_mut() else {
            failed(TetherError::new("CAMERA_LOST", "The camera disconnected."));
            return Err(Stop::Interrupted);
        };
        // An orphan left by any other transaction is not this file; the card keeps its own.
        drop(session.transport_mut().take_orphan());
        self.inner.receiving.fetch_add(1, Ordering::SeqCst);
        let started = Instant::now();
        let read = session.read_object(object.handle, &object.info, &mut writer);
        self.inner.receiving.fetch_sub(1, Ordering::SeqCst);
        drop(session.transport_mut().take_orphan());
        let read = match read {
            Ok(Some(read)) => read,
            Ok(None) => {
                drop(writer);
                return Ok(failed(TetherError::new(
                    "INCOMPLETE",
                    format!(
                        "{} could not be read from the camera card; it stays there.",
                        plan.name
                    ),
                )));
            }
            Err(e) => {
                drop(writer);
                let error = if matches!(e, SessionError::Removed { .. }) {
                    TetherError::new(
                        "CAMERA_LOST",
                        "The camera disconnected while this photo was read from its card. It stays on the card.",
                    )
                } else {
                    TetherError::from_session(e_clone(&e))
                };
                failed(error);
                return if self.handle_session_error(e) {
                    Err(Stop::Interrupted)
                } else {
                    Ok(Outcome::Failed)
                };
            }
        };
        if !read.complete() {
            drop(writer);
            return Ok(failed(TetherError::new(
                "INCOMPLETE",
                format!(
                    "The camera card sent {} of {} bytes of {}; the photo stays on the card.",
                    read.bytes,
                    read.declared.unwrap_or(0),
                    plan.name
                ),
            )));
        }
        let stage = writer.path().to_path_buf();
        let receipt = match writer.finish() {
            Ok(receipt) => receipt,
            Err(e) => return Ok(failed(TetherError::from_transfer(e))),
        };
        let seconds = started.elapsed().as_secs_f64().max(1e-3);
        self.emit_transfer(
            &plan,
            "staged",
            read.bytes,
            Some(read.bytes as f64 / 1e6 / seconds),
        );
        if let Err(e) = transfer::validate_staged_signature(&stage, &plan.name) {
            return Ok(failed(TetherError::from_transfer(e)));
        }
        let shot = camera_snapshot(&device, &ExposureSnapshot::default(), Some(&object.info));
        journal_staged(&app, shoot, &plan, &receipt, &shot);
        crate::logs::write(&format!(
            "tether backfill pulled {} ({} bytes)",
            plan.name, read.bytes
        ));
        spawn_publish(
            self.inner.clone(),
            binding.clone(),
            plan,
            receipt,
            shot,
            self.epoch,
        );
        Ok(Outcome::Pulled)
    }

    fn finish_backfill(&mut self, job: Backfill, state: &str) {
        let clean = match &job.phase {
            Phase::Pulling { queue, .. } => queue.failed == 0,
            Phase::Scanning(_) => false,
        };
        if state == "done" && clean {
            if let (Some(through), Some(binding)) = (&job.newest, self.binding()) {
                if let Err(e) = node_blocking(
                    &self.inner.app,
                    "tether-backfill",
                    json!([binding.shoot_id, "synced", { "through": through }]),
                ) {
                    crate::logs::write(&format!(
                        "tether backfill synced {}: {}",
                        e.code, e.message
                    ));
                }
            }
        }
        self.emit_backfill(&job, state, None);
    }

    fn stop_backfill(&mut self, job: Backfill, stop: Stop) {
        match stop {
            Stop::Interrupted => self.emit_backfill(&job, "interrupted", None),
            Stop::Error(message) => self.emit_backfill(&job, "error", Some(&message)),
        };
    }

    /// Ends a running pass; the photos not yet pulled stay on the card for the next one.
    pub(super) fn end_backfill(&mut self, state: &str, reason: Option<&str>) -> Value {
        self.backfill_due = None;
        match self.backfill.take() {
            Some(job) => self.emit_backfill(&job, state, reason),
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
            "epoch": self.epoch,
            "state": state,
            "storageAvailable": state != "unavailable",
            "message": message,
        });
        let Some(job) = job else {
            return payload;
        };
        payload["auto"] = job.auto.into();
        payload["paused"] = job.paused.into();
        payload["already"] = job.already.into();
        match &job.phase {
            Phase::Scanning(scan) => {
                payload["scanned"] = scan.inspected.into();
                payload["listed"] = scan.listed.into();
                payload["found"] = scan.found.len().into();
            }
            Phase::Pulling { queue, .. } => {
                let (current, total) = queue.progress();
                payload["current"] = current.into();
                payload["total"] = total.into();
                payload["shots"] = queue.shots.into();
                payload["pulled"] = queue.pulled.into();
                payload["failed"] = queue.failed.into();
                payload["present"] = queue.present.into();
            }
        }
        payload
    }
}

fn job_state(job: &Backfill) -> &'static str {
    match (&job.phase, job.paused) {
        (Phase::Pulling { queue, .. }, _) if queue.cancelling() => "cancelling",
        (_, true) => "paused",
        (Phase::Scanning(_), false) => "scanning",
        (Phase::Pulling { .. }, false) => "pulling",
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
