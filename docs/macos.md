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

The outputs are `src-tauri/target/release/bundle/macos/PhotoCull.app` and a `.dmg` under `src-tauri/target/release/bundle/dmg/`. Build natively because sharp and ExifTool include platform-specific binaries. [.github/workflows/build.yml](../.github/workflows/build.yml) includes separate Apple Silicon and Intel Mac jobs.

## Opening an unsigned build

Bundles are unsigned and not notarized. Move `PhotoCull.app` to Applications, then right-click it and choose **Open**. If quarantine still prevents opening a trusted local build, remove its quarantine attribute in Terminal using the actual app path:

```sh
xattr -dr com.apple.quarantine "/Applications/PhotoCull.app"
```

Allow removable-volume access when macOS requests it. Camera cards mounted under `/Volumes` are discovered through `diskutil`; internal and disk-image volumes are excluded. Empty/unmounted card readers do not appear. Camera-card sessions allow only permanent deletion, not Move to Trash.

## Desktop behavior

- Native application/File/Edit/View/Window menus and Command shortcuts.
- `Cmd+O` opens a folder; `Cmd+,` opens Settings; `Cmd+Q` quits.
- The custom Edit menu routes `Cmd+Z` and `Cmd+Shift+Z` to PhotoCull decision undo/redo. Deletion cannot be undone in PhotoCull.
- `Ctrl+Cmd+F`, `F` or `F11` toggles native fullscreen. Zoom, culling and export use the same workflow as Windows. In Picks, `Del`/`⌫` opens the deletion prompt and `Enter` confirms.
- Settings, sessions and caches remain under `~/Library/Application Support/PhotoCull/`, so existing data carries over from the previous app. Open Settings → Open settings folder for the exact location.

## Validation limits

**Native Tauri launch on a Mac has not been verified yet.** Permissions, native menu shortcuts, fullscreen, removable-card discovery, bundled module loading and deletion still need native validation. Browser-mode smoke tests exercise the shared renderer and backend in Chromium; they do not drive WKWebView or verify native shell behavior. The Mac CI jobs build bundles, but their UI tests also use browser mode.
