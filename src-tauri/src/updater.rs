use crate::{backend::Backend, logs, tether::TetherManager};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    available: tokio::sync::Mutex<Option<Update>>,
    installing: AtomicBool,
}

struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn friendly_message(error: &Error) -> String {
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => {
            "The update service could not be reached. Check your connection and try again."
        }
        Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::UnsupportedArch
        | Error::UnsupportedOs => "This release has no update for your platform.",
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "PhotoCull could not verify the update signature. Please try again later."
        }
        Error::Serialization(_) | Error::Semver(_) => {
            "The update service returned invalid release information. Please try again later."
        }
        Error::PreviousAppNotRestored(_) | Error::Io(_) | Error::AuthenticationFailed => {
            return error.to_string()
        }
        _ => "PhotoCull could not apply the update. Please try again later.",
    }
    .to_owned()
}

fn install_error(error: &Error) -> String {
    let reason = friendly_message(error);
    #[cfg(windows)]
    let reason = format!("{reason} Restart PhotoCull before retrying the update.");
    reason
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater_builder()
        .timeout(Duration::from_secs(20))
        .build()?
        .check()
        .await
}

fn release_info(status: &str, update: &Update) -> Value {
    json!({
        "status": status, "currentVersion": update.current_version, "version": update.version,
        "body": update.body, "date": update.raw_json.get("pub_date"),
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let mut cached = state.available.lock().await;
    match check(&app).await {
        Ok(Some(update)) => {
            let result = release_info("available", &update);
            *cached = Some(update);
            Ok(result)
        }
        Ok(None) => {
            *cached = None;
            Ok(json!({ "status": "up-to-date", "currentVersion": current }))
        }
        Err(error) => {
            *cached = None;
            let message = friendly_message(&error);
            logs::write(&format!("Update check failed: {message}"));
            Ok(json!({ "status": "error", "currentVersion": current, "message": message }))
        }
    }
}

#[derive(Default)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    last_bytes: Option<u64>,
    last_percent: Option<u64>,
}

impl Progress {
    fn advance(&mut self, bytes: usize, total: Option<u64>) -> Option<Value> {
        self.downloaded = self.downloaded.saturating_add(bytes as u64);
        self.total = total;
        let percent = total
            .filter(|&n| n > 0)
            .map(|n| (u128::from(self.downloaded.min(n)) * 100 / u128::from(n)) as u64);
        let report = self.last_bytes.is_none()
            || percent != self.last_percent
            || (percent.is_none() && self.downloaded - self.last_bytes.unwrap_or(0) >= 64 * 1024);
        if !report {
            return None;
        }
        self.last_bytes = Some(self.downloaded);
        self.last_percent = percent;
        Some(
            json!({ "phase": "downloading", "downloaded": self.downloaded, "total": total, "percent": percent }),
        )
    }

    fn installing(&self) -> Value {
        json!({ "phase": "installing", "downloaded": self.downloaded, "total": self.total, "percent": 100 })
    }
}

async fn install(
    app: &AppHandle,
    state: &UpdateState,
    tether: &TetherManager,
    _backend: &Backend,
    expected_version: Option<&str>,
) -> Result<Value, String> {
    let mut cached = state.available.lock().await;
    if cached.is_none() {
        *cached = check(app).await.map_err(|e| friendly_message(&e))?;
    }
    let Some(mut update) = cached.clone() else {
        return Ok(
            json!({ "status": "up-to-date", "currentVersion": app.package_info().version.to_string() }),
        );
    };
    drop(cached);
    if expected_version.is_some_and(|expected| expected != update.version) {
        return Ok(release_info("changed", &update));
    }

    update.timeout = Some(Duration::from_secs(300));
    let progress = Mutex::new(Progress::default());
    let bytes = update
        .download(
            |bytes, total| {
                if let Some(event) = progress.lock().unwrap().advance(bytes, total) {
                    let _ = app.emit("update-progress", event);
                }
            },
            || {},
        )
        .await
        .map_err(|e| friendly_message(&e))?;
    let _shoot = tether.lock_between_shoots().await.ok_or(
        "Stop the tethered shoot and finish saving pending photos before installing an update.",
    )?;
    let _ = app.emit("update-progress", progress.lock().unwrap().installing());
    #[cfg(windows)]
    _backend.shutdown();
    update.install(&bytes).map_err(|e| install_error(&e))?;
    logs::write(&format!("Updated to {}; restarting.", update.version));
    app.restart()
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    tether: State<'_, TetherManager>,
    backend: State<'_, Backend>,
    expected_version: Option<String>,
) -> Result<Value, String> {
    if state.installing.swap(true, Ordering::AcqRel) {
        return Err("An update is already being installed.".into());
    }
    let _install = InstallGuard(&state.installing);
    let result = install(&app, &state, &tether, &backend, expected_version.as_deref()).await;
    if let Err(message) = &result {
        logs::write(&format!("Update installation failed: {message}"));
        let _ = app.emit(
            "update-progress",
            json!({ "phase": "error", "message": message }),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_events_count_chunks_and_clamp_at_the_reported_length() {
        let mut p = Progress::default();
        assert_eq!(p.advance(49, Some(1000)).unwrap()["percent"], 4);
        assert_eq!(p.advance(0, Some(1000)), None);
        assert_eq!(
            p.advance(1951, Some(1000)).unwrap(),
            json!({ "phase": "downloading", "downloaded": 2000, "total": 1000, "percent": 100 })
        );
        assert_eq!(
            p.installing(),
            json!({ "phase": "installing", "downloaded": 2000, "total": 1000, "percent": 100 })
        );
    }

    #[test]
    fn unknown_lengths_report_bytes_without_a_percentage() {
        for total in [None, Some(0)] {
            let mut p = Progress::default();
            assert_eq!(p.advance(10, total).unwrap()["percent"], Value::Null);
            assert_eq!(p.advance(65535, total), None);
            assert_eq!(p.advance(1, total).unwrap()["downloaded"], 65546);
        }
    }

    #[test]
    fn errors_distinguish_connectivity_from_an_unverified_release() {
        assert_eq!(
            friendly_message(&Error::ReleaseNotFound),
            "The update service could not be reached. Check your connection and try again."
        );
        for error in [
            Error::SignatureUtf8("signature contents".into()),
            Error::MissingSignedVersion,
            Error::SignedVersionMismatch {
                signed: "1.0.0".into(),
                announced: "2.0.0".into(),
            },
        ] {
            assert_eq!(
                friendly_message(&error),
                "PhotoCull could not verify the update signature. Please try again later."
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn failed_installer_launch_explains_how_to_restore_the_sidecar() {
        let error = Error::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        let message = install_error(&error);
        assert!(message.contains(&error.to_string()));
        assert!(message.contains("Restart PhotoCull before retrying"));
    }
}
