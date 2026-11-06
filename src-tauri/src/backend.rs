//! The Node backend (src/backend.cjs) runs as a child process. Requests and
//! replies are JSON lines on its stdin/stdout; lines carrying `event` are
//! re-emitted to the window as Tauri events.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

pub struct Backend {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    next_id: AtomicU64,
    /// `{ port, token, platform }` from the backend's ready line.
    pub info: Value,
}

/// Where the Node runtime and backend script live. Release bundles ship both
/// (the runtime as a Tauri sidecar next to the executable, the script as a
/// resource); development builds use `node` from PATH and the repo's `src/`.
fn locate(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let node = std::env::var_os("PHOTOCULL_NODE")
        .map(PathBuf::from)
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            let bundled = exe
                .parent()?
                .join(format!("node{}", std::env::consts::EXE_SUFFIX));
            bundled.is_file().then_some(bundled)
        })
        .unwrap_or_else(|| PathBuf::from("node"));
    let script = std::env::var_os("PHOTOCULL_BACKEND")
        .map(PathBuf::from)
        .or_else(|| {
            let bundled = app
                .path()
                .resource_dir()
                .ok()?
                .join("backend")
                .join("src")
                .join("backend.cjs");
            bundled.is_file().then_some(bundled)
        })
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("src")
                .join("backend.cjs")
        });
    Ok((node, script))
}

impl Backend {
    pub fn spawn(app: &AppHandle) -> Result<Backend, String> {
        let (node, script) = locate(app)?;
        let mut command = Command::new(&node);
        // Node rejects Windows verbatim (\\?\) paths for its entry script.
        command
            .arg(dunce::simplified(&script))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| {
            format!(
                "Could not start the PhotoCull backend ({}): {e}",
                node.display()
            )
        })?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Backend has no stdout")?;
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = Arc::default();

        let (ready_tx, ready_rx) = mpsc::channel::<Value>();
        let reader_pending = pending.clone();
        let handle = app.clone();
        std::thread::spawn(move || {
            let mut ready = Some(ready_tx);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(info) = message.get("ready") {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(info.clone());
                    }
                } else if let Some(event) = message.get("event").and_then(Value::as_str) {
                    let _ = handle.emit(
                        event,
                        message.get("payload").cloned().unwrap_or(Value::Null),
                    );
                } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    let reply = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(message.get("value").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(message
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Backend request failed.")
                            .to_string())
                    };
                    if let Some(tx) = reader_pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(reply);
                    }
                }
            }
            crate::logs::write("PhotoCull backend stream closed");
            // The backend exited: fail whatever is still waiting.
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(Err("PhotoCull's backend stopped. Restart the app.".into()));
            }
        });

        let info = ready_rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| {
                let _ = child.kill();
                format!(
                    "The PhotoCull backend did not start ({} {}).",
                    node.display(),
                    script.display()
                )
            })?;
        Ok(Backend {
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pending,
            next_id: AtomicU64::new(1),
            info,
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
        let written = match self.stdin.lock().unwrap().as_mut() {
            Some(stdin) => stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .is_ok(),
            None => false,
        };
        if !written {
            self.pending.lock().unwrap().remove(&id);
            return Err("PhotoCull's backend is not running.".into());
        }
        rx.await
            .unwrap_or_else(|_| Err("PhotoCull's backend stopped.".into()))
    }

    /// Closing stdin asks the backend to flush pending decision and settings
    /// writes and exit; it is killed if that takes too long.
    pub fn shutdown(&self) {
        self.stdin.lock().unwrap().take();
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
