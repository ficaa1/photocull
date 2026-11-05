//! RAW development with Lightcraft's engine (https://github.com/storytold/lightcraft, MIT OR Apache-2.0):
//! live previews with histograms, hand-off files for external editors, and exports.
//!
//! The renderer never names a photo's file: photos are addressed by session and id, and the Node backend
//! (`develop-context`) says which file that is, the same way deletion works.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Instant, SystemTime};

use lightcraft_develop::{DevelopSettings, EmbeddedLens, WbMode, WbScale};
use lightcraft_engine::export::{encode_rendered, ExportFormat, ExportOptions, OutputDepth, OutputSpace};
use lightcraft_lensdb::LensDb;
use lightcraft_pipeline::{RenderRequest, SourceInfo, StageCache};
use lightcraft_raster::{Rgb32f, Rgba8};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::backend::Backend;

/// Preview sizes: a quick one while a slider moves, a sharper one once it settles.
const DRAFT_EDGE: usize = 1600;
const SETTLED_EDGE: usize = 2560;
/// Photos whose decoded preview sources stay in memory (about 50–100 MB each).
const KEEP_OPEN: usize = 3;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Engine {
    photos: Mutex<Vec<Arc<Photo>>>,
    lens_dir: PathBuf,
    lens_db: Mutex<Option<Arc<LensDb>>>,
    lens_downloading: AtomicBool,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
}

/// A photo opened for development: its bytes, lens correction and decoded preview sources.
struct Photo {
    file: PathBuf,
    stamp: (u64, Option<SystemTime>),
    bytes: Arc<Vec<u8>>,
    lens: Option<EmbeddedLens>,
    lens_name: Option<String>,
    camera: String,
    lens_model: String,
    full_size: (usize, usize),
    lens_db_generation: usize,
    levels: Mutex<HashMap<usize, Arc<Level>>>,
}

struct Level {
    src: Arc<Rgb32f>,
    info: SourceInfo,
    cache: StageCache,
}

/// What the Node backend knows about a photo (`develop-context`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    file: String,
    name: String,
    raw: bool,
    tiff: Option<String>,
    edited_by: Option<String>,
    handoff_stamp: Option<Value>,
}

fn stamp(path: &Path) -> Result<(u64, Option<SystemTime>), String> {
    let m = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((m.len(), m.modified().ok()))
}

impl Photo {
    fn open(file: PathBuf, db: Option<&LensDb>, generation: usize) -> Result<Photo, String> {
        let stamp = stamp(&file)?;
        let bytes = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let raw = lightcraft_raw::probe_info(&bytes).map_err(|e| format!("This RAW file could not be read: {e}"))?;
        let meta = lightcraft_meta::extract(&bytes);
        let camera = format!("{} {}", meta.make.clone().unwrap_or_default(), meta.model.clone().unwrap_or_default()).trim().to_string();
        let lens_model = meta.lens_model.clone().unwrap_or_default();
        let (w, h) = raw.developed_size();
        let (lens, lens_name) = match lightcraft_engine::files::embedded_lens(&raw) {
            Some(lens) => (Some(lens), Some("Correction embedded in the file".to_string())),
            None => match db {
                Some(db) => (
                    lightcraft_engine::lens_profiles::lookup(db, &meta, w as f64, h as f64, raw.orientation),
                    lightcraft_engine::lens_profiles::profile_name(db, &camera, &lens_model),
                ),
                None => (None, None),
            },
        };
        Ok(Photo {
            file,
            stamp,
            bytes: Arc::new(bytes),
            lens,
            lens_name,
            camera,
            lens_model,
            full_size: (w, h),
            lens_db_generation: generation,
            levels: Mutex::default(),
        })
    }

    /// The decoded source fitted to `edge`, built once per photo and size. `usize::MAX` is full resolution,
    /// which is never kept (about 400 MB).
    fn source(&self, edge: usize) -> Result<(Arc<Rgb32f>, SourceInfo), String> {
        let (src, mut info) = lightcraft_engine::files::load_bytes(&self.bytes, edge)?;
        info.lens = self.lens;
        info.native_long = Some(self.full_size.0.max(self.full_size.1));
        Ok((Arc::new(src), info))
    }

    fn level(&self, edge: usize) -> Result<Arc<Level>, String> {
        let mut levels = lock(&self.levels);
        if let Some(level) = levels.get(&edge) {
            return Ok(level.clone());
        }
        let (src, info) = self.source(edge)?;
        let level = Arc::new(Level { src, info, cache: StageCache::default() });
        levels.insert(edge, level.clone());
        Ok(level)
    }
}

/// PhotoCull's starting point for a raw: Lightcraft's raw defaults with sharpening and noise reduction off
/// (Dehancer's guide asks for neither) and the lens profile on.
fn base_settings(info: &SourceInfo) -> DevelopSettings {
    let mut s = DevelopSettings::for_raw(info.as_shot_temp, info.as_shot_tint);
    s.detail.sharpen_amount = 0.0;
    s.detail.nr_color = 0.0;
    s.detail.nr_luminance = 0.0;
    s.detail.nr_outliers = false;
    s.optics.lens_profile = true;
    s
}

