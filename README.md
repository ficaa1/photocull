<img src="assets/icon.svg" width="64" height="64" alt="">

# PhotoCull

A local desktop MVP for quickly reviewing camera RAW files and JPEGs. Connect a camera card, browse previews, pick your keepers, and copy their originals for editing. No catalog import or cloud service.

## Run

Use Node.js 24, npm, Rust stable and the native Tauri build prerequisites for your OS. On macOS, install the Xcode command-line tools; on Windows, install the MSVC C++ build tools and WebView2. Linux needs WebKitGTK 4.1, libayatana-appindicator3, librsvg2, libxdo and patchelf development packages; Linux builds are currently manual.

For desktop development:

```sh
npm ci
npm start
```

`npm start` runs `tauri dev`, using `node` on PATH and the checkout’s `src/` directory. The Tauri 2 Rust shell handles the window, native dialogs, fullscreen, Mac menus and deletion. Photo scanning, previews, decisions and copying run in a Node sidecar over JSON-lines RPC on stdio. Images are served from a token-protected HTTP server on `127.0.0.1`; `src/renderer/bridge.js` provides the shared UI API.

To build an installable bundle:

```sh
npm run build
```

This stages `src/` and production dependencies in `src-tauri/backend/`, copies the running Node binary to `src-tauri/binaries/node-<triple>`, and runs Tauri with `src-tauri/tauri.bundle.conf.json`. Build natively on each target OS because sharp and ExifTool contain platform-specific binaries. Use an official Node build: Homebrew Node is not relocatable. Bundles are written under `src-tauri/target/release/bundle/` and are unsigned and not notarized.

For the UI in a normal browser:

```sh
npm run web
```

Open the token-bearing URL printed by the backend on port 5173. This runs `src/backend.cjs --web`; folder selection uses a path prompt and Move to Trash is unavailable. Browser-mode deletion is permanent.

## macOS

Build on an Apple Silicon or Intel Mac with `npm run build`. The `.app` and `.dmg` are under `src-tauri/target/release/bundle/macos/` and `dmg/`. Native Mac launch has not been verified yet. See [macOS setup and validation limits](docs/macos.md) for unsigned-app opening, permissions and Command shortcuts.

## Workflow

