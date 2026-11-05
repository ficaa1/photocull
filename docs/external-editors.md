# External editors

The user workflow and editor setup are described in [Editing in other apps](../README.md#editing-in-other-apps).

## Implementation decisions

- Preferences store `editors` and `defaultEditor`. Dehancer is a resettable built-in preset; executable paths and arguments remain editable. Legacy `dehancerExe` and `dehancerFolder` settings migrate without discarding the selected application or destination.
- Sessions store `editedBy`, the current `tiff` path (retained as the field name for compatibility, including PNG/JPEG hand-offs), and a history of hand-off records. Old `develop.edited` sessions remain readable; new writes use `editedBy`. RAW adjustments remain independent of external edits.
- Arguments are JSON arrays. Rust substitutes `{file}` or expands a whole `{files}` argument, then launches directly with `Command`. The renderer supplies an editor id; the backend resolves its saved configuration. Multi-file editors require `{files}`.
- Exit mode waits for the launched process and compares size/mtime. Watch mode polls every 75 ms and reports changed, nonempty files after one second without writes. A hand-off finishes after all selected files settle or the launched process exits. Watch mode leaves the application running; a later hand-off starts a new detection interval. Saves must target the recorded path.
- macOS bundles use `/usr/bin/open -W -a <bundle> <files>`, with fixed application arguments after `--args`. Bundle file tokens must be separate arguments. Exit mode waits for the application to quit, including an existing instance. Stop terminates the `open` helper, leaving the application running.
- Destination names reserve sources, existing files, and other photos' current/archived hand-offs. Re-developing an externally edited current file requires confirmation in the dialog. Changing format or destination preserves earlier paths for cleanup.
- Cleanup derives every candidate from the current session's records. It rejects sources, source aliases, hard links, symlinks, and paths redirected since recording. Confirmation includes count, size and paths; unexported edits require a second warning. File stamps are checked again before deletion. Failed deletions remain recorded.
- Export records the hand-off's size/mtime before encoding. Only successful publication of the same version permits automatic cleanup; later saves remain unexported. Files changed after a stopped edit wait also receive the extra cleanup warning. Automatic cleanup is off by default and retains previous hand-offs and failed/skipped export inputs.
- PhotoCull suspends hand-off previews and releases libvips input caches around replacement, external editing and cleanup. This avoids retained Windows read handles preventing replacement/deletion. Short-lived file locks receive bounded retries; persistent failures are reported without deleting records.
- No dependencies were added.

## Local validation, 2026-11-06

Rebased onto `12d3f29` (latest main at validation).

- WSL `npm test`: 112 passed, two optional camera-fixture tests skipped, zero failures.
- WSL `scripts/develop-ui-smoke.cjs`: passed, including editor settings, alternate/default actions, Ctrl/Cmd+E, grid/Review/filmstrip selection, multi-file watch configuration, hand-off formats, remembered/always destinations, configurable subfolder and cleanup warnings.
- WSL `scripts/image-export-ui-smoke.cjs` and `scripts/ui-smoke.cjs`: passed. Export smoke also verifies shared controls recover after automatic cleanup.
- Windows `cargo test`: 11 passed, zero warnings. `cargo build --bin photocull-editors`: passed, zero warnings. The test binary used the unchanged main entry point under a temporary alternate name because the shared `photocull.exe` was running for another task; that process was not stopped.
- Windows `test/editors.test.cjs`: 11 passed. The targeted preview-handle-release test also passed. An earlier full Windows Node run encountered existing tests requiring symlink privileges; the required full suite passed in WSL.
- Windows `scripts/editors-windows.cjs`: passed through the real Tauri commands with copied Sony RAWs, isolated settings/WebView2 directories, and temporary Node-based editors. Verified an unchanged Cancel, multi-file exit detection, watch detection while the editor remains alive, path/argument spacing, rejection of unsaved editor ids, saved attribution, edited export, automatic cleanup, and manual cleanup of current/archived files.
- Native format readback verified 16-bit uncompressed sRGB TIFF with ICC, 16-bit Display P3 PNG, 8-bit Display P3 JPEG, 16-bit Adobe RGB LZW TIFF, and 8-bit ProPhoto Deflate TIFF. TIFF compression tags were read directly. Source and copied RAW hashes were unchanged; no renderer errors occurred. Watch round-trip time was 3306 ms, including process/preview work.

The test editor only modifies temporary hand-offs. Dehancer was never launched. The owner's photos, application data and installed app were not changed. macOS bundle integration could not be run because the Mac was unavailable; its launch/wait behavior is documented above for follow-up validation.