fn merge(into: &mut Value, patch: &Value) {
    match (into, patch) {
        (Value::Object(into), Value::Object(patch)) => {
            for (key, value) in patch {
                merge(into.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (_, Value::Null) => {}
        (into, patch) => *into = patch.clone(),
    }
}

/// Develop settings for a photo: the base settings with the recipe's (partial, Lightcraft-shaped) settings on top.
fn settings_for(info: &SourceInfo, patch: &Value) -> Result<DevelopSettings, String> {
    let mut value = serde_json::to_value(base_settings(info)).map_err(|e| e.to_string())?;
    merge(&mut value, patch);
    let mut s: DevelopSettings = serde_json::from_value(value).map_err(|e| format!("Invalid develop settings: {e}"))?;
    if s.wb.mode == WbMode::Custom {
        s.wb.scale = WbScale::Kelvin;
    }
    lightcraft_pipeline::local::normalize_wb(&mut s, info);
    Ok(s)
}

fn output_space(name: &str) -> OutputSpace {
    match name {
        "displayP3" | "p3" => OutputSpace::DisplayP3,
        "adobeRgb" | "adobergb" => OutputSpace::AdobeRgb,
        "proPhoto" | "prophoto" => OutputSpace::ProPhoto,
        "rec2020" => OutputSpace::Rec2020,
        _ => OutputSpace::Srgb,
    }
}

fn encode_frame(img: &Rgba8) -> Result<Vec<u8>, String> {
    // Preview pixels are sRGB, like the histogram. The webview/OS owns the
    // display transform; embedding the source space also makes this explicit
    // for WKWebView and WebView2 without changing any export encoding.
    static SRGB: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let icc = SRGB.get_or_init(|| lightcraft_codecs::icc::write_named(lightcraft_codecs::NamedSpace::Srgb));
    let e = lightcraft_codecs::EncodeImage::rgba8(img);
    let meta = lightcraft_codecs::EncodeMeta { icc: Some(icc), ..Default::default() };
    lightcraft_codecs::encode_jpeg(&e, 88, lightcraft_codecs::ChromaSubsampling::S420, &meta).map_err(|e| e.to_string())
}

/// One binary reply: a little-endian u32 header length, the JSON header, then the JPEG frame.
fn pack(header: &Value, jpeg: Vec<u8>) -> Vec<u8> {
    let header = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + header.len() + jpeg.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&jpeg);
    out
}

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1e4).round() / 10.0
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

impl Engine {
    pub fn new(data_dir: PathBuf) -> Engine {
        Engine {
            photos: Mutex::default(),
            lens_dir: data_dir.join("lensfun"),
            lens_db: Mutex::default(),
            lens_downloading: AtomicBool::new(false),
            cancel: Arc::default(),
            busy: AtomicBool::new(false),
        }
    }

    fn lens_db(&self) -> (Option<Arc<LensDb>>, usize) {
        let mut db = lock(&self.lens_db);
        if db.is_none() && lightcraft_engine::lensfun_download::installed(&self.lens_dir) {
            match LensDb::load_dir(&self.lens_dir) {
                Ok((loaded, _)) => *db = Some(Arc::new(loaded)),
                Err(e) => { crate::logs::write(&format!("lens database: {e}")); eprintln!("lens database: {e}"); },
            }
        }
        let generation = db.as_ref().map_or(0, |d| Arc::as_ptr(d) as usize);
        (db.clone(), generation)
    }

    async fn context(backend: &Backend, session: &str, id: &str) -> Result<Context, String> {
        let value = backend.call("develop-context", json!([session, id])).await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// The opened photo for this file, reusing the decoded one while the file and lens database are unchanged.
    fn photo(self: &Arc<Self>, file: &Path) -> Result<Arc<Photo>, String> {
        let (db, generation) = self.lens_db();
        let current = stamp(file)?;
        {
            let mut photos = lock(&self.photos);
            if let Some(i) = photos.iter().position(|p| p.file == file && p.stamp == current && p.lens_db_generation == generation) {
                let photo = photos.remove(i);
                photos.insert(0, photo.clone());
                return Ok(photo);
            }
        }
        let photo = Arc::new(Photo::open(file.to_path_buf(), db.as_deref(), generation)?);
        let mut photos = lock(&self.photos);
        photos.retain(|p| p.file != file);
        photos.insert(0, photo.clone());
        photos.truncate(KEEP_OPEN);
        Ok(photo)
    }
}

/// Opens a raw for development: sizes, as-shot white balance, lens correction and the base settings.
#[tauri::command]
pub async fn develop_info(engine: State<'_, Arc<Engine>>, backend: State<'_, Backend>, session: String, id: String) -> Result<Value, String> {
    let ctx = Engine::context(&backend, &session, &id).await?;
    if !ctx.raw {
        return Err("Only RAW files can be developed.".into());
    }
    let engine = engine.inner().clone();
    blocking(move || {
        let photo = engine.photo(Path::new(&ctx.file))?;
        let level = photo.level(DRAFT_EDGE)?;
        let base = serde_json::to_value(base_settings(&level.info)).map_err(|e| e.to_string())?;
        Ok(json!({
            "name": ctx.name,
            "width": photo.full_size.0, "height": photo.full_size.1,
            "camera": photo.camera, "lens": photo.lens_model,
            "lensProfile": photo.lens_name, "lensCorrection": photo.lens.is_some(),
            "lensDatabase": engine.lens_db().0.is_some(),
            "asShot": { "temp": level.info.as_shot_temp, "tint": level.info.as_shot_tint },
            "base": base,
            "tiff": ctx.tiff,
        }))
    })
    .await
}

/// Renders a preview with `settings` (partial Lightcraft develop settings) and returns
/// `[u32 header length][JSON header with size, histogram and timing][JPEG]`.
#[tauri::command]
pub async fn develop_render(
    engine: State<'_, Arc<Engine>>,
    backend: State<'_, Backend>,
    session: String,
    id: String,
    settings: Value,
    settled: bool,
) -> Result<Response, String> {
    let ctx = Engine::context(&backend, &session, &id).await?;
    let engine = engine.inner().clone();
    blocking(move || {
        let photo = engine.photo(Path::new(&ctx.file))?;
        let edge = if settled { SETTLED_EDGE } else { DRAFT_EDGE };
        let t = Instant::now();
        let level = photo.level(edge)?;
        let load_ms = ms(t);
        let s = settings_for(&level.info, &settings)?;
        let t = Instant::now();
        let r = lightcraft_pipeline::render_cached(&level.src, &level.info, &s, &RenderRequest::fit(edge, edge), &level.cache);
        let render_ms = ms(t);
        let frame = encode_frame(&r.image)?;
        let header = json!({
            "width": r.image.width, "height": r.image.height, "edge": edge,
            "loadMs": load_ms, "renderMs": render_ms,
            "histogram": serde_json::to_value(&r.histogram).unwrap_or(Value::Null),
        });
        Ok(Response::new(pack(&header, frame)))
    })
    .await
}

fn known_handoff(tiff: Option<&str>) -> Result<PathBuf, String> {
    let path = PathBuf::from(tiff.ok_or("Develop a hand-off file for this photo first.")?);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !path.is_absolute() || !meta.is_file() || meta.file_type().is_symlink() || !path.extension().is_some_and(|s| s.eq_ignore_ascii_case("tif") || s.eq_ignore_ascii_case("tiff") || s.eq_ignore_ascii_case("png") || s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg")) {
        return Err("This photo has no regular hand-off image.".into());
    }
    Ok(path)
}

fn finished_preview(bytes: &[u8], edge: usize) -> Result<Rgba8, String> {
    let decoded = lightcraft_codecs::decode(bytes, Default::default()).map_err(|e| e.to_string())?;
    let orientation = lightcraft_geom::Orientation::from_exif(decoded.orientation);
    let img = decoded.to_srgb8().into_oriented(orientation);
    let scale = (edge as f64 / img.width.max(img.height) as f64).min(1.0);
    Ok(resize_rgba(&img, (img.width as f64 * scale).round().max(1.0) as usize, (img.height as f64 * scale).round().max(1.0) as usize))
}

/// Finished TIFF pixels, without applying the RAW develop settings a second time.
#[tauri::command]
pub async fn develop_result(backend: State<'_, Backend>, session: String, id: String) -> Result<Response, String> {
    let ctx = Engine::context(&backend, &session, &id).await?;
    blocking(move || {
        let path = known_handoff(ctx.tiff.as_deref())?;
        let t = Instant::now();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let img = finished_preview(&bytes, SETTLED_EDGE)?;
        let header = json!({"width": img.width, "height": img.height, "loadMs": ms(t), "renderMs": 0, "histogram": null});
        Ok(Response::new(pack(&header, encode_frame(&img)?)))
    }).await
}

#[tauri::command]
pub async fn reveal_develop(app: AppHandle, backend: State<'_, Backend>, session: String, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let ctx = Engine::context(&backend, &session, &id).await?;
    let path = known_handoff(ctx.tiff.as_deref())?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct TiffItem {
    id: String,
    settings: Value,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TiffOptions {
    format: Option<String>,
    compression: Option<String>,
    jpeg_quality: Option<u8>,
    color_space: String,
    bit_depth: Option<u8>,
    /// Explicit consent to replace only this photo's own TIFF (including its external edit).
    replace: bool,
}

fn emit_progress(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

/// Busy flag for the batch jobs, so only one runs at a time.
struct Busy<'a>(&'a AtomicBool);
impl<'a> Busy<'a> {
    fn take(flag: &'a AtomicBool) -> Result<Busy<'a>, String> {
        if flag.swap(true, Ordering::SeqCst) {
            return Err("PhotoCull is already developing or exporting photos.".into());
        }
        Ok(Busy(flag))
    }
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn render_full(photo: &Photo, settings: &Value, space: OutputSpace, depth: OutputDepth, size: Option<(usize, usize)>) -> Result<lightcraft_pipeline::Rendered, String> {
    let (src, info) = photo.source(usize::MAX)?;
    let s = settings_for(&info, settings)?;
    let (w, h) = size.unwrap_or((src.width, src.height));
    let mut req = RenderRequest::fit(w, h);
    req.space = space;
    req.depth = depth;
    Ok(lightcraft_pipeline::render(&src, &info, &s, &req))
}

fn photo_metadata(photo: &Photo) -> lightcraft_meta::Metadata {
    let mut meta = lightcraft_meta::extract(&photo.bytes);
    meta.software = Some(format!("PhotoCull {}", env!("CARGO_PKG_VERSION")));
    // the pixels are written upright
    meta.orientation = Some(lightcraft_geom::Orientation::Normal);
    meta
}

/// Develops photos to TIFFs in `folder` (named after the RAW) for an external editor. Existing TIFFs are kept
/// unless `replace`: they may already hold external edits. Unrelated TIFFs always get unique names.
#[tauri::command]
pub async fn develop_tiffs(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    backend: State<'_, Backend>,
    session: String,
    folder: String,
    items: Vec<TiffItem>,
    options: TiffOptions,
) -> Result<Value, String> {
    let format = match options.format.as_deref().unwrap_or("tiff") {
        "tiff" => ExportFormat::Tiff, "png" => ExportFormat::Png, "jpeg" => ExportFormat::Jpeg,
        _ => return Err("Invalid hand-off format.".into()),
    };
    let depth = options.bit_depth.unwrap_or(16);
    if ![8, 16].contains(&depth) || format == ExportFormat::Jpeg && depth != 8 || options.jpeg_quality.is_some_and(|q| !(1..=100).contains(&q)) { return Err("Invalid hand-off depth or quality.".into()); }
    let compression = match options.compression.as_deref().unwrap_or("none") {
        "none" => lightcraft_codecs::TiffCompression::None, "lzw" => lightcraft_codecs::TiffCompression::Lzw, "deflate" => lightcraft_codecs::TiffCompression::Deflate,
        _ => return Err("Invalid hand-off compression.".into()),
    };
    let folder = PathBuf::from(folder);
    if !folder.is_dir() {
        return Err("That folder does not exist.".into());
    }
    let plan = backend.call("develop-plan", json!([session, items.iter().map(|i| &i.id).collect::<Vec<_>>(), folder.to_string_lossy(), format.extension()])).await?;
    let mut jobs = Vec::new();
    for item in items {
        let ctx = Engine::context(&backend, &session, &item.id).await?;
        let row = plan.as_array().and_then(|rows| rows.iter().find(|r| r["id"].as_str() == Some(item.id.as_str()))).cloned().ok_or("Missing TIFF destination.")?;
        jobs.push((item, ctx, row));
    }
    let busy_engine = engine.inner().clone();
    let _busy = Busy::take(&busy_engine.busy)?;
    let ids: Vec<_> = jobs.iter().map(|(item, _, _)| item.id.clone()).collect();
    backend.call("handoff-prepare", json!([session, ids])).await?;
    let engine_ref = engine.inner().clone();
    let total = jobs.len();
    let results = blocking(move || {
        let engine = engine_ref;
        engine.cancel.store(false, Ordering::SeqCst);
        let space = output_space(&options.color_space);
        let depth = options.bit_depth.unwrap_or(16);
        let mut results = Vec::new();
        for (i, (item, ctx, row)) in jobs.into_iter().enumerate() {
            if engine.cancel.load(Ordering::SeqCst) {
                results.push(json!({ "id": item.id, "status": "cancelled" }));
                continue;
            }
            emit_progress(&app, "develop-progress", json!({ "done": i, "total": total, "name": ctx.name }));
            let out = PathBuf::from(row["tiff"].as_str().unwrap_or_default());
            let t = Instant::now();
            let result = (|| -> Result<&'static str, String> {
                if !ctx.raw {
                    return Err("Only RAW files can be developed.".into());
                }
                if let Some(error) = row["error"].as_str() { return Err(error.into()); }
                let own = row["own"].as_bool() == Some(true);
                if let Ok(existing) = std::fs::symlink_metadata(&out) {
                    if !own { return Err("A TIFF appeared at this destination. Send again to choose a unique name.".into()); }
                    if !existing.is_file() || existing.file_type().is_symlink() { return Err("Destination is not a regular file.".into()); }
                    if !options.replace { return Ok("exists"); }
                }
                let photo = engine.photo(Path::new(&ctx.file))?;
                let r = render_full(&photo, &item.settings, space, if depth == 16 { OutputDepth::U16 } else { OutputDepth::U8 }, None)?;
                let o = ExportOptions {
                    format,
                    quality: options.jpeg_quality.unwrap_or(90),
                    bit_depth: Some(depth),
                    color_space: space,
                    tiff_compression: compression,
                    ..Default::default()
                };
                let bytes = encode_rendered(&r, &o, Some(&photo_metadata(&photo)))?;
                let partial = out.with_extension(format!("{}.partial", format.extension()));
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&partial).map_err(|e| format!("{}: {e}", partial.display()))?;
                let write = file.write_all(&bytes).and_then(|_| file.sync_all());
                drop(file);
                let published = write.map_err(|e| e.to_string()).and_then(|_| publish_export(&partial, &out, own && options.replace));
                if published.is_err() { let _ = std::fs::remove_file(&partial); }
                published?;
                Ok("developed")
            })();
            results.push(match result {
                Ok(status) => json!({ "id": item.id, "status": status, "tiff": out.to_string_lossy(), "ms": ms(t) }),
                Err(error) => json!({ "id": item.id, "status": "failed", "error": error }),
            });
        }
        emit_progress(&app, "develop-progress", json!({ "done": total, "total": total }));
        Ok(results)
    })
    .await;
    let released = backend.call("handoff-release", json!([session, ids])).await;
    let results = results?;
    released?;
    for r in &results {
        if let (Some(id), Some(tiff)) = (r["id"].as_str(), r["tiff"].as_str()) {
            // Reopening a recorded file does not change its edit/export status or canonical cleanup path.
            if r["status"] == "exists" {
                let previous = backend.call("develop-get", json!([session, id])).await?;
                if previous["tiff"].as_str() == Some(tiff) { continue; }
            }
            backend.call("develop-mark", json!([session, id, { "tiff": tiff }])).await?;
        }
    }
    Ok(json!({ "results": results }))
}

#[tauri::command]
pub fn develop_cancel(engine: State<'_, Arc<Engine>>) {
    engine.cancel.store(true, Ordering::SeqCst);
}

/// Serialize cleanup with rendering, export and external-edit jobs.
#[tauri::command]
pub async fn clean_handoffs(engine: State<'_, Arc<Engine>>, backend: State<'_, Backend>, session: String, token: String, allow_unexported: bool) -> Result<Value, String> {
    let _busy = Busy::take(&engine.busy)?;
    backend.call("handoff-clean", json!([session, token, allow_unexported])).await
}

/// Launch only a saved editor, and mark each hand-off when its change is detected.
#[tauri::command]
pub async fn edit_external(engine: State<'_, Arc<Engine>>, backend: State<'_, Backend>, session: String, ids: Vec<String>, editor_id: String) -> Result<Value, String> {
    let editor: crate::external::Editor = serde_json::from_value(backend.call("editor-context", json!([editor_id])).await?).map_err(|e| e.to_string())?;
    if ids.is_empty() || ids.len() > 100_000 { return Err("Choose photos to edit.".into()); }
    let mut files = Vec::new();
    for id in &ids { files.push(known_handoff(Engine::context(&backend, &session, id).await?.tiff.as_deref())?); }
    let engine = engine.inner().clone();
    let _busy = Busy::take(&engine.busy)?;
    engine.cancel.store(false, Ordering::SeqCst);
    let cancel = engine.cancel.clone();
    backend.call("handoff-prepare", json!([session, ids])).await?;
    let editor_id = editor.id.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tauri::async_runtime::spawn_blocking(move || crate::external::run(&editor, &files, &cancel, |index| { let _ = tx.send(index); }));
    let mut edited = Vec::new();
    let mut error = None;
    while let Some(index) = rx.recv().await {
        let id = &ids[index];
        match backend.call("develop-mark", json!([session, id, { "editedBy": editor_id }])).await {
            Ok(_) => edited.push(id.clone()), Err(e) => error = Some(e),
        }
    }
    let result = task.await.map_err(|e| e.to_string());
    backend.call("handoff-release", json!([session, ids])).await?;
    result??;
    if let Some(e) = error { return Err(e); }
    Ok(json!({ "edited": !edited.is_empty(), "ids": edited }))
}

#[derive(Deserialize)]
pub struct ExportItem {
    id: String,
    settings: Value,
    dest: String,
    /// Export the externally edited image instead of developing the RAW.
    #[serde(default)]
    edited: bool,
}

fn resize_rgba(img: &Rgba8, w: usize, h: usize) -> Rgba8 {
    if img.width == w && img.height == h {
        return img.clone();
    }
    let mut f = lightcraft_raster::Image::<[f32; 4]>::new(img.width, img.height);
    for (d, s) in f.data.iter_mut().zip(&img.data) {
        *d = s.map(|v| v as f32 / 255.0);
    }
    let g = lightcraft_raster::resample::resize(&f, w, h, lightcraft_raster::resample::Filter::Lanczos3);
    let mut out = Rgba8::new(g.width, g.height);
    for (d, s) in out.data.iter_mut().zip(&g.data) {
        *d = s.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8);
    }
    out
}

/// Convert decoded, already finished pixels without running the develop tone/color pipeline again.
fn encode_finished(bytes: &[u8], o: &ExportOptions, extra: &crate::export_encode::ExtraOptions, meta: Option<&lightcraft_meta::Metadata>) -> Result<Vec<u8>, String> {
    use lightcraft_engine::export::{encode_deep, DeepImage, DeepSamples};
    let decoded = lightcraft_codecs::decode(bytes, Default::default()).map_err(|e| e.to_string())?;
    let orientation = lightcraft_geom::Orientation::from_exif(decoded.orientation);
    // Profileless Dehancer TIFFs are interpreted as sRGB by the decoder. Honor a real ICC when present.
    if o.effective_depth() == OutputDepth::U8 && o.effective_space() == OutputSpace::Srgb {
        let img = decoded.to_srgb8().into_oriented(orientation);
        let img = match o.resize {
            Some(r) => { let (w, h) = r.apply(img.width as f64, img.height as f64); resize_rgba(&img, w, h) }
            None => img,
        };
        return crate::export_encode::encode_pixels(&img, o, extra, meta);
    }
    let img = decoded.to_working().into_oriented(orientation);
    drop(decoded);
    let img = match o.resize {
        Some(r) => {
            let (w, h) = r.apply(img.width as f64, img.height as f64);
            lightcraft_raster::resample::resize(&img, w, h, lightcraft_raster::resample::Filter::Lanczos3)
        }
        None => img,
    };
    let space = o.effective_space();
    let matrix = space.from_working();
    let linear = matches!(o.effective_depth(), OutputDepth::F32Linear | OutputDepth::F32Hdr);
    let values: Vec<f32> = img.data.iter().flat_map(|p| (0..3).map(move |i| {
        let v = matrix[i][0] * p[0] + matrix[i][1] * p[1] + matrix[i][2] * p[2];
        if linear { v.max(0.0) } else { space.trc().encode(v) }
    })).collect();
    let samples = if linear { DeepSamples::F32(values) } else {
        DeepSamples::U16(values.into_iter().map(|v| (v * 65535.0).round().clamp(0.0, 65535.0) as u16).collect())
    };
    let deep = DeepImage { width: img.width, height: img.height, space, samples };
    if o.effective_depth() == OutputDepth::U8 {
        crate::export_encode::encode_pixels(&deep.to_rgba8(), o, extra, meta)
    } else if o.format == ExportFormat::Avif {
        crate::export_encode::encode_deep_avif(&deep, o, extra, meta)
    } else {
        encode_deep(&deep, o, meta)
    }
}

/// Nonempty preset fields replace existing values; keywords merge, then the policy filters them.
fn export_metadata(mut m: lightcraft_meta::Metadata, o: &ExportOptions, overrides: Option<&Value>, size: (usize, usize)) -> Option<lightcraft_meta::Metadata> {
    use lightcraft_engine::export::MetadataPolicy;
    if let Some(v) = overrides {
        for (key, dest) in [("creator", &mut m.artist), ("copyright", &mut m.copyright), ("title", &mut m.title), ("caption", &mut m.caption)] {
            if let Some(text) = v[key].as_str().filter(|s| !s.trim().is_empty()) { *dest = Some(text.trim().to_string()); }
        }
        if let Some(keys) = v["keywords"].as_array() {
            for key in keys.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                if !m.keywords.iter().any(|k| k == key) { m.keywords.push(key.to_string()); }
            }
        }
    }
    m.orientation = Some(lightcraft_geom::Orientation::Normal);
    m.width = Some(size.0 as u32);
    m.height = Some(size.1 as u32);
    m.software = Some(format!("PhotoCull {}", env!("CARGO_PKG_VERSION")));
    match o.metadata {
        MetadataPolicy::All => {}
        MetadataPolicy::AllExceptCamera => {
            m.make = None; m.model = None; m.serial_number = None;
            m.lens_make = None; m.lens_model = None; m.lens_serial_number = None; m.lens_spec = None;
            m.iso = None; m.f_number = None; m.exposure_time = None; m.focal_length = None; m.focal_length_35mm = None; m.flash = None;
            m.exposure_bias = None; m.exposure_program = None; m.metering_mode = None; m.white_balance = None;
            m.focus = None;
        }
        MetadataPolicy::Copyright => {
            m = lightcraft_meta::Metadata {
                artist: m.artist, copyright: m.copyright, copyright_marked: m.copyright_marked,
                usage_terms: m.usage_terms, copyright_url: m.copyright_url,
                ..Default::default()
            };
        }
        MetadataPolicy::None => return None,
    }
    if o.remove_location {
        m.gps = None; m.sublocation = None; m.city = None; m.state = None; m.country = None;
    }
    Some(m)
}

/// Publish a complete staging file, retaining the prior destination on any failure.
fn publish_export(partial: &Path, dest: &Path, overwrite: bool) -> Result<(), String> {
    if overwrite { return std::fs::rename(partial, dest).map_err(|e| e.to_string()); }
    match std::fs::hard_link(partial, dest) {
        Ok(()) => { let _ = std::fs::remove_file(partial); Ok(()) }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e.to_string()),
        Err(_) => {
            // exFAT/FAT have no hard links. Claim a new name, then replace only our placeholder.
            std::fs::OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| e.to_string())?;
            if let Err(e) = std::fs::rename(partial, dest) {
                let _ = std::fs::remove_file(dest);
                return Err(e.to_string());
            }
            Ok(())
        }
    }
}