1. Connect a camera card. PhotoCull checks mounted drives every five seconds and opens a single detected camera card automatically when no session is open, including DCIM subfolders. With multiple cards, choose one under Connected cards. A newly connected card never replaces an active session. You can also open any folder manually. RAW + JPEG files with the same stem are grouped when there is exactly one of each in a directory.
2. Review with arrow keys. `P` picks, `X` rejects, `U` clears the flag, and `0–5` sets the star rating. Assign an independent color with the inspector swatches or `Alt+1–8` (`Alt+0` clears); `6–9` also selects the first four colors. Filter with the color menu. Flags advance to the next image by default when one photo is selected. Shift+click selects a range in the grid or filmstrip; drag across the grid to select several. Ctrl+click (Cmd+click on macOS) adds/removes a photo; hold Shift or Ctrl/Cmd while dragging to add to the selection. Shift+arrows extends the range, Ctrl+A (Cmd+A) selects the current view, and Esc returns to only the current photo. The stronger outline identifies the photo shown in review and the inspector. Flags, ratings and colors apply to all selected photos as one undoable decision; multi-photo decisions keep your place.
3. Press `G` for the virtualized contact sheet, `E` for review, and `D` for Develop (`Ctrl+Tab` also toggles views). `Tab` and `Shift+Tab` move keyboard focus through controls. Use `B`/`I` or the pane buttons to hide sources/details; the contact-sheet slider adjusts thumbnail size. Layout choices persist locally. Zoom and pan work like Lightroom Classic's loupe; see [Zoom and pan](#zoom-and-pan) below.
4. Press `F`/`F11` or click the fullscreen icon for native fullscreen review. Zoom, panning, navigation and culling shortcuts work there too; while zoomed, a small navigator appears at the top right. Move to the bottom edge to reveal the filmstrip and decision controls; they hide when the pointer leaves. `Esc` clears a multi-selection first, then exits fullscreen while keeping the zoom, and a further `Esc` returns to Fit. `G` switches to the contact sheet and leaves fullscreen.
5. `Ctrl+Z` undoes a decision; `Ctrl+Shift+Z` redoes it. Search, picks, rejects, rated, unreviewed and Trash filters are available. A rated or flagged image counts as reviewed.
6. Press `Del`/`⌫` in any view to move the selected photos to PhotoCull’s **Trash** (the last section in the sidebar). Nothing changes on disk: the photo just leaves the other views and copies, and `Ctrl+Z` or `R` in the Trash view brings it back. In the Trash view, `Del` asks to delete the photo for real, and **Empty trash** deletes all of them. `Shift+Del` asks to delete the selected photos permanently from any view (one prompt for the selection). Prompts confirm with `Enter`; any other key cancels without applying that key’s action.
7. In Rejects, **Delete N rejects** (and **Empty trash** in Trash) let you choose **Move to Recycle Bin/system Trash** or **Delete permanently**. The choice is remembered as `deleteMode`. Camera-card sessions, including folders under a detected card root, only allow permanent deletion because cards have no system Trash; the desktop shell also refuses it for those sessions. PhotoCull’s own Trash works the same on cards.
8. Click **Copy picks**, choose your SSD/folder, and copy the picked originals. RAW + JPEG pairs copy just the RAW by default; companion JPEGs and XMP sidecars are optional. Standalone JPEG/image picks copy their original files. All picks in the session are included regardless of the current view/filter; ratings alone do not select a file for copying. You can also develop RAW picks in PhotoCull and send the TIFFs to Dehancer, then click **Export…** (`Ctrl/Cmd+Shift+E`) for finished images.

### Zoom and pan

The review view (`E`) and fullscreen (`F`) behave like Lightroom Classic's loupe. Zoom percentages are relative to the photo's real pixels on the physical display: 100% shows one photo pixel per screen pixel, also with Windows/macOS display scaling. The real size comes from the RAW's metadata, so 100% is the same size whether the camera's embedded JPEG or a RAW development is on screen.

