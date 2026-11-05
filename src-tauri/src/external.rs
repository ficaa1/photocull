//! Direct process launching and file-settle detection for external editors.
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub struct Editor {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    pub detect: String,
    pub multiple: bool,
}

pub fn arguments(template: &[String], files: &[PathBuf]) -> Result<Vec<String>, String> {
    if files.is_empty() { return Err("Choose hand-off files.".into()); }
    let mut args = Vec::new();
    let mut used = false;
    for arg in template {
        if arg == "{files}" {
            args.extend(files.iter().map(|f| f.to_string_lossy().into_owned())); used = true;
        } else {
            let value = arg.replace("{file}", &files[0].to_string_lossy());
            if arg.contains("{file}") { used = true; }
            // Validate the template, not expanded paths (which can contain braces).
            if arg.replace("{file}", "").contains(['{', '}']) || arg.contains('\0') { return Err("Invalid editor argument template.".into()); }
            args.push(value);
        }
    }
    if !used { return Err("Editor arguments need {file} or {files}.".into()); }
    Ok(args)
}

fn command(editor: &Editor, files: &[PathBuf]) -> Result<Command, String> {
    let path = Path::new(&editor.path);
    if !path.is_absolute() || editor.path.is_empty() { return Err("Browse to the editor application in Settings.".into()); }
    let args = arguments(&editor.args, files)?;
    #[cfg(target_os = "macos")]
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")) {
        if !path.join("Contents/Info.plist").is_file() { return Err("Application bundle does not exist.".into()); }
        // open waits for the launched application, including an existing instance. Arguments remain separate.
        let mut cmd = Command::new("/usr/bin/open");
        cmd.args(["-W", "-a"]).arg(path);
        let mut extra = Vec::new();
        for arg in &editor.args {
            if arg == "{files}" { cmd.args(files); }
            else if arg == "{file}" { cmd.arg(&files[0]); }
            else if arg.contains("{file}") { return Err("For application bundles use {file} as a separate argument.".into()); }
            else { extra.push(arg); }
        }
        if !extra.is_empty() { cmd.arg("--args").args(extra); }
        return Ok(cmd);
    }
    if !path.is_file() { return Err("Editor application does not exist. Set its path in Settings.".into()); }
    #[cfg(windows)]
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) { return Err("Choose an .exe editor application.".into()); }
    let mut cmd = Command::new(path);
    cmd.args(args);
    Ok(cmd)
}

type Stamp = (u64, Option<SystemTime>);
fn stamp(path: &Path) -> Option<Stamp> {
    let s = std::fs::symlink_metadata(path).ok()?;
    (s.is_file() && !s.file_type().is_symlink()).then(|| (s.len(), s.modified().ok()))
}

struct Settling { before: Stamp, last: Option<Stamp>, changed: Instant, reported: bool }
impl Settling {
    fn observe(&mut self, now: Option<Stamp>, time: Instant) -> bool {
        if self.last != now { self.last = now; self.changed = time; }
        if !self.reported && now.is_some_and(|s| s.0 > 0 && s != self.before) && time.duration_since(self.changed) >= Duration::from_millis(1000) {
            self.reported = true; return true;
        }
        false
    }
}
fn reap(mut child: Child) { std::thread::spawn(move || { let _ = child.wait(); }); }

pub fn run(editor: &Editor, files: &[PathBuf], cancel: &AtomicBool, mut saved: impl FnMut(usize)) -> Result<(), String> {
    if !["exit", "watch"].contains(&editor.detect.as_str()) { return Err("Invalid editor detection mode.".into()); }
    if !editor.multiple && files.len() != 1 { return Err("This editor accepts one photo at a time.".into()); }
    let mut states = files.iter().map(|p| {
        let before = stamp(p).ok_or("Hand-off file is unavailable.")?;
        Ok(Settling { before, last: Some(before), changed: Instant::now(), reported: false })
    }).collect::<Result<Vec<_>, String>>()?;
    let mut child = command(editor, files)?.spawn().map_err(|e| format!("Could not start {}: {e}", editor.name))?;
    loop {
        let status = child.try_wait().map_err(|e| e.to_string())?;
        let cancelled = cancel.load(Ordering::SeqCst);
        for (i, state) in states.iter_mut().enumerate() {
            let now = stamp(&files[i]);
            let changed = if editor.detect == "watch" { state.observe(now, Instant::now()) }
                else { (status.is_some() || cancelled) && now.is_some_and(|s| s.0 > 0 && s != state.before) };
            if changed { saved(i); state.reported = true; }
        }
        if cancelled {
            if editor.detect == "exit" && status.is_none() { child.kill().map_err(|e| e.to_string())?; let _ = child.wait(); }
            else if status.is_none() { reap(child); }
            // A final write can land during cancellation. Preserve attribution and cleanup warnings.
            for (i, state) in states.iter_mut().enumerate() {
                if !state.reported && stamp(&files[i]).is_some_and(|s| s.0 > 0 && s != state.before) { saved(i); state.reported = true; }
            }
            return Ok(());
        }
        if editor.detect == "watch" && states.iter().all(|s| s.reported) {
            if status.is_none() { reap(child); }
            return Ok(());
        }
        if let Some(status) = status {
            // A watch editor may exit during its final write: still require the settle interval.
            let pending = editor.detect == "watch" && states.iter().enumerate().any(|(i, s)| !s.reported && stamp(&files[i]).is_some_and(|now| now.0 > 0 && now != s.before));
            if !pending {
                if !status.success() && !states.iter().any(|s| s.reported) { return Err(format!("{} exited with {status}", editor.name)); }
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn templates_preserve_spaces_and_expand_multiple_files_without_a_shell() {
        let files = vec![PathBuf::from("C:/Photos/a b;$(x).tif"), PathBuf::from("C:/Photos/{second}.tif")];
        assert_eq!(arguments(&["--input={file}".into(), "{files}".into()], &files).unwrap(), vec!["--input=C:/Photos/a b;$(x).tif", "C:/Photos/a b;$(x).tif", "C:/Photos/{second}.tif"]);
        assert!(arguments(&["prefix{files}".into()], &files).is_err());
        assert!(arguments(&["{unknown}".into()], &files).is_err());
        assert!(arguments(&[], &files).is_err());
        assert!(arguments(&["{file}".into()], &[]).is_err());
    }
    #[test]
    fn detects_only_changed_nonempty_files_after_a_quiet_interval() {
        let time = Instant::now();
        let before = (10, Some(SystemTime::UNIX_EPOCH));
        let mut s = Settling { before, last: Some(before), changed: time, reported: false };
        assert!(!s.observe(Some(before), time + Duration::from_secs(2)));
        assert!(!s.observe(None, time + Duration::from_secs(3)));
        assert!(!s.observe(Some((20, None)), time + Duration::from_secs(4)));
        assert!(!s.observe(Some((25, None)), time + Duration::from_millis(4500)));
        assert!(!s.observe(Some((25, None)), time + Duration::from_secs(5)));
        assert!(s.observe(Some((25, None)), time + Duration::from_secs(6)));
        assert!(!s.observe(Some((25, None)), time + Duration::from_secs(7)));
    }
}
