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
| sample-01.ARW | 0.6520 | 0.4855 | 0.6561 | 0.4259% | 0.2993% | 0.7891 / 0.7550 |
| sample-02.ARW | 0.4544 | 0.3228 | 0.4695 | 0.0287% | 0.0147% | 0.9071 / 0.8921 |
| sample-03.ARW | 0.3538 | 0.2720 | 0.3706 | 0.0352% | 0.0146% | 0.8803 / 0.8645 |

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
Legacy WebP options retain lossless mode.
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

All formats use the same cap of `max(1, min(logical cores / 2, 3))` photo jobs. A 33 MP
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

## Windows measurements — 2026-11-06

Test host: Intel Core i7-12800H (20 logical processors), 16 GiB RAM; Windows
Rust 1.99 debug application with optimized processing dependencies. Three
copied full-resolution RAWs: sample-01, sample-02, sample-03. One batch per case,
warm dependencies/filesystem, sRGB, quality 90, no output sharpening. Before
uses the pinned engine sequentially; after uses three jobs and AVIF Faster.
Numbers include decode, render, encoding and writing; they exclude app/Node
startup, destination planning and metadata embedding. Concurrent system load can affect timing. These are measurements, not a universal
throughput guarantee.

| Format | Before, 3 files | After, 3 files | Change | Before / after total bytes |
| --- | ---: | ---: | ---: | ---: |
| JPEG | 10.083 s | 10.794 s | 7.1% slower | 18,688,732 / 18,688,732 |
| JPEG XL | 16.061 s | 14.388 s | 10.4% faster | 6,816,457 / 6,816,457 |
| AVIF (speed 8 → 10) | 104.873 s | 31.456 s | 70.0% faster | 12,323,324 / 14,283,979 |
| WebP lossless | 15.838 s | 17.382 s | 9.7% slower | 124,033,678 / 124,033,678 |
| WebP lossy, quality 90 (new option) | — | 17.206 s | separate encoding mode | — / 10,740,088 |

For sample-01 specifically, AVIF encoding measured 33.636 s before and 10.521 s
after (the latter while other photo jobs ran), with 6,145,511 → 7,272,593 bytes.
Faster trades compression efficiency for encoder time; Balanced preserves
the old speed. JPEG, JPEG XL and lossless WebP before/after outputs were
byte-identical for all three copies. The three-job cap helps overlap codec
work, but full-size JPEG and lossless WebP rendering can saturate memory/CPU
already. Their regressions are retained in the table. Lossy WebP's principal
benefit here is size, about 91% less than lossless; it does not promise a
faster encode.

[Per-file timings, encode times and sizes](measurements/recipes-export-timings.json)
and [isolated app verification summary](measurements/export-windows-summary.json).
The app run also checked monotonic progress, input-order results, independent
per-item failure, skip-existing, cancellation and unchanged temporary fixture
hashes. The original photo folders were only read to make copies. Final local
checks: 100 Node tests passed, 2 skipped; both UI smokes passed; 9 Windows Rust
tests and Windows build passed without warnings. macOS runtime verification
was unavailable; bundled libwebp's build path supports MSVC and Apple Clang
without a system library.

## Export scheduling investigation — 2026-11-06

The shell retains the uniform half-core/max-three cap for every format.
Reducing JPEG, PNG, TIFF and WebP to one job publishes the first file sooner,
but makes complete batches 6–27% slower in the measurements below. Batch
completion is the user-facing objective, so the per-format candidate was
rejected. The probe and output/order regression coverage remain available.

The same three copied A7C II ARWs, full-resolution Neutral, sRGB quality 90,
no sharpening/NR, native output sizing and embedded lens corrections were
measured with identical current encoders on each side. Two trials alternate
before/after order. Before is three workers; after is the rejected per-format candidate.
AVIF uses Faster on **both** sides, avoiding the speed-8-to-10 confound in the
historical table above. PNG/TIFF use the current 8-bit default; WebP is lossless.
Numbers include reading, decode, render, encode and writing, but not renderer,
Node planning, metadata embedding or process startup. Windows debug executable,
optimized processing dependencies, 20 logical processors. Other work can affect
these laptop measurements; do not compare different runs as an isolated codec
optimization. First-file estimates are the earliest completion in the initial
worker group, from each file's start; publication overhead outside the example
is excluded. No process peak-RAM measurement is claimed.

| Format | Workers before → after | Mean batch before | Mean batch after | Batch change | First file before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| JPEG | 3 → 1 | 11.794 s | 12.603 s | 6.9% slower | 5.798 → 4.355 s |
| PNG | 3 → 1 | 12.791 s | 15.334 s | 19.9% slower | 9.390 → 4.996 s |
| TIFF | 3 → 1 | 13.064 s | 16.541 s | 26.6% slower | 10.067 → 5.340 s |
| WebP lossless | 3 → 1 | 14.115 s | 14.957 s | 6.0% slower | 10.415 → 4.985 s |
| JPEG XL | 3 → 3 | 13.736 s | 14.460 s | 5.3% run variation | 9.725 → 9.282 s |
| AVIF Faster | 3 → 3 | 36.001 s | 36.299 s | 0.8% run variation | 23.093 → 24.060 s |

The earlier JPEG/WebP batch regression does **not** reproduce with these current
before/after timings: three workers are faster for the whole batch here. The
rejected serial candidate reduces first-file latency by roughly 25–52% for the four
candidate formats and avoids retaining three large sources at once. Those earlier first files do not offset the batch penalties, so the uniform
cap remains in production.
AVIF and JPEG XL stay at three; their unchanged-policy differences show timing
noise rather than a scheduler improvement. A future throughput-first or memory-
adaptive policy needs measurements across more hardware and workloads.

Reproduce with:

```sh
cargo run --locked --example export_scheduling_bench -- COPIED_RAW_DIR REPORT_DIR
```

Optional third argument overrides the after worker count for calibration;
a fourth comma-separated list restricts formats (for example `2 jpeg,png`).
The benchmark is not packaged. [Raw two-trial measurements](measurements/export-single-workers.json)
retain per-photo times, encode times and byte counts.

A separate two-worker calibration also favored the three-worker baseline for
JPEG/PNG/TIFF/WebP on this run. The four-format trials are preserved in
[the calibration data](measurements/export-pair-workers.json). The candidate
was not adopted: reducing to two did not recover batch throughput. SHA-256
readback of scheduling-only outputs is recorded in
[output integrity comparisons](measurements/export-scheduling-integrity.json).
