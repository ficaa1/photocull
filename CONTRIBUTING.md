# Contributing to PhotoCull

Keep changes focused, explain the resulting behavior, and report local checks and platform coverage in the pull request. File a bug with reproduction steps before proposing a large change. Security reports belong in [private advisories](SECURITY.md).

## Setup

Use Node.js 24 and a current stable Rust toolchain. Install the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform:

- Windows: Visual Studio C++ build tools, Windows SDK and WebView2.
- macOS: Xcode command line tools. Apple Silicon builds are the packaged target; Intel builds are manual.
- Linux: a C/C++ toolchain, pkg-config and WebKitGTK 4.1/GTK development libraries for your distribution. WSL can run Node checks without the native prerequisites.

```sh
npm ci
npm test
npm run test:ui
npm start
```

`npm run web` starts the browser renderer on loopback for culling development. Native Develop and finished-image export need the desktop shell. Set `CHROMIUM_PATH` for UI smokes if Chrome/Chromium is not in a standard install location.

## Checks

```sh
npm test
npm run test:ui
node scripts/develop-ui-smoke.cjs
node scripts/image-export-ui-smoke.cjs
npm run notices
cd src-tauri
cargo test --locked
cargo build --locked
```

Run `npm run build` from the repository root on the target OS for installers. It stages the current official Node runtime and production dependencies, including platform-specific sharp and ExifTool binaries. The official Node distribution's LICENSE must be beside the executable or above its bin directory.

Tests use synthetic fixtures, temporary app data and loopback services; they must not need external network access. Dependency installation, the first Cargo fetch and packaging dependency installation may use the network. Optional real-photo tests require disposable fixture copies: see [validation](docs/validation.md) for filenames and UI smoke arguments. Never use production app data or modify source photos.

For the Windows inspection scripts, pass a copied fixture directory as the first argument or set `PHOTOCULL_FIXTURES` (there is no personal-folder default). Reports default to `artifacts/`. `image-export-windows.cjs` requires `PHOTOCULL_DATA_DIR` matching the separate test app; its optional second argument selects a new output folder. `display-color-windows.cjs TEMP_ROOT PROCESS_ID [PORT]` requires the isolated temporary root described in its header.

## Style and tests

Follow the compact CommonJS backend and plain JavaScript renderer style. Use existing DOM helpers; keep dependencies small. Format Rust with `cargo fmt`. Preserve the renderer method allowlist, loopback authentication, source protection and cancellation boundaries.

Write every comment about the code as it stands. Explain a non-obvious reason or constraint; keep history in git. A test should protect observable behavior, use the app's real entry points, and fail when that behavior breaks. Extend the existing owner of a behavior instead of duplicating it. No production-only test hooks or network-dependent tests.

When updating dependencies, refresh the reviewed license metadata and bundled texts with `node scripts/notices.cjs --refresh` after Cargo sources are cached, then run the offline generator. See [third-party licensing](docs/licensing.md) for redistribution requirements.

Contributions are distributed under the project's MIT license; retain upstream notices for reused code.

## Build workflow

The build workflow stays disabled on GitHub while the repository is private, and every job checks repository visibility. After publication, the maintainer can run `gh workflow enable build.yml`. Public pull requests/main pushes run Windows and macOS tests; `v*` tags and manual dispatch build installers. Manual dispatch requires an existing release tag and attaches its installers to that release.
