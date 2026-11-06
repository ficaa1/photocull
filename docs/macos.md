# macOS

PhotoCull uses a Tauri 2 shell with the system WKWebView and a bundled Node sidecar. Build on a Mac matching the target processor: Apple Silicon or Intel. Native Mac launch has not been verified yet.

## Build

Install Node.js 24, Rust stable and the Xcode command-line tools. Use an official Node build; Homebrew Node is not relocatable and cannot be used for the bundled sidecar.

```sh
npm ci
npm start
```

`npm start` runs the development shell using `node` on PATH and the checkout’s source. To stage the backend and build the app and disk image:

```sh
npm run build
```

The outputs are `src-tauri/target/release/bundle/macos/PhotoCull.app` and a `.dmg` under `src-tauri/target/release/bundle/dmg/`. Build natively because sharp and ExifTool include platform-specific binaries. Build the `.dmg` on the Mac itself; installer builds run locally.

## Opening a downloaded build

Bundles are ad-hoc signed but not notarized, so Gatekeeper blocks a downloaded copy the first time. Move `PhotoCull.app` to Applications and open it once. When macOS says it cannot verify the app, open **System Settings → Privacy & Security** within the hour, click **Open Anyway** and confirm. Right-click → **Open** no longer works for this on macOS 15 and later. Builds made on the same Mac are not quarantined and open directly.

Releases before 0.9.2 had no bundle signature, so macOS reports them as **damaged** and does not offer **Open Anyway**. For one of those builds you trust, remove the quarantine attribute in Terminal using the actual app path:

```sh
xattr -dr com.apple.quarantine "/Applications/PhotoCull.app"
```

Allow removable-volume access when macOS requests it. Camera cards mounted under `/Volumes` are discovered through `diskutil`; internal and disk-image volumes are excluded. Empty/unmounted card readers do not appear. PhotoCull’s in-app Trash does not touch disk. Confirmed disk deletion on camera cards is permanent; system Trash is unavailable for card sessions.

## Desktop behavior

- Native application/File/Edit/View/Window menus and Command shortcuts.
- `Cmd+O` opens a folder; `Cmd+,` opens Settings; `Cmd+Q` quits.
- The custom Edit menu routes `Cmd+Z` and `Cmd+Shift+Z` to PhotoCull decision undo/redo. Disk deletion cannot be undone in PhotoCull; moving to its in-app Trash can.
- `Ctrl+Cmd+F`, `F` or `F11` toggles native fullscreen. Zoom, culling and export use the same workflow as Windows. `Del`/`⌫` first moves a photo to PhotoCull’s in-app Trash. Deleting from that view or using Shift+Delete opens a disk-deletion prompt; `Enter` confirms.
- Settings, sessions and caches remain under `~/Library/Application Support/PhotoCull/`, so existing data carries over from the previous app. Open Settings → Open settings folder for the exact location.

## Validation limits

**Native Tauri launch on a Mac has not been verified yet.** Permissions, native menu shortcuts, fullscreen, removable-card discovery, bundled module loading and deletion still need native validation. Browser-mode smoke tests exercise the shared renderer and backend in Chromium; they do not drive WKWebView or verify native shell behavior.
