# Preview colour management

PhotoCull produces sRGB previews and identifies their colour space with an ICC profile. WebView2 (Windows), WKWebView (macOS), or WebKitGTK handles presentation to the screen. On Windows 11 with Auto Color Management (ACM) or HDR active, Windows performs the final display conversion and expects ordinary application content in sRGB. No preview pixels are manually converted to a monitor's device values. That avoids a second conversion by the webview/compositor. Display changes are handled by the webview/OS; cached image bytes are independent of the monitor.

This covers the grid/contact sheet, filmstrip, navigator, Review fit/full-size loupe, Develop drafts and settled frames, Dehancer results, and before/after. Existing full-size upright JPEGs retain their embedded source profile when passed through. Untagged JPEGs retain the normal sRGB assumption. Missing monitor profiles keep the normal sRGB fallback. macOS keeps WKWebView's native colour management.

Histograms and clipping calculations still describe the image's output space (sRGB), before the presentation transform. Exports, TIFFs sent to Dehancer, metadata writes, and copied originals do not use a display profile. Native preview ICC metadata is added only by `encode_frame`, which is separate from export encoding.

## Root cause

Sharp 0.35 chooses Display P3 as its ICC processing space for 16-bit RGB inputs (`sharp/src/pipeline.cc`, `processingProfile`). PhotoCull previously called `toColourspace('srgb')` and encoded a JPEG without ICC metadata. That changes the libvips pixel representation but does not transform the processing profile's primaries to sRGB. The resulting P3 channel values were interpreted as sRGB by the webview. A blue region therefore had too much red. Even `sharp(tiff).toColourspace('srgb').raw()` used as a measurement reference has this problem: it is not a reliable sRGB reference for these 16-bit TIFFs.

`withIccProfile('srgb')` explicitly converts the processing pixels to sRGB and embeds that profile. For an untagged RGB16 source, the pipeline first establishes the normal sRGB assumption; otherwise Sharp assumes its untransformed samples are P3. Regression coverage includes embedded sRGB, embedded P3, untagged RGB16, direct TIFFs, and edited RAW associations at all three preview sizes. The preview cache representation version changes so existing incorrectly encoded JPEGs are regenerated; source/embedded/RAW caches are reused and the existing disk limit still applies. No per-monitor cache is needed. Native Lightcraft `decode(...).to_srgb8()` and RAW pipeline output already produce correct sRGB; their JPEG frames now embed Lightcraft's sRGB profile explicitly.

No `--force-color-profile` argument existed in the application or runtime environment. Forcing WebView2 to sRGB made no difference on the tested laptop. A forced standard profile is not a path to an arbitrary monitor ICC file and would bypass correct profile selection on other SDR displays. The fix leaves Chromium's automatic management enabled.

## How Lightcraft does it

Inspected the pinned revision `d58b4d67238ef1aafd8e3394a9f8428a3d91e561` and upstream main `ba282d36379ba6c31f624c816c86de1f18521876`. The relevant files below are identical at those revisions:

- `docs/display-profiles.md`, `crates/wincolor/src/lib.rs`: Windows uses `MonitorFromWindow` / `GetMonitorInfoW`, resolves the active monitor device, and reads WCS's default profile in the selected user/system scope. GDI `GetICMProfileW` is a fallback because it can retain an old profile. `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo` detect advanced colour; when ACM/HDR is active or its state is unknown, Lightcraft leaves pixels in sRGB.
- `apps/lightcraft/src/screen_profile.rs`: macOS reads the window's `NSScreen.colorSpace.ICCProfileData`. Lightcraft needs this because its wgpu Metal surface is untagged; WKWebView already has OS colour management.
- `crates/codecs/src/display.rs`: the CMS is **moxcms**, with relative colorimetric intent. Matrix/TRC displays use colour matrices and 256-entry tone-curve tables; LUT displays use CMS transforms. `DisplayProfile` builds its transforms once and hashes profile bytes for render keys.
- `crates/engine/src/display.rs`, `crates/ui-egui/src/render.rs`: native loupe/before/compare/region renders target display primaries at the end of the RAW pipeline, then receive tone-curve/LUT correction. sRGB thumbnails and cached previews are converted on render workers before texture upload. Histograms and disk caches remain sRGB. A changed display hash clears textures and rejects obsolete work.
- `apps/lightcraft/src/win_screen_profile.rs`, `profile_file.rs`, `crates/ui-egui/src/app/prefs.rs`: the UI queries about once a second, follows monitor/profile changes, and caches profile bytes by path/file stamp.

PhotoCull follows Lightcraft's ACM rule and reuses its pinned `lightcraft-wincolor::monitor_color` for the `display_color_status` diagnostic command. Native sRGB decoding and profile generation reuse `lightcraft-codecs`. It deliberately does not copy Lightcraft's final device-pixel transform: PhotoCull presents through colour-managed webviews instead of an unmanaged egui/wgpu surface. Applying both would risk double conversion. The Windows query is target-gated; other platforms acquire no new dependency or device-space conversion. There is no new vendored code; existing Lightcraft MIT notices in `third-party/` cover the pinned dependencies.

A Settings toggle was omitted: correct source-space encoding is required for every preview, and disabling a webview's display transform is a browser-process setting with restart/ACM implications. A checkbox that merely disables TIFF conversion would restore the encoding bug.

## Reproducing the Windows check

Use a separate test app data directory and WebView2 user-data folder. Copy `sample-edit.tif` into `TEMP_ROOT/photos`; never alter the original. Set `PHOTOCULL_DATA_DIR=TEMP_ROOT/data-default`, `WEBVIEW2_USER_DATA_FOLDER=TEMP_ROOT/webview-default`, and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9338` before launching the built executable. Optional copied RAW/JPEG fixtures belong in `TEMP_ROOT/raw`.

Before replacing the old build, export the copied TIFF as sRGB JPEG quality 90, long edge 1200, no sharpening/metadata, into `TEMP_ROOT/export-before.jpg`. Then run:

```sh
node scripts/display-color-windows.cjs TEMP_ROOT PROCESS_ID 9338
```

The script queries the actual window through Lightcraft, saves exact preview JPEGs, captures the physical window with `System.Drawing.CopyFromScreen`, measures the image at 1600×1067 physical pixels, exercises grid/full-size/native Develop/before/after paths, and asserts the exported JPEG's decoded pixels are identical to the old export. Its output folder must be inside an isolated temporary directory. All five regions are 10×10 averages centred at normalized image coordinates: sky (0.50, 0.20), sky-low (0.75, 0.45), water (0.75, 0.85), rock (0.18, 0.60), scrub (0.12, 0.48). “Scrub” is the supplied label for a near-horizon sky patch.

When Windows is locked, physical capture records the lock screen and cannot
verify monitor/ACM output. Set `PHOTOCULL_COLOR_CAPTURE=cdp` to run the same
app checks against WebView2 screenshots instead. The report explicitly labels
this as webview verification; it does not establish physical display parity.
See [Rust display-preview investigation](rust-display-previews.md) for the
separate codec probe and why the production preview encoder remains sharp.
