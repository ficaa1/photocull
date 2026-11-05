# Display colour validation

## Findings

WebView2 156.0.4314.58 has no forced profile argument. Default and `--force-color-profile=srgb` produced identical test-patch pixels. The Windows window HDC and the monitor HDC returned `C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm`; the built app's pinned Lightcraft query independently returned `monitor-icc` with that same path. No vendor profile is guessed from installed files. The raw WCS/modern API probe did not resolve a usable monitor association, so the HDC and Lightcraft result are the profile evidence.

At final verification, `DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO` was 0 (8 bits/channel) and Lightcraft reported ordinary SDR: ACM/HDR off. An earlier ad hoc probe reported flags 7; that did not remain the final state. The final typed app query and repeated Win32 probe agree. Neither state requires converting source previews to a guessed panel profile. With ACM active, PhotoCull follows Lightcraft and leaves final display conversion to Windows; otherwise Chromium selects the assigned display profile.

The mismatch came from Sharp 0.35's P3 processing values being saved as untagged JPEGs, including the supplied `sharp(...).toColourspace('srgb')` measurement reference. Explicit output ICC conversion fixes the values. Native RAW rendering/Lightcraft TIFF decoding were already sRGB; native frames now declare their source space. See [the implementation and Lightcraft comparison](display-color.md#how-lightcraft-does-it).

## Measurements

Each entry is a 10×10 average, RGB 0–255. Centres are normalized image coordinates: sky (0.50,0.20), sky-low (0.75,0.45), water (0.75,0.85), rock (0.18,0.60), scrub (0.12,0.48). The latter labels sky near the horizon.

The fixed column is a physical `System.Drawing.CopyFromScreen` capture of the built app displaying its own 2560-pixel preview at 1600×1067 physical pixels. The native column is the app's actual Develop/Dehancer view at its normal fit scale. Reference columns were measured again from the supplied screenshots at their supplied image rectangles. Sampling-scale/JPEG differences account for a few levels. Every fixed value is within 3 of the reference range.

| Region | Old Sharp reference | Dehancer reference | Photo Viewer reference | PhotoCull fixed screen | PhotoCull native Dehancer screen |
|---|---|---|---|---|---|
| sky | 129,175,202 | 113,175,203 | 114,175,204 | 115,176,205 | 116,176,204 |
| sky-low | 163,193,206 | 153,192,206 | 154,193,207 | 156,194,208 | 155,193,208 |
| water | 27,50,70 | 18,51,72 | 15,49,71 | 19,52,72 | 17,49,70 |
| rock | 133,120,108 | 133,116,103 | 135,119,106 | 136,120,107 | 134,118,105 |
| scrub | 156,185,199 | 146,184,198 | 147,185,199 | 148,186,200 | 148,186,200 |

## Reproduce

Use `scripts/display-color-windows.cjs TEMP_ROOT PROCESS_ID [PORT]` with disposable photo copies, an isolated app data directory and a dedicated WebView2 debugging profile. The script checks source hashes, ICC metadata and export pixels. See [display colour](display-color.md) for the rendering contract. Measurements are specific to the test display and fixture; macOS and monitor switching need separate validation.