| Input | Action |
| --- | --- |
| Click a photo at Fit or Fill | Zoom to the click-zoom ratio, keeping the clicked point under the pointer. Settings → General → **Zoom clicked point to center** (off by default, as in Lightroom) moves it to the centre instead. |
| Click a zoomed photo | Back to Fit (or Fill, if you chose Fill) |
| Drag (more than 4 px) | Pan. A shorter press counts as a click. The photo can't be dragged out of view, and an axis smaller than the view stays centred. |
| `Z` / `Space` | Toggle Fit ↔ click zoom. With the pointer over the photo it zooms around the pointer (as Lightroom does), otherwise to the last zoomed position (the centre at first). From the contact sheet, `Z` opens the photo zoomed. |
| Hold `Space` while zoomed | Temporary hand: drag anywhere to pan. On release you stay zoomed if you dragged; a tap without dragging toggles back to Fit. |
| `Ctrl`/`Cmd` `+` / `−` | Step through 12.5–1600% levels above Fit, around the view centre; stepping below the first level returns to Fit |
| `Ctrl`/`Cmd` `0`, `Esc` | Fit (`Esc` first clears a multi-selection, then leaves fullscreen) |
| `Ctrl`+wheel, trackpad pinch | Zoom smoothly around the pointer, from Fit up to 1600% |
| Two-finger scroll / wheel | Pans a zoomed photo. At Fit the plain wheel does nothing (it never changes photos). |
| **Fit** / **Fill** buttons | Fit the whole photo, or fill the view (cropping the overflow, which you can pan) |
| Percentage menu | Choose the click-zoom ratio (12.5–1600%; 100/200/300/400/800% are Lightroom's click ratios) and zoom to it. It persists between launches. |
| Navigator (Details pane) | Shows the whole photo with a frame for the visible area. Click or drag to move the view; a click at Fit zooms there. When the Details pane is hidden or in fullscreen it appears as an overlay while zoomed. |

The chip beside **Fit** shows the current zoom level. Zoom changes animate for 150 ms unless the system asks for reduced motion. Moving to another photo keeps the zoom level and the relative position, as in Lightroom; photos open at Fit only if you were at Fit. Opening another folder starts at Fit.

When the pixels on screen are the camera's JPEG (embedded in the RAW, or its companion JPEG) rather than a development of the sensor data, the top-right corner says **Camera preview**. Hover over it for which JPEG it is and what that means. The inspector's Preview/Source rows show the representation's size and origin. A small embedded preview still limits focus assessment; choose “Missing or small previews” in Settings to request RAW development when needed.

Deletion removes the image, its paired JPEG and its XMP sidecar. The image is removed first; if that fails, its companion and sidecar are left alone. A sidecar shared by same-stem RAWs is removed only after all of them are deleted. Each file is checked against the folder scan first; photos that changed since (for example a different card in the same reader) are skipped, and a replaced folder is refused until it is opened again. Copying and deleting never run at the same time. Deleted photos leave undo history and saved decisions. PhotoCull cannot undo deletion from disk; files moved to the Recycle Bin or system Trash can be restored there.

The copy dialog’s **Folder** menu defaults to **No subfolder**, which copies files directly into the chosen destination. **Named subfolder** creates the name you enter and puts the picks there. **Keep source folders** retains paths such as `100MSDCF`. The layout and folder name persist and are included in export presets. Flattened filename collisions are reported; a sequence filename template can make names unique. Existing files cause that photo group to be skipped rather than overwritten. A conflicting companion or sidecar also skips the group. Repeated same-stem RAW sidecars are reported as conflicts. Source changes, card removal, destination failures, and cancellation are reported; cancellation removes the current incomplete photo group and keeps completed groups. Only one copy can run at once. A size check and disk flush verify each completed file; this is not a full destination checksum pass.

Optional XMP is generated **only in the destination**, preserving unrelated source-sidecar metadata and adding current ratings/labels. No XMP is needed to make the selection: the destination contains only keepers. Direct iPad XMP import is not verified, so treat XMP as optional metadata for compatible desktop workflows. Source image bytes are never modified; source images are deleted only when you explicitly use the delete actions. Copy export does not write to the source/card. Decisions autosave locally.

Settings → Metadata → **Export metadata** retains explicit source-folder XMP writing and JSON decisions export. These do not copy photos. Writing sidecars there does modify source-folder XMP files; it is separate from the primary copy workflow.

RAWs use `filename.xmp`; JPEG-only images use `filename.jpg.xmp`. RAW + JPEG pairs share the RAW’s sidecar. The Standard preset maps picks to `xmp:Label="Green"` and rejects to `xmp:Rating="-1"` with label `Red`; an explicit per-photo color takes priority over the pick/reject mapping. The palette has eight editable display names, swatches, and XMP label strings. Ratings use 0–5. Presets can turn rating/label writes off independently and disable rating −1 for rejects. XMP rejects occupy the rating field, so a rejected image’s prior positive rating remains in PhotoCull/JSON but is not simultaneously represented in its sidecar. Editor support for labels, flags, and JPEG sidecars varies. This MVP does not write proprietary Photo Mechanic tag fields.

Unrelated existing XMP metadata is preserved. The first existing sidecar is copied to `*.xmp.photocull-backup` before replacement. Malformed sidecars, symlink destinations, and ambiguous same-stem RAW sidecars are reported instead of overwritten. Metadata-only source XMP export includes **only images whose decisions were edited in PhotoCull**, across the whole open folder session regardless of the current filter. Explicitly cleared decisions also export. Unedited sidecars are left intact; JSON export includes every image in the session.

## Develop and Dehancer

In the desktop app, press **D** for Develop. Choose a RAW, pick a recipe, and adjust its live preview. Neutral is the flat starting point for Dehancer; Camera look and Dehancer guide (ACR values) are also included. The ACR recipe uses Lightcraft’s controls, so it is not an exact Adobe rendering. Profile, white balance, Light, parametric tone curve, lens corrections and Detail are grouped in collapsible panels. Sharpening and noise reduction start at zero; the point curve starts linear. Each photo autosaves its own settings. Save named recipes, update/delete custom recipes, set a default, or reset a photo to its recipe. Settings → General includes the default recipe and Dehancer executable path.

Sliders have numeric entry and keyboard arrows. Double-click a slider or its label to reset to the recipe value; Shift-drag gives one tenth speed. Draft previews use a 1600 px edge, followed by 2560 px after 250 ms idle. One render runs at a time; intermediate changes coalesce. The histogram uses Lightcraft’s five-bin smoothing and square-root display scale. Hover to read Blacks, Shadows, Exposure, Highlights or Whites; drag horizontally to adjust that zone, Shift for fine control, or double-click to reset it. The corner triangles light above 0.3% channel clipping. Click either triangle or press **J** for blue shadow/red highlight warnings computed from the displayed preview. JPEG preview warnings are approximate; they do not measure unrendered sensor headroom. **\** switches between the recipe rendering and the adjusted photo.

**Copy settings / Paste settings** (`Ctrl/Cmd+Shift+C/V`) transfers adjustments between photos. Apply the current settings to selected RAWs or all RAW picks. Thumbnail badges show ± for adjusted, T for developed TIFF, and D for saved Dehancer edits. Browser mode and non-RAW photos explain why development is unavailable.

**Send to Dehancer** develops selected RAWs or all RAW picks to **sRGB, 16-bit TIFF**. Choose the destination; the default is the source folder’s `_develop` directory. Camera cards require a local folder choice. Keep existing TIFFs to preserve possible Dehancer edits, or explicitly replace them. Progress and cancellation retain completed files. Each successful TIFF opens in Dehancer one at a time; close Dehancer to continue. Skip/Stop closes the Dehancer process launched for the current photo without saving pending changes. Saved edits overwrite the TIFF in place; PhotoCull detects the change and updates its badge. Dehancer can reduce the saved TIFF to 8-bit and remove its ICC profile, so keep the RAW for further development. The default executable is `C:\Program Files\Dehancer Lightroom Plugin\DehancerLightroom.exe`.

Lensfun data is downloaded only when requested from the Lens panel, with its size displayed; it is never bundled. Profiles may lack vignetting data (including the FE 40mm F2.5 G), so manual Vignetting and Midpoint remain available. RAW source bytes are never modified by Develop or Dehancer handoff.

Run `node scripts/develop-ui-smoke.cjs` for the mocked native-API browser smoke (set `CHROMIUM_PATH` if needed). Histogram, zone, fine-drag, settings merge and render scheduling unit tests run with `npm test`.

## Export finished images

Click **Export…** beside Copy picks, or press **Ctrl/Cmd+Shift+E**. Export defaults to all picks in the session, regardless of the current filter; choose **Current selection** for a smaller batch. Trashed photos are excluded. Copy picks remains the separate action for copying originals.

By default Export uses a saved Dehancer edit when available; otherwise it freshly develops the RAW using that photo’s current settings. **Always develop from RAW** bypasses saved TIFFs. Standalone JPEG, TIFF, PNG and WebP originals can also be decoded and re-encoded. This is a desktop feature; browser mode explains that a native engine is required. In this user’s tested workflow Dehancer saves back to the same TIFF as 8-bit sRGB without an ICC profile. PhotoCull interprets unprofiled TIFFs as sRGB and converts finished pixels into the chosen output space. Wider spaces or greater bit depth cannot recover colors or precision already lost in the saved TIFF.

File settings include JPEG, JPEG XL (lossy or lossless, Fast/Normal effort, progressive), TIFF (uncompressed/Deflate), PNG, AVIF and lossless-only WebP. JPEG offers a maximum file size in KB. PNG and JPEG XL offer 8/16-bit; TIFF offers 8/16-bit and 32-bit linear float; AVIF offers 8/10-bit and is much slower. AVIF output is sRGB with container color information rather than an ICC profile. Other supported output spaces are Display P3, Adobe RGB, ProPhoto RGB and Rec. 2020; Lightcraft’s lossy JPEG XL encoder substitutes Rec. 2020 for Adobe RGB/ProPhoto and the dialog discloses this.

Choose full size, long/short edge, width, height, width & height, dimensions, megapixels or percent, with optional **Don’t enlarge**. Width & height fits the displayed orientation; Dimensions fits either orientation. Output sharpening is applied after resizing for screen, matte or glossy paper, with Low/Standard/High amount. PPI sets the print-resolution metadata independently of pixel dimensions.

Metadata policies are All, All except camera & camera-raw info, Copyright & creator only, or None. **Remove location** also removes descriptive city/state/country fields. The active PhotoCull metadata preset supplies nonempty creator (mapped to Artist), copyright, title and caption; keywords merge. The policy applies afterward, so Copyright excludes title/caption/keywords and None excludes these overrides. RAW camera/lens/capture metadata comes from the RAW even when pixels come from Dehancer. These are Lightcraft’s supported metadata fields, not a byte-for-byte preservation of proprietary maker notes or arbitrary camera-raw settings.

File naming reuses PhotoCull’s naming templates/presets and live preview with the new extension. Choose or paste a destination folder, optionally add one named subfolder, and select unique names, skip existing files or overwrite. Duplicate/invalid planned names stop the batch before writing. Source images and known developed TIFFs cannot be replaced. Each completed file is staged, flushed and published; failures retain an existing destination. Cancellation waits for the current encoder, keeps completed files and reports cancelled photos as skipped. Exports run sequentially to bound full-resolution RAW memory. Results include exported/skipped/failed counts, reasons and **Show in folder**.

The dialog includes Lightcraft’s JPEG (Small) and JPEG (Large) built-ins, plus JPEG XL and TIFF (16-bit). Last used options, subfolder and conflict policy persist in settings. Metadata/naming presets remain managed in Settings; named finished-image presets are not implemented.

See [Develop, Dehancer and export validation](docs/validation.md#develop-dehancer-and-export-2026-11-05) for test coverage, timings, readback results and known limits. Run `node scripts/image-export-ui-smoke.cjs` for the mocked renderer/real Node-planning smoke. `test/image-export.test.cjs` covers option mapping and destination planning; export-only Rust tests are in `develop.rs`. `scripts/image-export-windows.cjs` exercises the real Windows Tauri app using a dedicated WebView2 debug profile, writes to a fresh `export-ui-test/run-*` folder, reads output metadata and verifies source hashes. Follow with `node scripts/image-export-readback.cjs` for codec readback and a contact sheet; AVIF is read with sharp/libheif because Lightcraft has no AV1 decoder. It requires the explicitly configured isolated test data directory documented in the script; it does not drive ordinary production app instances.

## Settings, presets and filenames

**Settings** contains General, Metadata, Colors, and File naming tabs. General controls auto advance, subfolder scanning, card auto-open, RAW rendering and copy defaults. Changes apply with Save; Cancel discards the draft. Settings and saved presets live in `%APPDATA%/PhotoCull/settings/` on Windows (`settings.json` plus `presets/<id>.json`), accessible through **Open settings folder**. The old top-level `settings.json` is migrated on first launch; sessions and caches are retained. Manual file edits are loaded on restart.

Built-in export presets are Standard, Ratings only and Labels only. Use **Save as** in Metadata for a named custom preset. Presets include metadata rules, eight color definitions and filename naming rules. Creator, copyright, title and caption replace only the nonempty fields you supply; blank fields preserve existing metadata. Keywords merge with existing keywords. Disabled rating/label writes preserve existing values. Source image bytes are always unchanged; optional embedding modifies only destination copies. Pick/reject state remains a local culling decision; a color label is not a universal Lightroom pick flag.

The compact copy dialog selects the preset and optionally overrides **File naming**, with a live preview from the first picked photo. Formats include original filename, custom text + sequence, capture date + filename, export date + sequence, or a custom template. Available tokens:

| Token | Value |
| --- | --- |
| `{filename}` | Original base name, without extension |
| `{text}` | Custom text |
| `{seq}` / `{seq:3}` | Sequence number, default four digits or specified padding 1–6 |
| `{capturedate}` | EXIF capture date as YYYYMMDD |
| `{year}` / `{month}` / `{day}` | EXIF capture-date components |
| `{date}` | Local export date as YYYYMMDD |

For example, `{text}_{capturedate}_{seq:3}` with text `Trip` and start 7 creates `Trip_20260926_007.ARW`, its optional companion `.JPG`, and `.xmp`. Extensions are retained; folder layout follows the Folder menu. Numbering follows the naturally sorted picked photos and restarts from the configured start on each export; skipped/failed selections consume their planned number. Missing capture dates cause a reported failure for that photo rather than silently using a different date. Unsafe names and paths are refused. Naming collisions among selected groups cause all affected groups to be skipped; existing destination groups are skipped without overwriting. Copy checkboxes, folder layout and naming choices persist between launches.

### Embedded metadata and Windows Properties

XMP sidecars are separate files. Windows Explorer’s Properties panel for an ARW does not read its neighboring XMP, so sidecar Creator will not appear as Authors there. **Embed metadata** in the copy dialog writes the current preset directly into the exported image copies, independently of the XMP checkbox. This option changes the copied file’s metadata/bytes, while source images stay untouched. When it is off, image copies remain byte-identical. Older settings that already contain a Creator enable embedding on migration; other users opt in with the checkbox. You can disable it at any time.

On Sony ARW and JPEG, embedding writes Creator plus EXIF Artist/XPAuthor for Windows, with the applicable rating, label, title, copyright, caption and keywords. Existing keywords merge and disabled fields are preserved. The author is read back after writing. Unsupported metadata writes fail that photo group and remove its new copies rather than silently pretending the metadata was applied. Support for other RAW formats and their Windows property handlers varies. This was verified through Windows’ actual `System.Author` and `System.Rating` properties for the user’s Sony ARW/JPEG; it is not a guarantee for every RAW codec.

Existing exports are skipped by the normal no-overwrite rule, so enabling embedding applies to fresh copies. This application does not automatically rewrite arbitrary existing exports or originals.

## Preview pipeline

- RAW extensions recognized: CR2, CR3, NEF, NRW, ARW, DNG, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, IIQ, RWL. Camera-specific support depends on ExifTool preview extraction and LibRaw decoding; recognizing an extension does not guarantee support.
- Embedded candidates include `JpgFromRaw`, `PreviewImage`, `OtherImage`, `ThumbnailTIFF` and `ThumbnailImage`, plus a same-stem companion JPEG. Thumbnail requests favor small images; review/zoom requests seek larger representations. Already-extracted candidates are selected by dimensions. Unusable candidates are recorded so they are not repeatedly extracted.
- Settings → General's **RAW rendering** setting persists: **Missing previews** (default), **Missing or small previews**, or **Off**. Off ignores previous RAW renders. Missing renders only if no valid embedded/companion image exists. Small also renders if the selected representation falls below the requested resolution; a usable thumbnail always remains a fast stand-in. A failed upgrade keeps the smaller preview visible.
- Rendering uses LibRaw 0.22.1 in an isolated single-threaded WASM worker, with camera white balance, sRGB 8-bit output and bilinear interpolation. Fit requests use half-size development; zoom requests use full-size development. This implementation differs from Photo Mechanic's inspected Adobe DNG Converter path. Colors and detail can differ from the camera JPEG or an editor's RAW processing.
- Only one sensor render runs at once, separately from the three ordinary image jobs and two extraction jobs. Each render has a 45-second deadline, a 256 MiB source-file limit and a 160 MP reported-image limit. Workers are disposed after each render. The first sensor render is much slower than reading an embedded JPEG; WASM starts with a 256 MiB heap, with additional decoder/image buffers during development.
- Rendered JPEGs persist separately from resized previews. Keys include source path, fingerprint, decoder version and half/full profile; a full render can satisfy a smaller request. Unsupported/corrupt files get persistent failure records. Timeouts/worker failures have a 60-second cooldown; source/storage/cancellation failures do not blacklist. **Retry preview** clears the failure and rechecks candidates; reopening a modified source gives it a new identity. Cached smaller fallback images can still require explicit retry after a temporary failure.
- sharp/libvips handles JPEG decode, shrink-on-load, all eight EXIF orientations, and sRGB conversion. TIFF, PNG and WebP originals can also be browsed. RAW parent orientation is used when an embedded image has none. When ExifTool supplies usable JPEG/TIFF offsets, PhotoCull reads a bounded byte range directly; invalid ranges fall back to ExifTool extraction.
- A 400 px thumbnail appears before the 2560 px fit preview. The loupe asks for the full-size representation only when the drawn photo needs more than 2560 device pixels (zoom, or Fit on a very large display). It reuses anything already loaded that is at least as large as the drawn size (scaling down, never up), and while a larger one loads it shows the best one it has, so zooming shows pixels at once.
- Fit previews are prepared for the next five photos in the direction you are moving and one behind (plus the next full-size image when the view needs full size). They have lower priority than the photo on screen, run at most two at a time so the on-screen request never waits for a connection, and are canceled when obsolete. If you leave a photo within 0.25 s (a held or quickly tapped arrow key), the next photo shows cached previews at once but only requests new work after it has stayed 0.12 s. Pending work for photos you have passed is dropped. Running jobs finish, except shutdown aborts the active sensor render. The grid mounts only nearby rows; capture metadata is lazy.
- A full-size request for an upright embedded or original JPEG is served as is rather than decoded and re-encoded (about 9 ms instead of about 255 ms for an A7C II `JpgFromRaw`).
- The compressed-image memory cache targets 96 MiB, libvips 48 MiB, and the shared image/render disk cache defaults to 2 GiB. Settings → General offers 1, 2, 5 or 10 GB, shows current use and has **Clear preview cache**. Pruning removes the least recently used files first (reading a cached preview or render refreshes it). It runs at most once a minute, and immediately when the limit is lowered. Entries from the last minute are protected, so the limit is soft. Failure records are retained until retry/source-identity change; clearing the cache removes them too, so blocked RAWs are retried. Browser/GPU memory and in-flight RAW buffers are additional.

On Windows, card discovery queries mounted removable/fixed volumes, then checks removable roots and DCIM folders. This also accommodates USB readers reported as fixed drives. On macOS, external mounted volumes under `/Volumes` are identified with `diskutil`; internal volumes and disk images are excluded. On Linux, mounted removable/USB/MMC partitions are discovered via `lsblk`; WSL additionally checks accessible Windows drive mounts. Empty/unmounted readers and phones exposed only through MTP are not supported. Discovery only reads directory information; automatic formatting/ejection is not implemented. A disconnected-card notice preserves the current decisions.

App state keeps the same per-user data directory as before the Tauri port (`%APPDATA%/PhotoCull` on Windows, `~/Library/Application Support/PhotoCull` on macOS, `~/.config/PhotoCull` on Linux), so existing settings and sessions carry over. `sessions/` contains autosaved decisions; `previews/` contains disposable image caches. External XMP is read for files without matching saved decisions. An existing local decision takes precedence; automatic detection of later external sidecar edits is not implemented. Reopening the folder rescans source identities.

## Validation and packaging

```sh
npm test
npm run test:ui
npm run benchmark
npm run build
```

`npm test` checks loupe geometry (zoom around a point, pan clamping, click vs drag, zoom steps, position carried to the next photo), direction-aware prefetch ordering and representation choice, pairing, deletion planning and decision cleanup, autosave/undo, sidecar preservation, scheduling, orientation, candidate selection, render gates, cache recovery, failure persistence, retry and cancellation. Set `PHOTOCULL_RAW_FIXTURE` to a real RAW file to enable its source-checksum and embedded-preview test. `scripts/ui-smoke.cjs` uses `scripts/launch.cjs` to start the backend in browser mode and headless system Chromium with isolated test state and generated photos; if `artifacts/fixtures/iss030e122639.NEF` exists it also exercises RAW display. Set `CHROMIUM_PATH` to override the Chromium executable. Playwright cannot drive Tauri webviews, so these checks do not cover native dialogs, menus, Trash or real desktop fullscreen. For the user-authorized Sony test copies, reproduce preview stripping and browser UI checks with:

```sh
node scripts/prepare-raw-cases.cjs /mnt/c/Users/alex/Pictures/photo-samples
PHOTOCULL_RAW_CASES=/mnt/c/Users/alex/Pictures/photo-samples/photocull-cases npm test
node scripts/raw-ui-smoke.cjs - /mnt/c/Users/alex/Pictures/photo-samples/photocull-cases artifacts/raw-validation
```

The preparation script expects the specific Sony `sample-8563.ARW` and verifies preview ranges do not overlap its sensor strip before zeroing JPEG payloads in new copies. It is a test helper, not a general RAW editor. The first `raw-ui-smoke.cjs` argument is retained for compatibility; the launcher always uses browser mode. Test photos, screenshots and reports are ignored by Git.

The benchmark reports scan, cold decode, memory-cache and disk-cache timings for generated JPEGs, or a supplied folder (`npm run benchmark -- /path/to/photos`). For the loupe, `node scripts/loupe-benchmark.cjs RAW_FOLDER` times the fit preview and the full-size representation of real RAWs in the backend. `node scripts/loupe-timing.cjs RAW_FOLDER` measures, in headless Chromium, the time from a key or click to the decoded image on screen for opening, next photo, click zoom, next photo while zoomed and a held-arrow burst, and counts the requests the burst issued. `scripts/viewer-ui-smoke.cjs - REPORT_FOLDER [SONY_FOLDER]` exercises the loupe: click zoom under the cursor, click vs drag, pan clamping, Z/Space/hold-Space, Ctrl +/-/0, Ctrl+wheel and scroll, Fill, the navigator, next photo keeping the zoom, fullscreen and the centre-on-click setting. These are backend measurements, not a Photo Mechanic comparison or a measurement of screen presentation latency. See [validation notes](docs/validation.md) and the [measured performance audit](docs/performance.md).

Checks and builds run locally: `npm test` and `npm run test:ui` before committing, `npm run build` on each machine for installers (Windows `.msi`/`-setup.exe`, Apple Silicon `.dmg`), uploaded to GitHub releases with `gh release`. The GitHub Actions workflow in `.github/workflows/build.yml` is commented out. The Tauri shell uses the system webview, while the bundled Node sidecar, sharp, ExifTool and WASM RAW decoder still add distribution size. Bundles are unsigned and not notarized.

## Research and REA

See [Photo Mechanic investigation](docs/photomechanic-research.md) for observed binary evidence, inferred design principles, and limits. This implementation is written in this repository using general image-processing techniques; it does not include Photo Mechanic code or binaries.

REA 6.8.0 is registered in this machine’s Codex configuration, with its workflow skill and a Linux Node PATH override. A separate MCP client verified initialization, all 229 advertised tools, and PE import inspection of the supplied executable. Restart/reconnect the coding agent to load REA into its tool list. The initial MVP investigation used static import/string inspection; the subsequent [RAW-loading investigation](docs/raw-loading-investigation.md) added local Ghidra 12.1.4/JDK 21 tools and traced the actual native loader and Windows rendering fallback through a separate REA session.
