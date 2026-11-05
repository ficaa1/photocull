# Validation

Local tests use generated photos, public test fixtures, or the user-authorized disposable Sony test copies; the proprietary executable is only a research input. Generated images, source fixtures, reports, screenshots and portable builds are ignored by Git.

## 0.7.0 — Tauri port and deletion (2026-11-05)

Unit tests passed 54/54: 52 existing tests plus two new deletion tests. Browser-mode ui-smoke passed, including the delete-rejects and delete-pick-prompt flows. Viewer smoke passed.

The desktop shell now uses Tauri 2 with a bundled Node sidecar. UI smoke tests run the shared renderer and backend in headless system Chromium through `scripts/launch.cjs`; they do not cover native dialogs, menus, Trash or real desktop fullscreen.

Native Tauri launch (Linux x86_64, Ubuntu host, Xvfb, 2026-11-05):

- `npm run build` produced `PhotoCull_0.7.0_amd64.deb` (70 MB) and an `.rpm`. AppImage bundling failed in `linuxdeploy` on that host (probably no FUSE); not yet confirmed in CI.
- The installed `.deb` starts, spawns the bundled Node backend and renders previews from the 127.0.0.1 image server.
- Ctrl+O opens the GTK folder dialog; scanning and keyboard culling (P/X) work.
- Rejects → "Delete 2 rejects" → Move to Trash moved both files into the freedesktop Trash with `.trashinfo` entries; counts updated.
- Picks → Delete shows the confirm prompt; Enter moved the pick to Trash.
- With `PHOTOCULL_NODE=/bin/false` the app shows a "PhotoCull could not start" error dialog and exits with code 1 after OK.
- Not yet run natively: macOS, Windows, and permanent deletion from a camera card.

## Develop, Dehancer and export (2026-11-05)

Validation used Windows 11 and disposable Sony ILCE-7CM2 + FE 40mm F2.5 G ARW/JPEG fixtures.
The native checks used `tauri dev`; Linux/WSL browser smokes exercised the shared renderer/backend.

- Fixture-enabled Node suite: **91/91 passed**, no failures or skips.
- All nine UI smokes passed: viewer, settings, copy export, culling, baseline UI, redesign, Develop, finished-image export and RAW previews.
- Windows `cargo test`: three library tests passed; binary/doc tests passed. `cargo build` passed with no compiler warnings.
- Native end-to-end: folder picker → loupe/Navigator/retained zoom → two picks → Develop recipe, exposure, histogram/clipping and copy/paste.
- Send to Dehancer produced two 7008 × 4672, profiled 16-bit sRGB TIFFs and opened the real Lightroom plugin sequentially.
- Cancel left the first TIFF unchanged; saving the second applied Kodak Pro Image 100, produced an 8-bit TIFF and updated its edit badge.
- Mixed RAW/Dehancer JPEG (1600 × 1067) and JXL (1200 × 800) batches each reported two exported, zero skipped/failed.
- All four exports decoded; ExifTool verified camera/lens metadata, and decoded images were visually inspected.
- Reopening preserved picks and TIFF/edit badges; native shortcut, input scope, fullscreen and sidebar checks passed.
- The separate 28-image export matrix covered JPEG, lossy/lossless JXL, TIFF, PNG, AVIF and WebP from RAW and Dehancer sources.
- Readback verified dimensions, bit depths, profiles/color declarations, metadata policies, Display P3 and JPEG size limits; AVIF used sharp/libheif.
- Skip-existing reported three skips; AVIF cancellation left no destination/partial images. Original photos and source TIFFs retained their hashes.

Single-run Windows timings (development build; caches/automation affect results):

- Two full-resolution TIFFs plus first Dehancer launch: **6.003 s**; two-image JPEG export: **4.891 s**; JXL: **4.634 s**.
- Full-image click zoom: 0.117 s; next photo at retained zoom: 0.027 s; first Develop settled frame: 1.151 s.
- Earlier native Develop report: warm draft rendering about 49 ms (request about 63 ms); a warm settled render took 125.5 ms (request 167.4 ms).
  These preview samples come from the local `develop-ui-test/real-develop-report.json`, separate from the merged end-to-end timings.

Known limits: lens database download, removable-card destination choice and Dehancer Skip/Stop were verified only with mocks.
The FE 40mm F2.5 G lens profile lacks vignetting correction; manual controls remain available.
Exports run sequentially; full-size AVIF samples took 24.6–32.9 s, and WebP is lossless-only.
Reading Dehancer TIFFs emits a harmless libtiff unknown-tag-317 warning; decode/export checks passed.
macOS pinch zoom and native macOS/Linux exports remain unverified; release/installer performance and colorimetric equivalence were not tested.
Reports/screenshots remain local under ignored `artifacts/`; disposable Windows test/spike outputs were removed after validation.

