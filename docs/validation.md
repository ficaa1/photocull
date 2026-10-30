# Validation

Local tests use generated photos, public test fixtures, or the user-authorized disposable Sony test copies; the proprietary executable is only a research input. Generated images, source fixtures, reports, screenshots and portable builds are ignored by Git.

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

- RAW development uses a fast LibRaw configuration rather than an editor-quality pipeline. First renders are slower and use more memory than embedded previews. Camera support, colors and lens corrections vary. The fixture coverage does not certify every recognized RAW extension.
- No destructive file operations, ingestion, catalog, compare view, automatic duplicate detection, AI scoring, GPU decode optimization, or live folder watcher.
- The disk-cache limit is soft; Chromium's decoded/GPU image memory is additional to the application caches.
- No verified speed comparison with Photo Mechanic. Larger shoots, unusual RAW formats, network storage and external XMP edits need further testing.
- The portable Windows build is unsigned. Electron makes the distribution substantially larger than a native application with equivalent functionality.
