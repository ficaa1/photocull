//! Size-capped local shell logs. No network sink or telemetry.
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FOLDER: OnceLock<Mutex<PathBuf>> = OnceLock::new();
const LIMIT: u64 = 1024 * 1024;

pub fn data_dir() -> PathBuf {
    if let Some(folder) = std::env::var_os("PHOTOCULL_DATA_DIR") { return PathBuf::from(folder); }
    #[cfg(windows)]
    { PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("PhotoCull") }
    #[cfg(target_os = "macos")]
    { PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/PhotoCull") }
    #[cfg(not(any(windows, target_os = "macos")))]
    { std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")).join("PhotoCull") }
}

pub fn init(folder: PathBuf) {
    let _ = std::fs::create_dir_all(&folder);
    let _ = FOLDER.set(Mutex::new(folder));
    write("PhotoCull shell started");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { write(&format!("panic: {info}")); previous(info); }));
}

pub fn write(message: &str) {
    let Some(folder) = FOLDER.get() else { return };
    let Ok(folder) = folder.lock() else { return };
    let file = folder.join("shell.log");
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let message: String = message.chars().take(32768).collect();
    let line = format!("{stamp} {message}\n");
    if std::fs::metadata(&file).map(|s| s.len() + line.len() as u64 > LIMIT).unwrap_or(false) {
        let _ = std::fs::remove_file(folder.join("shell.log.3"));
        for n in (1..3).rev() { let _ = std::fs::rename(folder.join(format!("shell.log.{n}")), folder.join(format!("shell.log.{}", n+1))); }
        let _ = std::fs::rename(&file, folder.join("shell.log.1"));
    }
    if let Ok(mut out) = std::fs::OpenOptions::new().append(true).create(true).open(file) {
        let _ = out.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn capped_local_log_rotates() {
        let folder = std::env::temp_dir().join(format!("photocull-shell-log-{}", std::process::id()));
        super::init(folder.clone());
        std::fs::write(folder.join("shell.log"), vec![b'x'; super::LIMIT as usize]).unwrap();
        super::write("after rotation");
        assert!(folder.join("shell.log.1").exists());
        assert!(std::fs::metadata(folder.join("shell.log")).unwrap().len() < 1024);
        let _ = std::fs::remove_dir_all(folder);
    }
}