/// Exports photos to the given destinations (planned by the Node backend). Existing files follow `conflict`:
/// "skip" leaves them, "overwrite" replaces them; unique names are planned beforehand.
#[tauri::command]
pub async fn export_photos(
    app: AppHandle,
    engine: State<'_, Arc<Engine>>,
    backend: State<'_, Backend>,
    session: String,
    items: Vec<ExportItem>,
    options: Value,
    overwrite: bool,
    metadata_overrides: Option<Value>,
) -> Result<Value, String> {
    let mut options = options;
    // Lightcraft's command params use lowercase, but TiffCompression's serde variants are capitalized.
    if let Some(value) = options.get_mut("tiffCompression") {
        if let Some(name) = value.as_str() {
            *value = json!(match name.to_ascii_lowercase().as_str() {
                "none" => "None", "deflate" => "Deflate", "lzw" => "Lzw", "packbits" => "PackBits", _ => name,
            });
        }
    }
    let extra: crate::export_encode::ExtraOptions = serde_json::from_value(options.clone()).map_err(|e| format!("Invalid encoder settings: {e}"))?;
    let o: ExportOptions = serde_json::from_value(options).map_err(|e| format!("Invalid export settings: {e}"))?;
    if !matches!(o.format, ExportFormat::Jpeg | ExportFormat::Png | ExportFormat::Tiff | ExportFormat::Webp | ExportFormat::Avif | ExportFormat::Jxl) {
        return Err("Unsupported export format.".into());
    }
    if !(1..=100).contains(&o.quality) || o.ppi == 0 || o.bit_depth.is_some_and(|d| !ExportOptions::bit_depths(o.format).iter().any(|v| v.0 == d)) {
        return Err("Invalid export quality, resolution or bit depth.".into());
    }
    if o.resize.is_some_and(|r| !r.value.is_finite() || r.value <= 0.0 || r.height == 0) {
        return Err("Invalid export size.".into());
    }
    let mut jobs = Vec::new();
    let mut protected = Vec::new();
    let mut edited_exports = Vec::new();
    for item in items {
        let ctx = Engine::context(&backend, &session, &item.id).await?;
        if item.edited || ctx.edited_by.is_none() { edited_exports.push(json!({"id": item.id, "path": ctx.tiff, "stamp": ctx.handoff_stamp})); }
        for file in std::iter::once(&ctx.file).chain(ctx.tiff.iter()) {
            if let Ok(path) = std::fs::canonicalize(file) { protected.push(path); }
        }
        jobs.push((item, ctx));
    }
    let mut destinations = std::collections::HashSet::new();
    for (item, _) in &jobs {
        let dest = PathBuf::from(&item.dest);
        if !dest.is_absolute() { return Err("Export destinations must be absolute and unique.".into()); }
        let parent = dest.parent().ok_or("Invalid export destination.")?;
        let resolved = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf()).join(dest.file_name().ok_or("Invalid export filename.")?);
        if !destinations.insert(resolved.to_string_lossy().to_lowercase()) { return Err("Export destinations must be absolute and unique.".into()); }
    }
    let engine = engine.inner().clone();
    let total = jobs.len();
    let busy_engine = engine.clone();
    let _busy = Busy::take(&busy_engine.busy)?;
    engine.cancel.store(false, Ordering::SeqCst);
    let progress_app = app.clone();
    let results = blocking(move || {
        let done = Mutex::new(0usize);
        let results = ordered_export_map(jobs, export_workers(), |(item, ctx)| {
            if engine.cancel.load(Ordering::SeqCst) {
                return json!({ "id": item.id, "status": "cancelled" });
            }
            let dest = PathBuf::from(&item.dest);
            let t = Instant::now();
            let partial = dest.with_file_name(format!("{}.partial", dest.file_name().unwrap_or_default().to_string_lossy()));
            let mut staged_xmp: Option<String> = None;
            let result = (|| -> Result<&'static str, String> {
                if dest.exists() && !overwrite {
                    return Ok("exists");
                }
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
                }
                if !dest.is_absolute() { return Err("Choose an absolute export destination.".into()); }
                if let Ok(existing) = std::fs::symlink_metadata(&dest) {
                    if !existing.is_file() || existing.file_type().is_symlink() { return Err("Destination is not a regular file.".into()); }
                }
                let parent = std::fs::canonicalize(dest.parent().ok_or("Invalid export destination.")?).map_err(|e| e.to_string())?;
                let resolved = parent.join(dest.file_name().ok_or("Invalid export filename.")?);
                if protected.iter().any(|p| p.to_string_lossy().eq_ignore_ascii_case(&resolved.to_string_lossy())) {
                    return Err("Export cannot replace a source image or developed TIFF.".into());
                }
                let source = std::fs::read(&ctx.file).map_err(|e| format!("{}: {e}", ctx.file))?;
                let meta = lightcraft_meta::extract(&source);
                let bytes = if item.edited || !ctx.raw {
                    let data = if item.edited {
                        let tiff = ctx.tiff.as_deref().ok_or("This photo has no external edit.")?;
                        std::fs::read(tiff).map_err(|e| format!("{tiff}: {e}"))?
                    } else { source };
                    let header = lightcraft_codecs::read_header(&data).map_err(|e| e.to_string())?;
                    let orientation = lightcraft_geom::Orientation::from_exif(header.orientation);
                    let (w, h) = if orientation.swaps_axes() { (header.height as usize, header.width as usize) } else { (header.width as usize, header.height as usize) };
                    let size = o.resize.map_or((w, h), |r| r.apply(w as f64, h as f64));
                    let meta = export_metadata(meta, &o, metadata_overrides.as_ref(), size);
                    if o.format == ExportFormat::Avif { staged_xmp = meta.as_ref().map(|m| lightcraft_meta::write_xmp(m, None)); }
                    encode_finished(&data, &o, &extra, meta.as_ref())?
                } else {
                    drop(source);
                    let photo = engine.photo(Path::new(&ctx.file))?;
                    let (src, info) = photo.source(usize::MAX)?;
                    let settings = settings_for(&info, &item.settings)?;
                    let native = lightcraft_pipeline::native_output_size(src.width, src.height, &settings);
                    let size = o.resize.map_or((native.0.round() as usize, native.1.round() as usize), |r| r.apply(native.0, native.1));
                    let mut req = RenderRequest::fit(size.0, size.1);
                    req.space = o.effective_space(); req.depth = o.effective_depth();
                    let r = lightcraft_pipeline::render(&src, &info, &settings, &req);
                    let meta = export_metadata(meta, &o, metadata_overrides.as_ref(), (r.image.width, r.image.height));
                    if o.format == ExportFormat::Avif { staged_xmp = meta.as_ref().map(|m| lightcraft_meta::write_xmp(m, None)); }
                    crate::export_encode::encode_rendered(&r, &o, &extra, meta.as_ref())?
                };
                if engine.cancel.load(Ordering::SeqCst) { return Ok("cancelled"); }
                // Exclusive staging creation never clobbers a stale partial file or follows its symlink.
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&partial).map_err(|e| format!("{}: {e}", partial.display()))?;
                let write = (|| -> Result<(), String> {
                    use std::io::Write;
                    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
                    drop(file);
                    // Lightcraft's AVIF muxer omits XMP. Embed it on the staging file before publication.
                    if let Some(xmp) = &staged_xmp {
                        let backend = progress_app.state::<Backend>();
                        tauri::async_runtime::block_on(backend.call("export-embed-xmp", json!([partial.to_string_lossy(), xmp])))?;
                    }
                    Ok(())
                })();
                if write.is_err() { let _ = std::fs::remove_file(&partial); }
                write?;
                if engine.cancel.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&partial);
                    return Ok("cancelled");
                }
                let published = publish_export(&partial, &dest, overwrite);
                if published.is_err() { let _ = std::fs::remove_file(&partial); }
                published?;
                Ok("exported")
            })();
            let row = match result {
                Ok(status) => json!({ "id": item.id, "status": status, "dest": item.dest, "name": ctx.name, "ms": ms(t) }),
                Err(error) => json!({ "id": item.id, "status": "failed", "dest": item.dest, "error": error }),
            };
            let mut count = lock(&done); *count += 1;
            emit_progress(&progress_app, "export-progress", json!({ "done": *count, "total": total, "name": ctx.name }));
            row
        });
        Ok(results)
    })
    .await?;
    emit_progress(&app, "export-progress", json!({ "done": total, "total": total }));
    let exported: Vec<_> = edited_exports.iter().filter(|e| results.iter().any(|r| r["status"] == "exported" && r["id"] == e["id"])).collect();
    let cleanup = backend.call("handoff-exported", json!([session, exported])).await;
    Ok(json!({ "results": results, "cleanup": cleanup.as_ref().ok(), "cleanupWarning": cleanup.err() }))
}

