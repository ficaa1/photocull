# External editors

The user workflow and editor setup are described in [External editors](../README.md#external-editors) and the [detailed workflow](workflow.md#editing-in-other-apps).

## Launching and protecting files

- Preferences store `editors` and `defaultEditor`. Dehancer is a resettable built-in preset; executable paths and arguments remain editable. Legacy `dehancerExe` and `dehancerFolder` settings migrate without discarding the selected application or destination.
- Sessions store `editedBy`, the current `tiff` path (retained as the field name for compatibility, including PNG/JPEG hand-offs), and a history of hand-off records. Old `develop.edited` sessions remain readable; new writes use `editedBy`. RAW adjustments remain independent of external edits.
- Arguments are JSON arrays. Rust substitutes `{file}` or expands a whole `{files}` argument, then launches directly with `Command`. The renderer supplies an editor id; the backend resolves its saved configuration. Multi-file editors require `{files}`.
- Exit mode waits for the launched process and compares size/mtime. Watch mode polls every 75 ms and reports changed, nonempty files after one second without writes. A hand-off finishes after all selected files settle or the launched process exits. Watch mode leaves the application running; a later hand-off starts a new detection interval. Saves must target the recorded path.
- macOS bundles use `/usr/bin/open -W -a <bundle> <files>`, with fixed application arguments after `--args`. Bundle file tokens must be separate arguments. Exit mode waits for the application to quit, including an existing instance. Stop terminates the `open` helper, leaving the application running.
- Destination names reserve sources, existing files, and other photos' current/archived hand-offs. Re-developing an externally edited current file requires confirmation in the dialog. Changing format or destination preserves earlier paths for cleanup.
- Cleanup derives every candidate from the current session's records. It rejects sources, source aliases, hard links, symlinks, and paths redirected since recording. Confirmation includes count, size and paths; unexported edits require a second warning. File stamps are checked again before deletion. Failed deletions remain recorded.
- Export records the hand-off's size/mtime before encoding. Only successful publication of the same version permits automatic cleanup; later saves remain unexported. Files changed after a stopped edit wait also receive the extra cleanup warning. Automatic cleanup is off by default and retains previous hand-offs and failed/skipped export inputs.
- PhotoCull suspends hand-off previews and releases libvips input caches around replacement, external editing and cleanup. This avoids retained Windows read handles preventing replacement/deletion. Short-lived file locks receive bounded retries; persistent failures are reported without deleting records.

## Validation and limits

Browser smokes cover editor settings, default/alternate actions, selection in the contact sheet, Review and filmstrip, formats, destinations and cleanup warnings. Run `node scripts/develop-ui-smoke.cjs` and `node scripts/image-export-ui-smoke.cjs`.

On Windows, `node scripts/editors-windows.cjs EXECUTABLE COPIED_RAW_FOLDER` exercises the real Tauri commands using temporary editors and isolated app data. It covers exit/watch detection, multi-file launch, arguments with spaces, saved-result attribution, edited export and cleanup. Read the script header before running it. The test editor modifies only temporary hand-offs and does not launch Dehancer.

Native readback has verified 16-bit uncompressed sRGB TIFF with ICC, 16-bit Display P3 PNG, 8-bit Display P3 JPEG, 16-bit Adobe RGB LZW TIFF and 8-bit ProPhoto Deflate TIFF. Source and fixture hashes were unchanged. These checks do not establish compatibility with every external editor. macOS bundle launching and waiting still require native integration validation.
