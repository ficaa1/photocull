# Recipes and finished-image export

Built-in ids remain `neutral`, `camera`, `dehancer-guide` for saved sessions.
Their names are Neutral, Camera look, and Flat base (for film emulation).
The flat base uses Lightcraft Color with exposure 0, contrast −25,
highlights −30 and blacks +25. It is a starting point for further editing.

The original exposure −1, contrast −40 and blacks +60 came from Dehancer's
Adobe Camera Raw quick guide. Lightcraft's profiles and tone mapping differ
from ACR. Removing the exposure reduction restores the midtones; moderate
contrast/blacks and negative highlights flatten the range without increasing
highlight clipping relative to Neutral. This is not an ACR rendering match.

Full-resolution Sony A7C II copies were decoded with Lightcraft and rendered
through the same `load_bytes` → native output size → `render` path as the shell.
Sharpening/noise reduction were off and embedded lens corrections were on.
Luminance is display-referred Rec. 709 weighted sRGB, on a 0–1 scale; clipping
counts pixels with any RGB channel at 255. The percentile span measures
P95 minus P05, rather than a claim about scene-linear dynamic range.

| Copy | Neutral median | Old flat median | New flat median | Neutral clipping | New flat clipping | Neutral / new P95−P05 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sample-8563.ARW | 0.6520 | 0.4855 | 0.6561 | 0.4259% | 0.2993% | 0.7891 / 0.7550 |
| sample-8565.ARW | 0.4544 | 0.3228 | 0.4695 | 0.0287% | 0.0147% | 0.9071 / 0.8921 |
| sample-8566.ARW | 0.3538 | 0.2720 | 0.3706 | 0.0352% | 0.0146% | 0.8803 / 0.8645 |

Raw measurements: [luminance JSON](measurements/recipes-export-luminance.json).

## Recipe files

Develop's Recipe panel duplicates any recipe, imports recipes, exports the
selected recipe (including built-ins), or exports all user recipes. Native
open/save dialogs are used on desktop; browser mode prompts for a full path.
Files use `.photocull-recipe.json` and UTF-8 JSON:

```json
{"type":"photocull-recipe","version":1,"name":"My recipe","settings":{"light":{"exposure":0.2}}}
```

A bundle is `{ "type": "photocull-recipe-bundle", "version": 1, "recipes": [...] }`,
where each entry has the single-recipe schema above. Limits: 1 MiB per file,
100 entries per bundle, 64 KiB of settings per recipe, 80 characters per name.
Settings must be JSON values, finite, within a bounded nesting depth, with
valid Light slider values. Files are fully validated before import begins;
unsupported types/versions and symlinks are refused. Imported ids are fresh.
Name collisions are case insensitive and become `Name (2)`, `Name (3)`, etc.
Imported recipes remain local, and no photo files are embedded or changed.

## Export presets and codecs

Export's presets include all format/quality/depth/color/sizing/sharpening and
metadata options, filename template, subfolder and conflict policy. They do
not store a destination folder or change which photos are selected. Save as
preset captures the dialog; Rename, Duplicate, Delete and the arrows manage
user presets. Built-ins can be reset and reordered but cannot be deleted or
renamed. The four built-ins are Full-size JPEG, Web 2048 px JPEG (sRGB and
screen sharpening), JPEG XL and 16-bit TIFF archive. Existing last-used
options, naming, subfolder and conflict policy migrate into My last export.
Last used also remains available independently of presets.

WebP offers lossy quality 1–100 and a lossless checkbox. The pinned Lightcraft
codec only encodes lossless; `webp` 0.3.1 supplies lossy encoding through
bundled libwebp (`libwebp-sys` 0.9.6). Its default image integration is disabled.
This avoids another image stack and needs no system WebP install on Windows
or macOS. A C compiler is required at build time. Lightcraft still handles
lossless encoding, profile conversion and readback; output sharpening precedes
lossy encoding, and ICC/EXIF/XMP are written as standard extended RIFF chunks.
See [third-party notices](../third-party/README.md#lossy-webp).

AVIF's Faster / Balanced / Smaller choices map to ravif speeds 10 / 8 / 6.
Faster is the new default; Balanced retains the previous speed. Quality is
independent of speed. AVIF remains sRGB, 8/10-bit; XMP is embedded into the
staging file before publication, as with other AVIF exports.

## Scheduling and verification

The shell runs at most `max(1, min(logical cores / 2, 3))` photo jobs. A 33 MP
float working source alone occupies roughly 400 MB, before render, deep output
and codec buffers. This deliberately conservative cap avoids launching one
full-resolution photo per core; it is a fixed bound, not a free-memory probe.
Lightcraft/encoders also parallelize within a photo, so batch speedups depend
on CPU and memory bandwidth. Full-resolution sources are not retained in the
preview cache. Names are planned before workers start; duplicate destinations
are rejected, result rows retain input order, and completion progress is
serialized and monotonic. Per-photo failures do not stop other photos.
Cancellation prevents queued jobs from rendering and checks before staging
and publication; running encoders finish, staged files are removed, and
completed exports are kept.

Run `npm test`, `node scripts/develop-ui-smoke.cjs` and
`node scripts/image-export-ui-smoke.cjs`. On Windows, run `cargo test --locked`
and `cargo build --locked` in `src-tauri`. The real app script
`scripts/image-export-windows.cjs` requires an isolated `PHOTOCULL_DATA_DIR`
and WebView2 profile, verifies that the connected app uses that directory,
and copies three source pairs before testing. `PHOTOCULL_EXPORT_QUICK=1`
keeps the full-size JPEG batch and tests the other codec/source combinations
at 1200 px. The finished TIFF fixture is made from a copied JPEG; no external
editor is launched.

`cargo run --example recipes_export_bench -- <copied-RAW-dir> <report-dir>`
compares the previous sequential encoder defaults against bounded parallel
export, including full decode/render/encode/write, on three full-size RAWs.
No photo data belongs in the repository; only measured numbers are retained.