// A 33 MP float source alone is ~400 MB, with multiple render/codec buffers in flight.
// Use at most half the logical cores and three photos; do not retain full-resolution sources.
fn export_workers() -> usize { (std::thread::available_parallelism().map_or(2, usize::from) / 2).clamp(1, 3) }
fn ordered_export_map<T: Send, R: Send, F: Fn(T) -> R + Sync>(jobs: Vec<T>, workers: usize, work: F) -> Vec<R> {
    let total = jobs.len();
    let queue = Mutex::new(jobs.into_iter().enumerate());
    let out = Mutex::new((0..total).map(|_| None).collect::<Vec<Option<R>>>());
    std::thread::scope(|scope| {
        for _ in 0..workers.min(total) {
            let (queue, out, work) = (&queue, &out, &work);
            scope.spawn(move || loop {
                let Some((i, job)) = lock(queue).next() else { break };
                let result = work(job); lock(out)[i] = Some(result);
            });
        }
    });
    out.into_inner().unwrap_or_else(PoisonError::into_inner).into_iter().map(Option::unwrap).collect()
}

// Export-only tests; no camera fixtures or develop-view state required.
#[cfg(test)]
mod export_tests {
    use super::*;
    use lightcraft_engine::export::encode_with_metadata;
    use lightcraft_engine::export::{MetadataPolicy, Resize, ResizeMode};