## Checked behavior

- Unit/integration tests cover RAW/JPEG pairing, natural sorting, source-identity invalidation, local decision persistence, undo/redo, optional recursion and symlink avoidance.
- XMP tests verify namespace handling, preservation of creator metadata, recoverable backups, refusal of malformed input, conflicting sidecar paths, leaving unedited sidecars intact, and exporting explicitly cleared decisions.
- Scheduler tests cover current-image priority, deduplication and stale-work cancellation. Image tests cover all eight EXIF orientations and memory/disk reuse.
- A real Nikon D3S NEF and Canon 40D sRAW CR2 both yielded usable embedded JPEG previews without changing their source checksums.
- The Electron smoke test opens the actual desktop app in WSLg, displays the NEF preview, makes keyboard decisions, tests auto-advance/undo/redo/zoom/filter/search, verifies a virtualized grid, exports XMP, and reopens the session with decisions restored. Screenshots are retained locally for review.
- Native Windows Node.js tested the **packaged Windows** sharp and ExifTool dependencies against JPEG and NEF inputs, verified source immutability, wrote sidecars and restored decisions.
- The actual Windows executable was then launched from `C:\Users\alex\Downloads\PhotoCull-MVP`. Its GUI displayed a RAW embedded preview, accepted keyboard ratings/picks/rejects and exported two XMP sidecars with no renderer errors. The automated check closed its window and removed isolated test state. Launching Chromium directly from the WSL UNC network share failed to start its GPU subprocess; use the copy on a local Windows drive.
- `npm audit` reported no known vulnerabilities after updating the packaging dependency.

Version 0.2.0's Linux suite passed all 21 tests with the Nikon embedded-preview fixture and a Sony ARW whose embedded JPEG payloads were zeroed. The Sony copy's TIFF metadata and 38,854,176-byte sensor strip were preserved. Rendering off refused that file; rendering on produced a 2560 px fit image and a 7028 × 4688 full image without modifying the input. Synthetic tests exercise TIFF-only embedded previews, render deduplication, disk corruption recovery, persistent blacklists, changed identities, retry, timeout cooldown, and shutdown cancellation.

The RAW GUI smoke test passed on WSLg and against the actual native Windows 0.2.0 executable: off/on gating, previewless Sony development, full-size zoom, restart cache reuse, small-thumbnail upgrade, corrupt-file retry, restart blacklist suppression, and saved policy. Real stripping cases are under the user-authorized `C:\Users\alex\Pictures\photo-samples\photocull-cases`; only new copies in that subfolder were changed. RAW GUI reports/screenshots are in `artifacts/raw-validation/raw-ui-linux.json` and `artifacts/raw-validation/raw-ui-win32.json`. Both runs reported zero renderer errors. The Windows 0.2.0 baseline GUI check also passed keyboard decisions and XMP export. The new portable copy is `C:\Users\alex\Downloads\PhotoCull-MVP-0.2.0\PhotoCull.exe`; the earlier running build was not replaced or stopped. Structured GUI checks are saved locally in `artifacts/ui-smoke.json`, `artifacts/windows-smoke.json` and `artifacts/windows-ui-smoke.json`.

## Culling handoff in 0.3.0

All 31 tests passed with both real RAW fixture options enabled. New transfer tests cover picked-only byte-for-byte copies, default RAW-only handling of pairs, optional companion JPEGs, generated destination XMP, preservation of source metadata, nested duplicate filenames, no-overwrite behavior, source changes, companion changes, malformed metadata, conflicting sidecar paths, symlinks, concurrent-operation refusal, and cancellation after copying has begun.

The actual Electron GUI passed on WSLg and native Windows using isolated copies of the user's Sony images. A simulated card insertion auto-opened DCIM recursively. The GUI copied one pick while the Rejects filter was active, compared the copied RAW's SHA-256 with the source, included a companion JPEG and 5-star destination XMP, and verified the source directory acquired no sidecars. Repeat export skipped existing files; inserting another card preserved the current cull; removal showed a disconnected notice. Both runs reported zero renderer errors. Reports and screenshots are under `artifacts/culling-validation/`.

Native Windows drive discovery was also executed against real mounted drives and found the user's camera card at `D:\DCIM` (`windows-device-discovery.json`). Hardware insertion/removal was simulated for GUI testing; no files on the real card were modified. The Windows keyboard/XMP baseline GUI test passed again.

The 0.3.0 update replaced application resources inside the existing `C:\Users\alex\Downloads\PhotoCull-MVP-0.2.0` folder. It reused the existing Electron runtime and did not stop the user's running instance. A restart loads the new resources; the folder name is retained intentionally.

