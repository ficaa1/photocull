# macOS

PhotoCull has Apple Silicon (`arm64`) and Intel (`x64`) builds. The packaged Electron runtime declares macOS 13.0 or newer. Use the archive matching the Mac's processor; the arm64 build avoids Rosetta on Apple Silicon.

## Development builds

Extract `PhotoCull-macOS-arm64.zip` or `PhotoCull-macOS-x64.zip`. The extracted folder contains `PhotoCull.app` and `Prepare PhotoCull.command`. Builds made on Linux are not Developer ID signed or notarized. If macOS refuses to open the app, run this command in Terminal, using the extracted folder's actual path:

```sh
bash "/path/to/PhotoCull-darwin-arm64/Prepare PhotoCull.command"
```

The helper removes the quarantine attribute only from its adjacent `PhotoCull.app`, signs that local development bundle ad hoc with the supplied Electron JIT/native-module entitlements, and verifies the signature. It does not change global Gatekeeper settings. Then move/open `PhotoCull.app` normally. A signed, notarized public release would need a Mac build and an Apple Developer identity.

Allow removable-volume access when macOS requests it. Camera cards mounted under `/Volumes` are discovered through `diskutil`; internal and disk-image volumes are excluded. Empty/unmounted card readers do not appear.

## Desktop behavior

- Native application/File/Edit/View/Window menus, Command shortcuts, and Settings (`Cmd+,`).
- Closing the last window leaves the Mac application running; reopening from the Dock creates a new window. Quit uses `Cmd+Q`.
- Native fullscreen and the same zoom/culling/export workflow as Windows.
- Preferences and sessions under `~/Library/Application Support/photocull/` (the application name can be capitalized by Electron). Open Settings → Open settings folder for the exact location.

## Build

On macOS, or Linux with Python 3 for archive creation:

```sh
npm ci
npm run pack:mac -- all
```

You can replace `all` with `arm64` or `x64`. Target-platform Sharp and portable ExifTool are staged separately, so cross-building does not replace the development machine's modules. Archives preserve Unix executable permissions and app-bundle symlinks. Native Mac builds are ad-hoc signed automatically; cross-builds include the preparation helper.

## Validation limits

The Apple Silicon and Intel bundles were cross-built and inspected on Linux. Inspection checks the CPU of the Electron executable and Sharp module, bundle metadata/volume access text, RAW WASM assets, and execution of the bundled ExifTool under Linux Perl. Unit tests exercise macOS volume parsing and disappearing-volume behavior. Linux and Windows exercise the shared UI and image/export code.

**These builds have not been launched on a Mac in this session.** Actual Mac permissions, native menu behavior, fullscreen, removable-card discovery, module loading and local signing still need native validation. `.github/workflows/macos.yml` supplies macOS unit/UI/package checks for a future CI run; adding it does not mean that CI has run.
