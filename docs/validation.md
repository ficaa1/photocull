# Validation guide

Use disposable photo copies and an isolated `PHOTOCULL_DATA_DIR`. Never point smoke tests at a production library or settings directory. Generated fixtures, screenshots and reports belong in ignored `artifacts/` or temporary folders.

## Automated checks

Run `npm ci`, `npm test`, `npm run test:ui`, `node scripts/develop-ui-smoke.cjs` and `node scripts/image-export-ui-smoke.cjs`. These use synthetic fixtures and loopback services. The native shell additionally needs `cargo test --locked` and `cargo build --locked` in `src-tauri` on the target platform.

`node scripts/settings-ui-smoke.cjs - REPORT_FOLDER SONY_FIXTURE_FOLDER` and `node scripts/export-ui-smoke.cjs - REPORT_FOLDER SONY_FIXTURE_FOLDER` require copied `sample-8563.ARW`, `sample-8563.JPG` and `sample-8565.JPG`. They check settings persistence, presets, filename planning, XMP escaping and embedded metadata. Windows Shell metadata checks run on Windows.

## RAW fallback

`node scripts/prepare-raw-cases.cjs PHOTO_FIXTURE_FOLDER` makes preview-stripped copies after checking that JPEG ranges do not overlap sensor data. Set `PHOTOCULL_RAW_CASES` to the resulting `photocull-cases` folder for Node tests, or pass it to `raw-ui-smoke.cjs`. This helper is specific to the documented Sony fixture, not a general RAW editor.

## Develop, Dehancer and export (2026-11-05)

Renderer smokes cover recipes, preview scheduling, histogram interaction, loupe geometry and export options. Native export checks exercise JPEG, JPEG XL, TIFF, PNG, AVIF and WebP; resizing, color spaces, metadata policies, skip-existing behavior and cancellation. Source hashes must remain unchanged. Develop and finished-image export require the desktop shell.

For native Windows checks, launch a separate test instance with `PHOTOCULL_DATA_DIR`, `WEBVIEW2_USER_DATA_FOLDER` and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=PORT`. Use `develop-windows.cjs` or `image-export-windows.cjs` with explicit copied fixture paths. Follow export with `image-export-readback.cjs` for codec readback. Dehancer is separately installed and its round trip is a manual check.

Known limits: unsigned installers, unverified local macOS launch, variable lens-profile coverage, slow AVIF encoding, and externally saved TIFFs that may be 8-bit without ICC metadata. See [display colour validation](display-color-validation.md) for pixel and ICC checks. Environment-specific timings are observations, not performance guarantees.