To reproduce the new GUI test on Linux:

```sh
node scripts/culling-ui-smoke.cjs - artifacts/culling-validation /mnt/c/Users/alex/Pictures/photo-samples
```

For native Windows, run that same script with Windows Node.js, substituting the installed executable for `-` and using Windows paths for the report and fixture folders. Hardware volumes are queried read-only; simulated card files and all copy tests use disposable temporary directories.

## Settings and naming in 0.4.0

The full Linux suite passed all 36 tests with both real RAW fixtures enabled. New checks cover migration from the legacy settings file, serialized preference writes, custom preset persistence, metadata write gates, creator/rights/caption/keyword XML, keyword merging, color undo/reopen/export, capture/export date templates, sequence padding, unsafe-name rejection, renamed RAW/JPEG/XMP grouping, and naming-collision refusal. The existing transfer test now verifies that an imported Blue color remains independent of a later pick decision.

The settings GUI test passed on WSLg and the native Windows executable using temporary copies of the user's Sony files. It edited a custom palette, creator/copyright/keywords and an export template; saved a named Travel preset; applied an independent color through the keyboard; filtered by color; checked the live EXIF-date filename preview; and copied the matching `Trip_20260926_007.ARW`/`.JPG`/`.xmp` set. The XMP contained the custom label and metadata. Restart preserved settings, preset, copy defaults and image color on both platforms; Cancel discarded a draft; built-in/custom preset switching worked. Compact-copy and color-settings screenshots and structured reports are retained in `artifacts/settings-validation/`.

The baseline Electron GUI, culling handoff and previewless-RAW rendering GUI checks also passed with the controls moved into Settings. The native Windows baseline and culling handoff checks passed again. An additional settings recovery test passed for corrupted settings and a deleted active preset, bringing the unique test count to 37. Metadata-only exports are now in Settings → Metadata. No camera-card originals were modified. The existing portable folder was updated to 0.4.0 in place without replacing the Electron runtime or stopping the running user instance.

## Folder layout and embedded metadata in 0.4.1

Copy layout now defaults to direct files, with explicit named-subfolder and preserved-source-folder options. New tests verify grouping, collisions when flattening, safe folder names, symlink refusal, metadata-failure rollback, preset persistence and migration of an existing creator preference. The full pre-JPEG-integration run passed 42 tests; an additional real JPEG metadata test passed, bringing the unique test count to 43. That JPEG test checks creator/rating/label preservation, keyword merging and byte-identical decoded pixels.

The export GUI check passed on Linux and the native Windows application using disposable copies from the authorized Sony test folder. It exported directly from a simulated `DCIM/100MSDCF` card with no added folder, embedded `Filip Biljic` with XMP disabled, verified embedded creator/rating, and compared the RAW’s entire sensor-strip checksum before/after embedding. The sensor payload and source file were unchanged. Named output grouped the ARW and XMP; preserve mode reproduced the camera directory; switching embedding off restored byte-identical copies. Reports are under `artifacts/export-validation/` (`export-ui-linux.json` and `export-ui-win32.json`). Both reported zero renderer errors. The native Windows settings/preset/naming GUI regression also passed.

The Windows GUI export test queried Windows Shell properties for its newly copied ARW and JPEG and verified both author values. A separate Windows Shell property-handler query of an embedded Sony ARW returned `System.Author = ["Filip Biljic"]`, `System.Rating = 99` (five stars), the embedded title and keywords. This checks the same property system used by Explorer, rather than merely trusting ExifTool’s readback. Metadata embedding uses ExifTool only on destination copies, never the source/card.

## Zoom and fullscreen in 0.5.0

All 47 tests passed with real Nikon/Sony RAW fixtures enabled. New geometry tests cover landscape/portrait fit, small-image centering, percentage scaling, edge clamps, click-to-image coordinate mapping, replacement of a small preview by a full-size representation, and zoom preference validation.

The viewer GUI test passed on WSLg and the actual native Windows executable with generated 3600 × 2400 and 2400 × 3600 images, a small JPEG, and the user's disposable Sony ARW. It verified click-to-zoom, drag displacement without accidental fit toggling, 200% dimensions, click-to-fit, remembered zoom level, native fullscreen dimensions, bottom-edge filmstrip reveal, thumbnail selection, auto-hide on pointer exit, fullscreen portrait panning, ratings, Escape behavior, F11, real RAW full-size zoom and persisted percentages after restart. No renderer errors were reported. Native fullscreen preserves zoom and center across viewport changes. The Windows baseline keyboard/XMP GUI check also passed. Reports and screenshots are under `artifacts/viewer-validation/`.

