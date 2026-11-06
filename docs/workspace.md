# Commands, settings sync and card backup

Press Ctrl/Cmd+K or Ctrl/Cmd+Shift+P for the command palette. Type a few letters to search commands, use Up/Down and Enter to run one, and Escape to close. Recent commands appear first with an empty query. Type `>` followed by a filename to find a photo in the open session, including photos outside the current filter. Disabled commands remain visible with their shortcut.

Settings → Keyboard lists commands by category and view. Record a combination, clear a binding, or reset one/all to defaults. Conflicts are checked where commands share a view. Changes apply with Save; Cancel discards them. Help (`?`) and the palette show the current shortcuts. Text fields keep normal editing keys, and an open dialog owns the keyboard. Pointer gestures and focus navigation remain native controls. The declarative table in `src/renderer/commands.js` owns keyboard defaults, physical zoom-key aliases, search and help; add new view commands there with their action in `app.js`.

## Moving settings to another computer

Settings → Import / export writes a versioned JSON bundle containing preferences, user develop recipes, metadata presets, export presets, external editors and shortcuts. **Exclude machine-specific paths** is on by default; it removes remembered hand-off folders, manually configured card roots and editor application paths. Editor arguments are retained; review any arguments containing machine-specific paths before using them on the other computer.

On the second computer, choose the JSON, optionally enter path mappings, and select Preview import. Mappings are a JSON object such as `{"C:\\Tools":"/Applications", "C:\\Photos":"/Volumes/Photos"}`. The longest matching path prefix is replaced. The preview lists changed preference groups and recipe/preset counts. Missing editor applications are retained and marked **needs path** in External editors. Browse to the correct application before sending photos to it.

Import replaces the settings represented by the bundle; it does not merge conflicting recipes or presets. Before changes are written, the complete previous bundle, including machine paths, is saved in `settings/backups/`. It can be imported through the same UI to restore earlier settings. Validation completes before writes, a stale preview is refused, and a failed write attempts rollback from the previous bundle. Keep exported bundles private if they contain creator metadata or local paths.

## Welcome and local diagnostics

The first launch shows a nonmodal welcome with folder/card entry points, eight essential shortcuts and an external-editor setup link. Skip dismisses it permanently. Open it again from Help or the palette. Automated smoke tests suppress it unless `PHOTOCULL_TEST_WELCOME=1` is set.

Help → Copy diagnostics collects the app/OS/runtime version, webview user agent, inexpensive GPU/display color information, a small settings summary and up to 200 recent log lines. Home directory prefixes and server tokens are redacted. Review the copied text before sharing it; diagnostics stay on the machine until you choose to paste them elsewhere. Help → Open log folder reveals the local logs. Shell and sidecar logs each retain a current file and three rotated files of about 1 MiB each in the app data `logs/` folder. No telemetry or remote logging is used.

## Backing up an entire card

Use **Back up card…** in Connected cards, **Back up card or folder…** in the menu beside Open folder, or the palette. You can also choose an ordinary source folder. Select an existing destination outside the source and a folder template. Supported tokens are `{date}` (UTC backup date), `{card}`, `{year}`, `{month}` and `{day}`; the default is `{date}-{card}`. The complete source hierarchy is preserved under that folder, including videos, sidecars and other regular files.

Each source and destination is checked with streaming SHA-256. Identical existing files are verified and skipped, so running the same backup again resumes work. Different existing files are reported and never replaced: choose another backup subfolder or resolve the conflict yourself. Cancel keeps completed verified files and removes only the operation's incomplete destination files. Symbolic links and unreadable/special files prevent a complete verification claim. PhotoCull never formats or deletes source-card files during backup.

Verification records in the app data `card-backups/` folder contain volume identity, relative file paths, sizes, modification times, hashes and verified destination paths. A complete check shows **All N files backed up and verified — safe to format** on the card. Device refreshes compare the current source inventory and destination sizes/times with the saved verification record; new, changed or missing files remove that state and can be expanded in the sidebar. **Check verified backup** rereads every source and destination hash, including after possible corruption that preserves sizes/times. Empty cards never receive a safe-to-format claim. The state describes the last check: card/destination changes after a check require another check before formatting outside PhotoCull.

The full card copy performs additional reads for verification and can be slower than Copy picks. A 64 MiB temporary-file measurement is recorded in the implementation validation report; performance depends on the card, destination and OS cache. SHA-256 uses Node's built-in crypto and adds no dependency.

**Copy picks → Verify copied files** optionally compares original/source bytes (and generated XMP bytes) with destination hashes. When Embed metadata is selected, this byte verification runs before the deliberate metadata transformation. It does not establish a complete-card backup record.

Settings → General configures camera folder layouts, manual card folders and the default backup template. Layouts are relative, case-insensitive paths such as `DCIM` or `PRIVATE/M4ROOT`. **Treat folder as card** (menu beside Open folder, or the palette) adds the current folder, disables OS Trash for that session, and uses the card hand-off destination rules. Remove a manual root in General to stop treating it as a card on subsequent scans. Existing copy filename/folder defaults remain in File naming; finished-image names and subfolders remain in export presets.

## Local verification

Run `npm test`, `node scripts/workspace-ui-smoke.cjs`, `node scripts/ui-smoke.cjs`, and the existing Develop/settings smokes. The workspace smoke uses temporary settings, generated photos and a mocked camera volume. It verifies palette keyboard operation, shortcut conflicts/recording, customized help, import preview/backup, onboarding dismissal and complete/changed-card backup status. Node tests inject a corrupted copy and cover cancellation/resume. Windows also requires `cargo test` and `cargo build` in `src-tauri/`. None of these tests needs a real card.
