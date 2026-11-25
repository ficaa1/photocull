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

## Tethered capture (Sony α7 III & α7C II)

PhotoCull includes a macOS USB tethering engine over Apple `ImageCaptureCore` and Sony’s PTP/SDIO protocol for the **Sony α7 III (`ILCE-7M3`, SDI 200)** and **Sony α7C II (`ILCE-7CM2`, SDI 300)**, plus wireless **PTP/IP over Wi-Fi** (TCP 15740, with OpenSSH forwarding to camera-side `localhost:15740` when Access Authentication is enabled) for the **Sony α7C II**.

- **α7 III (USB only):** turn **Ctrl w/ Smartphone** off, set **MENU → Setup → USB Connection → PC Remote**, and choose **Setup → PC Remote Settings → Still Img. Save Dest.** (`PC Only` or `PC+Camera`) and **RAW+J PC Save Img** before connecting.
- **α7C II (USB):** disconnect any smartphone session, set **MENU → Setup → USB → USB Connection Mode → PC Remote** (or **Sel. When Connect → Remote Shoot**), and check **MENU → Network → Cnct./PC Remote → Remote Shoot Setting** (`Destination Only` or `Dest.+Camera`, `RAW+J Save Image`, `Save Image Size → Original`).
- **α7C II (Wi-Fi):** join the studio network (**Network → Wi-Fi → Access Point Set.**) or use **PC Remote Function → Wi-Fi Direct Info.** (`192.168.122.1`), set **PC Remote Function → PC Remote → On**, and use **Access Authen. Info** (SSH username, password and SHA-256 fingerprint) or **Pairing** when Access Authentication is Off.
- **Permissions and signing:** `src-tauri/build.rs` compiles the Objective-C `ImageCaptureCore` bridge on macOS and links `ImageCaptureCore` and `Foundation`. The bundle includes `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` (`src-tauri/Info.plist`) plus `com.apple.security.personal-information.photos-library` (`assets/entitlements.mac.plist`). On macOS 15+, allow PhotoCull under **System Settings → Privacy & Security → Local Network**. Quit other apps that may hold the camera (Capture One, Imaging Edge, Photos) before connecting.
- See [Tethered capture](tether-c1-spec.md), [Sony USB tethering on macOS](sony-ptp-macos-spec.md) and [Sony α7C II Wi-Fi tethering on macOS](sony-ptpip-wifi-spec.md) for the full feature contract and hardware-qualification checklists.

## Validation limits

**Native Tauri launch and physical camera tethering on a Mac have not been verified yet.** Permissions, native menu shortcuts, fullscreen, removable-card discovery, bundled module loading, deletion, `ImageCaptureCore` Objective-C compilation/linking, and sustained USB or Wi-Fi capture/Live View on real α7 III and α7C II hardware still need native validation on Apple Silicon macOS. Offline protocol, PTP/IP loopback, Wi-Fi SSDP/XML/SSH, transfer, sidecar, overlay and browser UI smoke tests run on Linux and verify the non-hardware layers.
