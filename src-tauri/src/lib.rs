//! PhotoCull's Tauri shell: the window, native dialogs, fullscreen, menus and
//! deletion. Photo work (scanning, previews, decisions, copying) happens in the
//! Node backend; see backend.rs.

mod backend;
mod develop;

use backend::Backend;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Backend methods the renderer may call directly. Deletion and the manifest
/// go through `delete_photos` and `save_manifest`, so the renderer never names
/// a file to remove or overwrite.
const RENDERER_METHODS: &[&str] = &[
    "scan", "devices", "open-device", "test-destination", "copy-picks", "naming-preview", "cancel-copy", "decide", "decide-many",
    "history", "metadata", "preview-status", "settings", "save-preset", "delete-preset", "settings-folder",
    "preview-settings", "preview-cache", "clear-preview-cache", "retry-preview", "focus", "visible", "export-xmp", "session-folder", "stats",
    "recipes", "save-recipe", "delete-recipe", "develop-get", "develop-set", "develop-folder", "develop-folder-check", "develop-plan", "make-folder", "export-plan",
];

#[tauri::command]
async fn backend(state: State<'_, Backend>, method: String, params: Vec<Value>) -> Result<Value, String> {
    if !RENDERER_METHODS.contains(&method.as_str()) { return Err(format!("Unknown request: {method}")); }
    state.call(&method, Value::Array(params)).await
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow, title: String) -> Option<String> {
    window.dialog().file().set_parent(&window).set_title(title).blocking_pick_folder()
        .and_then(|path| path.into_path().ok()).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_save_file(window: WebviewWindow, default_name: String, filter_name: String, extension: String) -> Option<String> {
    window.dialog().file().set_parent(&window).set_file_name(default_name).add_filter(filter_name, &[extension.as_str()])
        .blocking_save_file().and_then(|path| path.into_path().ok()).map(|path| path.to_string_lossy().into_owned())
}

/// Opens a folder in the system file manager. Only directories, so the
/// renderer cannot use this to launch programs.
#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    if !PathBuf::from(&path).is_dir() { return Err("That folder no longer exists.".into()); }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

static FULLSCREEN: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, value: bool) -> Result<Value, String> {
    window.set_fullscreen(value).map_err(|e| e.to_string())?;
    let actual = window.is_fullscreen().unwrap_or(value);
    FULLSCREEN.store(actual, Ordering::Relaxed);
    Ok(json!({ "fullscreen": actual }))
}

/// Saves the decisions manifest to a file the user picks in a native dialog.
#[tauri::command]
async fn save_manifest(window: WebviewWindow, state: State<'_, Backend>, session: String) -> Result<Option<String>, String> {
    let file = window.dialog().file().set_parent(&window).set_file_name("photocull-decisions.json")
        .add_filter("PhotoCull decisions", &["json"]).blocking_save_file().and_then(|path| path.into_path().ok());
    let Some(file) = file else { return Ok(None) };
    let value = state.call("write-manifest", json!([session, file.to_string_lossy()])).await?;
    Ok(value.as_str().map(String::from))
}

#[derive(Serialize, serde::Deserialize)]
struct Failure { name: String, reason: String }

#[derive(Serialize)]
struct Deleted { deleted: Vec<String>, failures: Vec<Failure>, warning: Option<String> }

/// Deletes whole photos: the image, then its companion JPEG. If the image
/// cannot be removed the companion is left alone. XMP sidecars go last, and
/// only once every photo sharing one is gone. The backend checks each file
/// against the scan and skips any that changed. Camera cards have no trash
/// (Windows would silently delete permanently), so trashing there is refused.
#[tauri::command]
async fn delete_photos(state: State<'_, Backend>, session: String, ids: Vec<String>, mode: String) -> Result<Deleted, String> {
    let trash = match mode.as_str() { "trash" => true, "permanent" => false, _ => return Err("Invalid delete mode.".into()) };
    // deletion-plan locks out copying until deletion-end.
    let plan = state.call("deletion-plan", json!([session, ids])).await?;
    let result = remove_planned(&state, &session, plan, trash).await;
    let _ = state.call("deletion-end", json!([])).await;
    result
}

