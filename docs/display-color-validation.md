# Display colour validation — 2026-11-05

Branch `display-color` starts at `dehancer-results` (`6e238b9`, PR #2), because it shares the TIFF preview paths. No merge was performed.

## Findings

WebView2 156.0.4314.58 has no forced profile argument. Default and `--force-color-profile=srgb` produced identical test-patch pixels. The Windows window HDC and the monitor HDC returned `C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm`; the built app's pinned Lightcraft query independently returned `monitor-icc` with that same path. No Lenovo TPLCD profile was selected or guessed from the installed files. The raw WCS/modern API probe did not resolve a usable monitor association, so the HDC and Lightcraft result are the profile evidence.

At final verification, `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` was 0 (8 bits/channel) and Lightcraft reported ordinary SDR: ACM/HDR off. An earlier ad hoc probe reported flags 7; that did not remain the final state. The final typed app query and repeated Win32 probe agree. Neither state requires converting source previews to a guessed panel profile. With ACM active, PhotoCull follows Lightcraft and leaves final display conversion to Windows; otherwise Chromium selects the assigned display profile.

The mismatch came from Sharp 0.35's P3 processing values being saved as untagged JPEGs, including the supplied `sharp(...).toColourspace('srgb')` measurement reference. Explicit output ICC conversion fixes the values. Native RAW rendering/Lightcraft TIFF decoding were already sRGB; native frames now declare their source space. See [the implementation and Lightcraft comparison](display-color.md#how-lightcraft-does-it).

## Measurements

Each entry is a 10×10 average, RGB 0–255. Centres are normalized image coordinates: sky (0.50,0.20), sky-low (0.75,0.45), water (0.75,0.85), rock (0.18,0.60), scrub (0.12,0.48). The latter is the supplied label for sky near the horizon.

The fixed column is a physical `System.Drawing.CopyFromScreen` capture of the built app displaying its own 2560-pixel preview at 1600×1067 physical pixels. The native column is the app's actual Develop/Dehancer view at its normal fit scale. Reference columns were measured again from the supplied screenshots at their supplied image rectangles. Sampling-scale/JPEG differences account for a few levels. Every fixed value is within 3 of the reference range.

| Region | Old Sharp reference | Dehancer reference | Photo Viewer reference | PhotoCull fixed screen | PhotoCull native Dehancer screen |
|---|---|---|---|---|---|
| sky | 129,175,202 | 113,175,203 | 114,175,204 | 115,176,205 | 116,176,204 |
| sky-low | 163,193,206 | 153,192,206 | 154,193,207 | 156,194,208 | 155,193,208 |
| water | 27,50,70 | 18,51,72 | 15,49,71 | 19,52,72 | 17,49,70 |
| rock | 133,120,108 | 133,116,103 | 135,119,106 | 136,120,107 | 134,118,105 |
| scrub | 156,185,199 | 146,184,198 | 147,185,199 | 148,186,200 | 148,186,200 |

## Checks

- Node 24.22.2: 96 passed, 1 skipped with a real copied Sony RAW fixture. The skip is the macOS-only packaging test. Preview regression covers sRGB/P3 tagged and untagged 16-bit TIFFs at thumb/preview/full sizes, including an edited RAW association and unchanged source bytes.
- Windows preview tests: all 11 passed, including the real copied RAW and new colour regression. Full Windows Node run: 92 passed, 2 platform skips, 3 existing symlink tests fail with `EPERM` because the Windows account cannot create symlinks (TIFF planning and two library tests); these same tests pass in WSL. This is an environment limitation, not a preview-colour failure.
- Windows `cargo test`: all 7 passed, including the copied 32 MP Dehancer TIFF and identical JPEG scan data after adding an ICC APP2 segment.
- General, viewer/loupe, Develop and image export UI smokes: passed, no page errors. Develop was repeated after the untagged-source fallback change.
- Real built Windows app: grid, filmstrip/navigator/Review, 100% full-size preview, native Dehancer result, draft/settled RAW and before/after exercised; all native frames carry sRGB ICC. No page errors. Histograms still describe sRGB output pixels, before presentation.
- Windows release build: MSI and NSIS completed locally. No GitHub Actions used or awaited.
- Old/new exported JPEG: identical decoded pixels and identical complete SHA-256 `23870b99707bb80ad63d541073790710a3b0f9a77e0d1fbd0668a0257218d3f3` (sRGB, quality 90, long edge 1200, no sharpening/metadata). Export encoding was not modified.
- Original and temporary TIFF copy SHA-256: `e9262400a33e64e2874494fc238fe17b90f919c86f9cdfcc47bcf69077dedc32`. Nothing in Pictures was written or deleted.

Raw measurements, exact JPEGs, physical screenshots, UI screenshots, and logs are local ignored artifacts in `artifacts/display-color/`. Reproduce with [the Windows verification script](../scripts/display-color-windows.cjs). No second physical monitor was available for a monitor-switch measurement, and macOS was not run locally. Their existing webview/OS presentation ownership is retained; Windows-specific diagnostics are target-gated. No per-monitor pixel cache or forced browser profile was introduced.

## Installation

NSIS setup ran with `/S` over `C:\Users\alex\AppData\Local\PhotoCull`; exit 0. No PhotoCull process was running at installation. Only the isolated test window was closed gracefully; no process was killed. Installed executable and backend were verified against this build (accounting for Tauri’s NSIS marker), and all 6 existing settings/session files retained their SHA-256 hashes. App data was preserved.