The existing WSLg baseline GUI and previewless-RAW rendering checks also passed with the new image viewport and controls. All GUI tests use isolated application state and disposable copies. The existing portable Windows folder is updated in place; restart loads the new frontend and fullscreen IPC.

## macOS and performance work

The full shared-code test suite passed all 52 tests with the real Nikon fixture and preview-stripped Sony enabled. These include disappearing Mac volumes and saves queued during an active write. The final plist parser additionally passed the targeted device/package tests, including escaped Unicode volume names. macOS tests use diskutil plist fixtures on Linux and do not imply hardware validation. Apple Silicon/Intel app bundles were cross-built with architecture-specific Sharp and inspected by `scripts/inspect-macos.cjs`; they have not been launched on macOS. A Mac CI workflow was added but has not been run in this session. See [Mac setup](macos.md).

The before/after audit used three Sony ARWs and synthetic large-session workloads. RAW preview requests with fresh app caches avoided ExifTool binary extraction by validating and reading byte ranges. Queued decisions shared durable session snapshots; natural filename comparison reused an Intl.Collator. Tests verify corrupt-range fallback and that all coalesced/late decisions survive reopening. Details, methods and limitations are in [the performance report](performance.md).

## Redesigned interface in 0.6.0

The redesign and baseline Electron GUI checks passed on Linux. Native Windows checks passed against the installed 0.6.0 executable for the redesign, viewer, export, settings and culling workflows. Checks cover collapsible panes, persistent grid density, retained thumbnail nodes, compact layout, normal Tab/Shift+Tab focus navigation, Space button activation, zoom/fullscreen and filmstrip auto-hide. Export checks also verified Windows Authors, rating, flat/named/preserved folders and source sensor checksums. All runs reported zero renderer errors. Reports and screenshots are retained in the corresponding `artifacts/*-validation/` directories. The existing Windows portable folder was updated in place without stopping the user's running instance. See [UI redesign](ui-redesign.md).

## Timing methodology

`npm run benchmark` creates 48 generated 1800 × 1200 JPEGs, including an EXIF-rotated image. It measures a directory scan, then sequential fit-preview creation, repeated reads from the same in-process cache, and reads from a fresh PreviewService sharing the disk cache. The 2560 px fit limit does not enlarge those smaller originals.

The first recorded WSL/Linux x64 run with Node 24.22.2 scanned all 48 files in 10.15 ms. Cold fit-preview work took 943.28 ms in total (median 19.55 ms; p95 22.39 ms), and a new service read the cached representations from disk in 9.30 ms total (median 0.17 ms; p95 0.39 ms). These generated, easily compressed JPEGs are a smoke benchmark, not a claim about a real shoot or Photo Mechanic. OS file-cache state was not controlled. Sub-millisecond in-process cache hits are dominated by timer resolution and omit the browser's image decode and screen presentation.

A separate cold NEF check extracted a 4256 × 2832 `JpgFromRaw` image from the public Nikon fixture. Initial extraction plus thumbnail generation took approximately 189 ms on this host. Producing the fit preview from that already-extracted source took approximately 69 ms. This is one file and one run, not a representative RAW benchmark. Saved structured benchmark output is in `artifacts/benchmark.json`.

To measure your actual shoot without modifying its photos:

```sh
npm run benchmark -- /path/to/a/photo/folder
```

The benchmark samples at most 48 logical images and uses a temporary cache. It records failures explicitly and does not write XMP or decisions into the supplied folder.

## Public RAW fixtures

Local RAW checks used files from the [rawpy test directory](https://github.com/letmaik/rawpy/tree/main/test): `iss030e122639.NEF` and `RAW_CANON_40D_SRAW_V103.CR2`. Those fixtures are not redistributed in this repository or packaged app. Download a test image separately or supply a camera file via `PHOTOCULL_RAW_FIXTURE` to reproduce the RAW test.

## Current limits

- RAW development for Develop and finished-image export uses the pinned Lightcraft engine. Culling prefers embedded previews/companion JPEGs and retains the fast LibRaw fallback for missing or small previews. First renders are slower and use more memory than embedded previews. Camera support, colors and lens corrections vary. The fixture coverage does not certify every recognized RAW extension.
- Explicit deletion is supported; PhotoCull cannot undo it. No ingestion, catalog, compare view, automatic duplicate detection, AI scoring, GPU decode optimization, or live folder watcher.
- The disk-cache limit is soft; Chromium's decoded/GPU image memory is additional to the application caches.
- No verified speed comparison with Photo Mechanic. Larger shoots, unusual RAW formats, network storage and external XMP edits need further testing.
- Bundles are unsigned and not notarized. Tauri uses the system webview, but the bundled Node sidecar and native image-processing dependencies still add substantial distribution size.
