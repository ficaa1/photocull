<img src="assets/icon.svg" width="64" height="64" alt="">

# PhotoCull

PhotoCull is a local desktop app for culling photos, developing RAW files with editable adjustments, handing images to an external editor, and exporting finished images. It is a Lightroom replacement for that workflow: open a folder or camera card, choose keepers, adjust their RAW development, and finish them without importing a catalog or using a cloud service.

[Project page](https://www.filipbiljic.com/photocull/) · [Downloads](https://github.com/ficaa1/photocull/releases) · [Documentation](docs/README.md) · [Changelog](CHANGELOG.md)

## Status and installation

PhotoCull is under active development. Windows is the locally validated desktop platform. Apple Silicon macOS is a packaging target, but native Mac launch, permissions and editor integration have **not yet been verified**. Intel Mac and Linux builds are manual; they are not validated release targets.

Download an installer for your platform from [Releases](https://github.com/ficaa1/photocull/releases):

- **Windows:** use the `.msi` or `-setup.exe` installer. Windows needs WebView2. Builds are unsigned, so SmartScreen may show an unknown-publisher warning; for a download you trust, use **More info → Run anyway** if Windows offers it.
- **macOS Apple Silicon:** open the `.dmg` and move PhotoCull to Applications. Builds are ad-hoc signed but not notarized, so the first launch needs **Open Anyway**. Read [macOS setup](docs/macos.md) for Gatekeeper steps and the validation limits before using the app.

The desktop bundle includes its Node runtime and image tools; Node and Rust are only needed when building from source. Use a backed-up folder for your first session.

## Quick start

1. **Open photos.** Choose **Open folder** or select a camera card under **Connected cards**. Welcome lets you choose before any card opens automatically. RAW + JPEG files with the same stem in the same directory are grouped when there is exactly one of each.
2. **Cull.** Use arrows to navigate, `P` to pick, `X` to reject, `U` to clear a flag, and `0–5` for stars. `G` opens the contact sheet and `E` opens Review. Flags advance to the next photo by default for a single selection. Shift-click selects a range; Ctrl-click (Cmd-click on Mac) changes individual selections. Decisions apply to the selection and can be undone.
3. **Back up a card.** Use **Back up card…** in Connected cards, or **Back up card or folder…** beside Open folder. This copies the whole hierarchy, including videos and sidecars, verifies it with SHA-256 and resumes identical files. **Copy picks** separately copies only picked originals to a chosen destination; companion JPEGs and hash verification are optional.
4. **Develop RAWs.** Press `D`, choose a recipe and adjust white balance, light, tone, lens corrections or detail. Adjustments autosave and leave the original image unchanged. Copy/paste settings or apply them to selected RAWs or all RAW picks.
5. **Edit in another app.** Configure an application in **Settings → External editors**, then use **Edit in…** or Ctrl/Cmd+E. PhotoCull develops a separate TIFF, PNG or JPEG and detects saves back to that file. A Dehancer preset is included.
6. **Export finished images.** Use **Export…** or Ctrl/Cmd+Shift+E. It defaults to all picks, or choose Current selection. Saved external edits are used when available; otherwise RAWs are freshly developed. Choose format, sizing, color space, metadata, names and destination.

`Delete` moves photos to PhotoCull’s in-app Trash without changing files on disk. Deleting from Trash, Empty trash, or Shift+Delete asks for disk deletion. That removes originals, paired JPEGs and associated XMP. Camera cards support permanent deletion only; ordinary folders also offer the system Trash/Recycle Bin. PhotoCull cannot undo disk deletion.

## What it does

### Review and choose

- Preview-first RAW browsing plus JPEG, TIFF, PNG and WebP. Recognized RAW extensions include ARW, CR2/CR3, NEF/NRW, DNG, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, IIQ and RWL; camera support depends on the decoders. HEIC, AVIF and JPEG XL are not imported.
- Contact sheet, filmstrip, fullscreen Review, pixel-relative zoom, pan and a navigator. Camera JPEG previews are labeled; optional LibRaw fallback develops missing or small previews.
- Picks, rejects, stars, eight customizable colors, filename search, filters, multi-selection and decision undo/redo.
- Recorded autofocus-point overlays and focus-centered zoom where metadata is supported. Burst stacks, background preview-detail scores and confirmed, undoable Keep sharpest. Scores estimate preview detail, not subject quality.
- Two-to-four-photo Compare with optional linked zoom and pan. Scoring needs the desktop shell; burst grouping and Compare also work in browser development mode.

### Back up and organize

- Resumable, hash-verified whole-card backups with explicit rechecking and a complete-backup status. A changed card or destination invalidates that status; recheck before formatting outside PhotoCull.
- Copy picked originals with folder layout, filename templates, optional companion JPEGs, destination metadata and verification. Existing files are skipped rather than overwritten.
- Local autosaved sessions, portable XMP state, metadata presets, settings import/export with preview and backup, and configurable camera-card folders.

### Develop, edit and export

- Lightcraft RAW development with Neutral, Camera look and Flat base recipes; per-photo adjustments, recipe duplication/import/export, interactive histogram, clipping warnings and draggable before/after split.
- Configurable external editors, hand-off format/color/destination settings, saved-result previews across views, and confirmed cleanup of recorded hand-off files.
- JPEG, JPEG XL, TIFF, PNG, AVIF and WebP export; sizing, output sharpening, color spaces, metadata/location controls, filename templates and saved export presets. AVIF remains comparatively slow. Export runs at half the logical core count, rounded down, with a minimum of one and maximum of three simultaneous photos.
- Generated previews are converted and tagged as sRGB; the system webview handles display color management. Original upright JPEG previews may pass through with their existing profile.

See the [workflow reference](docs/workflow.md) for zoom gestures, preview limits, naming, deletion and export options, and [recipes and export](docs/recipes-export.md) for formats and measured limits. Production display previews still use sharp/libvips; the [Rust preview investigation](docs/rust-display-previews.md) is an experiment, not a shipped replacement.

## Keyboard shortcuts

Ctrl/Cmd means Control on Windows/Linux and Command on macOS. Defaults are context-sensitive:

| Keys | Action |
| --- | --- |
| Ctrl/Cmd+O | Open folder |
| Arrows / Shift+arrows | Navigate / extend selection |
| P / X / U | Pick / reject / clear flag |
| 0–5 | Star rating |
| 6–9 / Alt+1–8 / Alt+0 | First four colors / any color / clear color |
| G / E / D / C | Contact sheet / Review / Develop / Compare |
| Z / Space | Toggle zoom in Review; Space opens Review from the grid |
| Ctrl/Cmd + plus / minus / 0 | Zoom in / out / Fit in Review or Compare |
| A / Shift+A / S | AF overlay / focus-centered zoom / expand burst |
| F or F11 | Fullscreen |
| B / I | Toggle Sources / Details |
| Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z | Undo / redo decisions |
| Delete / R in Trash | Move to PhotoCull Trash / restore |
| Ctrl/Cmd+E / Ctrl/Cmd+Shift+E | Edit in external app / export finished images |
| Ctrl/Cmd+K or Ctrl/Cmd+Shift+P | Command palette |
| Ctrl/Cmd+comma / ? | Settings / Help and current shortcuts |

**Settings → Keyboard** records, clears and resets bindings, with conflict checks. The command palette searches actions; type `>` and a filename to find photos even outside the current filter. Tab/Shift+Tab moves focus through controls. Open menus and dialogs own the keyboard. See [commands and settings](docs/workspace.md).

## External editors

**Edit in…** starts from RAW photos. In **Settings → External editors**, add a name, browse to the executable (or a macOS `.app`) and set arguments, for example `["{file}"]`. Use `["{files}"]` with **Open all selected files in one invocation** for an editor that accepts a batch. Arguments are passed directly without a shell. Choose **Watch file writes** for an editor you keep open, or **After application exits** for one that closes after editing. Save to the recorded hand-off path; Save As elsewhere cannot be detected.

The resettable **Dehancer** preset uses 16-bit uncompressed sRGB TIFF, one process per photo and exit detection. Dehancer must be installed separately; browse to it if its executable is not found. Hand-offs default to `_develop` beside ordinary source photos. Card sessions ask for a writable local folder. Cleanup is explicit; automatic cleanup after successful export is off by default. See [external editors](docs/external-editors.md) for configuration and safety details.

## XMP and Lightroom interoperability

Original image bytes are never changed by decisions, Develop or hand-offs. XMP files are separate:

- By default, PhotoCull autosaves XMP **beside photos in ordinary folders**, but **not on recognized camera cards**. **Settings → General → Write XMP sidecars** selects Always, Except camera cards (default), or Never. Use **Treat folder as card** for an unrecognized card folder, or choose Never before reviewing a read-only source library.
- Card copies generate XMP beside the **destination** photos by default, unless the policy is Never. For ordinary folder copies, the copy dialog’s XMP checkbox controls destination sidecars. Embedding metadata changes destination copies only.
- **Settings → Metadata → Export metadata → Write source XMP** is an explicit source-sidecar write command, including when automatic writing is Never. Selecting Always also opts into automatic card-sidecar writes. Neither writes metadata into original image files.

Sidecars use standard `xmp:Rating` and `xmp:Label` for ratings/rejects and labels. A label is not a universal Lightroom pick flag. PhotoCull also stores flags, original ratings, develop settings and hand-off records in its own namespace. Other applications do not interpret PhotoCull adjustments as their own RAW development settings.

Existing unrelated Lightroom/darktable/Capture One XMP content is preserved. PhotoCull reads both `name.xmp` and `name.ext.xmp`, respects existing naming, backs up an existing sidecar on first write, and reports malformed or ambiguous sidecars. Reopening a folder merges newer sidecar state with locally saved decisions; this is not live synchronization. Keep sidecars and any hand-off subfolder with the photos when moving between computers. See [sidecars and portability](docs/workflow.md#sidecars-and-moving-between-computers).

## Self-hosted server

PhotoCull can also run as a web app on a home server, next to a photo library, for culling from a phone, tablet or another computer on the network. Open a folder in the server's folder browser and it prepares thumbnails, previews and focus scores in the background, even with the browser closed. Delete moves photos to a dated server trash folder that is emptied after 30 days. Develop, external editors, export and camera cards stay in the desktop app. It ships as a Docker image with a `compose.yaml` template; see [PhotoCull server](docs/server.md).

## Local data and privacy

No account, telemetry or remote logging is used. Photo processing, sessions and diagnostics stay local. The app serves image bytes through a token-protected server bound to `127.0.0.1`; this is local traffic. The optional **Lensfun database download** makes outbound requests only when requested in the Lens panel. Project/license links open the system browser. External editors are separate applications with their own privacy behavior.

Settings, sessions, preview caches, backup records and rotating logs live here:

| Platform | Data directory |
| --- | --- |
| Windows | `%APPDATA%/PhotoCull/` |
| macOS | `~/Library/Application Support/PhotoCull/` |
| Linux | `$XDG_CONFIG_HOME/PhotoCull/`, or `~/.config/PhotoCull/` |

`settings/` holds preferences, recipes and presets; `sessions/` holds autosaved decisions; `previews/` is disposable; `card-backups/` holds verification records; `logs/` holds local logs. Open the settings or log folder from the app. The preview disk cache defaults to 2 GiB with a configurable soft limit and **Clear preview cache** in General. Pane layout is stored in the webview’s local storage.

The native Develop engine uses Tauri’s app-data directory under the identifier `app.photocull.desktop` for optional `lensfun/` data; decoded Develop images are held in memory. `PHOTOCULL_DATA_DIR` overrides both data roots for isolated testing. Diagnostics redact home-directory prefixes and tokens, but review them before sharing; exported settings and sidecars can contain metadata and paths.

## Build from source

Use **Node.js 24**, npm, a current stable Rust toolchain and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/): MSVC C++ build tools, Windows SDK and WebView2 on Windows; Xcode command-line tools on macOS; the distribution’s WebKitGTK 4.1/GTK development libraries and C/C++ tools on Linux. Use an official Node distribution for packaging; Homebrew Node is not relocatable.

```sh
git clone https://github.com/ficaa1/photocull.git
cd photocull
npm ci
npm start
```

`npm start` runs `tauri dev`. To stage the bundled sidecar and build native installers:

```sh
npm run build
```

Build on the target OS because sharp and ExifTool contain platform-specific binaries. Installers appear under `src-tauri/target/release/bundle/`. `npm run web` runs the shared renderer/backend in a browser using the token-bearing loopback URL printed in the terminal. Native Develop, editor hand-off, finished-image export, system Trash and dialogs need the desktop shell; browser-mode disk deletion is permanent.

Run local checks before contributing:

```sh
npm test
npm run test:ui
node scripts/workspace-ui-smoke.cjs
node scripts/develop-ui-smoke.cjs
node scripts/image-export-ui-smoke.cjs
npm run notices
cd src-tauri
cargo fmt --check
cargo test --locked
cargo build --locked
```

Browser smokes need system Chrome/Chromium; set `CHROMIUM_PATH` if it is not discovered. They use generated photos and temporary app data. They do not validate native webviews or dialogs. See [CONTRIBUTING](CONTRIBUTING.md) and [validation](docs/validation.md) for platform checks and optional disposable RAW fixtures. Checks and releases are run locally.

### Project layout

- `src/renderer/`: plain JavaScript UI using `bridge.js` for desktop/browser calls.
- `src/`: Node sidecar for scanning, previews, decisions, backups and copy planning.
- `src-tauri/`: Tauri shell for windows, native dialogs, deletion, Lightcraft Develop, external-editor launching and finished-image encoding. Its renderer method allowlist gates backend calls.
- `scripts/`, `test/`, `docs/`, `third-party/`: local validation/build tools, tests, reference docs and license inventory.

The shell and sidecar use JSON-lines RPC over stdio; images travel over authenticated loopback HTTP.

## Contributing, security and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and contribution guidelines. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

PhotoCull-owned code is [MIT licensed](LICENSE). Dependencies retain their own terms: sharp’s bundled libvips is LGPL-3.0; ExifTool and its native runtime have separate licenses; Lightcraft uses MIT/Apache-2.0 components. Optional Lensfun data is downloaded separately with attribution under CC BY-SA 3.0, never bundled. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [licensing requirements](docs/licensing.md), including corresponding-source requirements before redistributing installers. Regenerate the inventory offline with `npm run notices`.

Dehancer and Adobe Lightroom are trademarks of their respective owners. PhotoCull is not affiliated with or endorsed by them.