async fn remove_planned(state: &Backend, session: &str, plan: Value, trash: bool) -> Result<Deleted, String> {
    if trash && plan["removable"].as_bool() == Some(true) {
        return Err("Camera cards have no Trash. Choose Delete permanently.".into());
    }
    let strings = |value: &Value| -> Vec<String> { value.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect() };
    let photos: Vec<(String, String, Vec<String>)> = plan["photos"].as_array().into_iter().flatten().map(|photo| (
        photo["id"].as_str().unwrap_or_default().to_string(), photo["name"].as_str().unwrap_or_default().to_string(), strings(&photo["files"]),
    )).collect();
    let sidecars: Vec<(String, Vec<String>)> = plan["sidecars"].as_array().into_iter().flatten()
        .map(|sidecar| (sidecar["file"].as_str().unwrap_or_default().to_string(), strings(&sidecar["owners"]))).collect();
    let skipped: Vec<Failure> = serde_json::from_value(plan["skipped"].clone()).unwrap_or_default();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let remove = |file: &str| -> Result<(), String> {
            if trash { trash::delete(file).map_err(|e| e.to_string()) } else { std::fs::remove_file(file).map_err(|e| e.to_string()) }
        };
        let name_of = |file: &str| PathBuf::from(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut out = Deleted { deleted: vec![], failures: skipped, warning: None };
        for (id, name, files) in photos {
            let Some((main, rest)) = files.split_first() else { continue };
            if let Err(reason) = remove(main) { out.failures.push(Failure { name, reason }); continue; }
            out.deleted.push(id);
            for file in rest {
                if let Err(reason) = remove(file) { out.failures.push(Failure { name: name_of(file), reason }); }
            }
        }
        let gone: std::collections::HashSet<&String> = out.deleted.iter().collect();
        let mut failures = vec![];
        for (file, owners) in sidecars {
            if !owners.iter().all(|id| gone.contains(id)) { continue; }
            if let Err(reason) = remove(&file) { failures.push(Failure { name: name_of(&file), reason }); }
        }
        out.failures.extend(failures);
        out
    }).await.map_err(|e| e.to_string())?;
    // Files already removed must reach the renderer even if saving the session fails.
    if !result.deleted.is_empty() {
        if let Err(error) = state.call("forget", json!([session, result.deleted])).await {
            result.warning = Some(format!("Deleted, but PhotoCull could not save the session: {error}"));
        }
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // Undo/Redo are custom items: the predefined ones would swallow Cmd+Z
    // before the renderer could undo a culling decision.
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let item = |id: &str, label: &str, accelerator: &str| MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app);
    let app_menu = SubmenuBuilder::new(app, "PhotoCull")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .item(&item("settings", "Settings…", "Cmd+,")?).separator()
        .item(&PredefinedMenuItem::services(app, None)?).separator()
        .item(&PredefinedMenuItem::hide(app, None)?).item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?).separator()
        .item(&PredefinedMenuItem::quit(app, None)?).build()?;
    let file = SubmenuBuilder::new(app, "File").item(&item("open-folder", "Open folder…", "CmdOrCtrl+O")?)
        .item(&PredefinedMenuItem::close_window(app, None)?).build()?;
    let edit = SubmenuBuilder::new(app, "Edit").item(&item("undo", "Undo", "CmdOrCtrl+Z")?).item(&item("redo", "Redo", "Shift+CmdOrCtrl+Z")?)
        .separator().item(&PredefinedMenuItem::cut(app, None)?).item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?).item(&PredefinedMenuItem::select_all(app, None)?).build()?;
    let view = SubmenuBuilder::new(app, "View").item(&item("fullscreen", "Fullscreen", "Ctrl+Cmd+F")?).build()?;
    let window = SubmenuBuilder::new(app, "Window").item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?).build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let info = app.state::<Backend>().info.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("PhotoCull").inner_size(1440.0, 960.0).min_inner_size(1024.0, 700.0)
        .background_color(tauri::window::Color(0x12, 0x16, 0x14, 0xff))
        .initialization_script(format!("window.__PHOTOCULL__ = {info};"))
        .build()?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(_) = event {
            let now = handle.is_fullscreen().unwrap_or(false);
            if FULLSCREEN.swap(now, Ordering::Relaxed) != now { let _ = handle.emit("fullscreen-changed", json!({ "fullscreen": now })); }
        }
    });
    Ok(window)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend, pick_folder, pick_save_file, open_folder, set_fullscreen, delete_photos, save_manifest,
            develop::develop_result, develop::reveal_develop, develop::develop_info, develop::develop_render, develop::develop_tiffs, develop::develop_cancel, develop::dehancer_edit,
            develop::export_photos, develop::lens_database, develop::download_lens_database])
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = match Backend::spawn(&handle) {
                Ok(backend) => backend,
                Err(message) => {
                    // setup() runs on the main thread, where a blocking dialog
                    // would wait on itself; show it and quit once it is dismissed.
                    eprintln!("{message}");
                    let exit = handle.clone();
                    handle.dialog().message(message).title("PhotoCull could not start")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error).show(move |_| exit.exit(1));
                    return Ok(());
                }
            };
            app.manage(backend);
            let data_dir = handle.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("PhotoCull"));
            app.manage(std::sync::Arc::new(develop::Engine::new(data_dir)));
            #[cfg(target_os = "macos")]
            {
                app.set_menu(mac_menu(&handle)?)?;
                app.on_menu_event(|app, event| {
                    let _ = match event.id().as_ref() {
                        "open-folder" => app.emit("open-folder-shortcut", ()),
                        "settings" => app.emit("settings-shortcut", ()),
                        "undo" => app.emit("edit-shortcut", "undo"),
                        "redo" => app.emit("edit-shortcut", "redo"),
                        "fullscreen" => app.emit("fullscreen-toggle", ()),
                        _ => Ok(()),
                    };
                });
            }
            create_window(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PhotoCull");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(backend) = app.try_state::<Backend>() { backend.shutdown(); }
        }
    });
}