    #[test]
    fn parallel_export_preserves_order_and_cancels_queued_work() {
        use std::sync::atomic::AtomicUsize;
        let active = AtomicUsize::new(0); let peak = AtomicUsize::new(0);
        let rows = ordered_export_map((0..12).collect(), 3, |i| {
            let n = active.fetch_add(1, Ordering::SeqCst) + 1; peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis((12-i) as u64));
            active.fetch_sub(1, Ordering::SeqCst); i
        });
        assert_eq!(rows, (0..12).collect::<Vec<_>>()); assert!(peak.load(Ordering::SeqCst) <= 3); assert!(peak.load(Ordering::SeqCst) > 1);
        let cancelled = AtomicBool::new(false);
        let barrier = std::sync::Barrier::new(3);
        let rows = ordered_export_map((0..20).collect(), 3, |i| {
            if cancelled.load(Ordering::SeqCst) { return None; }
            if i < 3 {
                barrier.wait();
                if i == 0 { cancelled.store(true, Ordering::SeqCst); }
                barrier.wait();
            }
            Some(i)
        });
        assert_eq!(rows[..3], [Some(0), Some(1), Some(2)]); assert!(rows[3..].iter().all(Option::is_none));
        let failures = ordered_export_map((0..5).collect(), 3, |i| if i == 2 { Err("codec error") } else { Ok(i) });
        assert_eq!(failures, vec![Ok(0), Ok(1), Err("codec error"), Ok(3), Ok(4)]);
    }

    #[test]
    fn publication_preserves_existing_files_unless_overwrite_is_explicit() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("photocull-export-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("photo.jpg"); let partial = dir.join("photo.jpg.partial");
        std::fs::write(&dest, b"existing").unwrap(); std::fs::write(&partial, b"finished").unwrap();
        assert!(publish_export(&partial, &dest, false).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"existing");
        publish_export(&partial, &dest, true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"finished"); assert!(!partial.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metadata_overrides_are_filtered_and_location_is_removed() {
        let meta = lightcraft_meta::Metadata {
            model: Some("camera".into()), serial_number: Some("serial".into()),
            city: Some("Paris".into()), keywords: vec!["existing".into()], ..Default::default()
        };
        let overrides = json!({"creator": "Test Photographer", "copyright": "Copyright", "title": "Title", "caption": "Caption", "keywords": ["existing", "new"]});
        let o = ExportOptions { metadata: MetadataPolicy::AllExceptCamera, remove_location: true, ..Default::default() };
        let m = export_metadata(meta.clone(), &o, Some(&overrides), (120, 80)).unwrap();
        assert_eq!(m.artist.as_deref(), Some("Test Photographer"));
        assert_eq!(m.keywords, vec!["existing", "new"]);
        assert!(m.model.is_none() && m.serial_number.is_none() && m.city.is_none());
        assert_eq!((m.width, m.height), (Some(120), Some(80)));
        let m = export_metadata(meta.clone(), &ExportOptions { metadata: MetadataPolicy::Copyright, ..o.clone() }, Some(&overrides), (120, 80)).unwrap();
        assert_eq!(m.copyright.as_deref(), Some("Copyright"));
        assert!(m.title.is_none() && m.keywords.is_empty());
        assert!(export_metadata(meta, &ExportOptions { metadata: MetadataPolicy::None, ..o }, Some(&overrides), (120, 80)).is_none());
    }

    #[test]
    fn finished_pixels_honor_enlargement_depth_and_output_profile() {
        let mut img = Rgba8::new(12, 8);
        img.data.fill([128, 90, 50, 255]);
        let source = encode_with_metadata(&img, &ExportOptions { format: ExportFormat::Png, ..Default::default() }, None).unwrap();
        let o = ExportOptions {
            format: ExportFormat::Png, bit_depth: Some(16), color_space: OutputSpace::DisplayP3,
            resize: Some(Resize { mode: ResizeMode::LongEdge, value: 24.0, height: 24, dont_enlarge: false }),
            ..Default::default()
        };
        let bytes = encode_finished(&source, &o, &Default::default(), None).unwrap();
        let decoded = lightcraft_codecs::decode(&bytes, Default::default()).unwrap();
        assert_eq!((decoded.width, decoded.height, decoded.bit_depth), (24, 16, 16));
        assert!(decoded.icc.is_some());
        let back = decoded.to_srgb8();
        for (a, b) in back.data[0][..3].iter().zip([128i16, 90, 50]) { assert!((*a as i16 - b).abs() <= 1); }
        let up = resize_rgba(&img, 24, 16);
        assert_eq!((up.width, up.height), (24, 16));
    }
}

/// Whether the lensfun lens database (CC BY-SA 3.0; downloaded on request, never bundled) is installed.
#[tauri::command]
pub fn lens_database(engine: State<'_, Arc<Engine>>) -> Value {
    json!({
        "installed": engine.lens_db().0.is_some(),
        "downloading": engine.lens_downloading.load(Ordering::SeqCst),
        "megabytes": lightcraft_engine::lensfun_download::download_megabytes(),
    })
}

/// Downloads the lensfun database (pinned commit, checked SHA-256s) into PhotoCull's data folder.
#[tauri::command]
pub async fn download_lens_database(app: AppHandle, engine: State<'_, Arc<Engine>>) -> Result<Value, String> {
    use lightcraft_engine::lensfun_download::{mirrors, COMMIT, FILES};
    if engine.lens_downloading.swap(true, Ordering::SeqCst) {
        return Err("The lens database is already downloading.".into());
    }
    let engine = engine.inner().clone();
    let result = blocking({
        let engine = engine.clone();
        move || {
            let dir = engine.lens_dir.clone();
            let staging = dir.with_extension("download");
            std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
            let specs: Vec<lightcraft_fetch::FileSpec<'_>> = FILES
                .iter()
                .map(|(name, size, sha)| lightcraft_fetch::FileSpec { name, size: Some(*size), sha256: Some(sha), max: 64 << 20 })
                .collect();
            let cancel = AtomicBool::new(false);
            lightcraft_fetch::download(&specs, &mirrors(), &staging, &lightcraft_fetch::Options::default(), &cancel, &mut |p| {
                let _ = app.emit("lens-database-progress", json!({ "done": p.done, "total": p.total }));
            })
            .map_err(|e| format!("Could not download the lens database: {e}"))?;
            std::fs::write(
                staging.join(lightcraft_engine::lensfun_download::MARKER),
                format!("lensfun lens database (data/db), commit {COMMIT}\nfrom https://github.com/lensfun/lensfun, downloaded by PhotoCull.\nLicence: Creative Commons Attribution-ShareAlike 3.0, by the lensfun contributors.\n"),
            )
            .map_err(|e| e.to_string())?;
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            std::fs::rename(&staging, &dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            *lock(&engine.lens_db) = None;
            lock(&engine.photos).clear();
            Ok(())
        }
    })
    .await;
    engine.lens_downloading.store(false, Ordering::SeqCst);
    result?;
    Ok(json!({ "installed": engine.lens_db().0.is_some() }))
}

#[cfg(test)]
mod result_tests {
    use super::*;
    use lightcraft_engine::export::encode_with_metadata;

    #[test]
    fn preview_profile_is_srgb_without_changing_encoded_pixels() {
        let mut image = Rgba8::new(12, 8);
        image.data.fill([114, 175, 203, 255]);
        let tagged = encode_frame(&image).unwrap();
        let old = lightcraft_codecs::encode_jpeg(&lightcraft_codecs::EncodeImage::rgba8(&image), 88,
            lightcraft_codecs::ChromaSubsampling::S420, &Default::default()).unwrap();
        let decode = |bytes: &[u8]| lightcraft_codecs::decode(bytes, Default::default()).unwrap();
        assert_eq!(decode(&tagged).icc.unwrap(), lightcraft_codecs::icc::write_named(lightcraft_codecs::NamedSpace::Srgb));
        // ICC APP2 metadata is the only change; JPEG quantization is identical.
        let scan = old.windows(2).position(|m| m == [0xff, 0xda]).unwrap();
        assert!(tagged.ends_with(&old[scan..]));
    }

    #[test]
    fn known_handoff_requires_a_recorded_absolute_regular_image() {
        let unique = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("photocull-result-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tiff = dir.join("photo.tif"); std::fs::write(&tiff, b"pixels").unwrap();
        assert_eq!(known_handoff(tiff.to_str()).unwrap(), tiff);
        assert!(known_handoff(None).is_err());
        assert!(known_handoff(Some("relative.tif")).is_err());
        assert!(known_handoff(dir.to_str()).is_err());
        let other = dir.join("photo.txt"); std::fs::write(&other, b"pixels").unwrap();
        assert!(known_handoff(other.to_str()).is_err());
        #[cfg(unix)] {
            let link = dir.join("link.tif"); std::os::unix::fs::symlink(&tiff, &link).unwrap();
            assert!(known_handoff(link.to_str()).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finished_preview_reads_optional_dehancer_fixture() {
        let Ok(file) = std::env::var("PHOTOCULL_DEHANCER_TIFF") else { return; };
        let bytes = std::fs::read(known_handoff(Some(&file)).unwrap()).unwrap();
        let preview = finished_preview(&bytes, SETTLED_EDGE).unwrap();
        assert_eq!(preview.width.max(preview.height), SETTLED_EDGE);
        let jpeg = encode_frame(&preview).unwrap();
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
    }

    #[test]
    fn finished_tiff_preview_preserves_color_and_fits_without_enlarging() {
        let mut image = Rgba8::new(12, 8); image.data.fill([200, 80, 30, 255]);
        let bytes = encode_with_metadata(&image, &ExportOptions {format: ExportFormat::Tiff, bit_depth: Some(8), ..Default::default()}, None).unwrap();
        let small = finished_preview(&bytes, 6).unwrap(); assert_eq!((small.width, small.height), (6, 4));
        for (actual, expected) in small.data[0][..3].iter().zip([200i16, 80, 30]) { assert!((*actual as i16 - expected).abs() <= 1); }
        let native = finished_preview(&bytes, 100).unwrap(); assert_eq!((native.width, native.height), (12, 8));
        assert!(finished_preview(b"broken TIFF", 6).is_err());
    }
}
