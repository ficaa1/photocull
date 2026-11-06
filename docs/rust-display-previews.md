# Rust display-preview migration investigation

Pinned Lightcraft revision: `d58b4d67238ef1aafd8e3394a9f8428a3d91e561`.
The production preview encoder remains sharp. The implementation first separates
pixel encoding into `src/display-preview.cjs`, leaving source selection, queues,
pass-through and cache publication in `PreviewService`. The benchmark substitutes that module function in its own process; no renderer
RPC or production test option is added.
The existing color conversion and cache keys are unchanged.

## Actual format surface

`src/library.cjs` admits JPEG, PNG, TIFF, WebP, and these RAW extensions:
ARW, CR2, CR3, NEF, NRW, DNG, RAF, ORF, RW2, PEF, SRW, 3FR, FFF, IIQ, RWL.
RAW/JPEG pairs use the RAW as the item and retain the JPEG as a companion.
HEIC, AVIF, JPEG XL, GIF, BMP and PSD are **not** imported by the current scanner.
Do not describe sharp's broader codec capability as PhotoCull import support.
AVIF and JPEG XL are export formats; export support does not imply import.

| Source | Current display path | Pinned Lightcraft candidate | Remaining evidence |
| --- | --- | --- | --- |
| JPEG | sharp, orientation, 400/2560/native | `decode_jpeg_srgb8_fit`; fallback `decode().to_srgb8()` for ICC, CMYK and unusual JPEGs | Speed; decoder differences; full-size pass-through |
| PNG | sharp, first image, alpha discarded for JPEG | `decode` + sRGB8 | Alpha, grayscale, 8/16-bit and ICC fixture matrix |
| TIFF / external-edit TIFF | sharp, first page; RGB16 ICC fix | `decode` + sRGB8 | Compression, tiled/strip/BigTIFF, CMYK/LUT ICC and large-file memory |
| WebP | sharp, first frame | `decode` + sRGB8 | Lossy/lossless, alpha, animation first-frame behavior |
| RAW embedded JPEG/TIFF | ExifTool inventory/range extraction then sharp | Keep extraction, substitute pixel encoder | Same candidate choice and fallback for every camera family |
| RAW without usable embed/companion | isolated LibRaw WASM worker then sharp JPEG | Keep LibRaw, replace its RGB-to-JPEG step separately | All supported camera variants; bounded memory/cancellation |
| HEIC (not imported) | Not a current feature | `heif` optional feature, currently disabled | Explicit product decision and fixtures before enabling |
| AVIF (not imported) | Not a current feature | `Format::Avif.not_decodable()` explicitly rejects it | Additional decoder needed before enabling import |

The pinned codecs can decode JPEG, PNG, TIFF and WebP. Their default features
include AVIF **encoding**, not decoding. The JPEG fast path declines images with
ICC profiles or Adobe RGB hints and returns `None`, requiring the color-managed
fallback. `Decoded` carries source primaries and unapplied orientation;
`to_srgb8()` performs the actual conversion. Decode with `max_pixels=160_000_000`,
apply orientation exactly once, never enlarge, and encode JPEG with an explicit
sRGB ICC profile (quality 76 thumbnails, 91 preview/full). Existing upright
full JPEGs pass through unchanged and may retain another ICC profile or the
normal untagged-sRGB interpretation; preserve this documented exception.

Lightcraft's `raw::embedded_preview`, `embedded_preview_covering`,
`bounded_preview` and `embedded_preview_from_range` are useful, but are not a
drop-in replacement for the five-tag inventory. `embedded_preview` chooses
the largest JPEG/JXL; the application chooses the smallest adequate candidate,
uses a different order for thumbnails, accepts TIFF, falls back to a companion,
and records absent/invalid candidates. Keep ExifTool extraction initially.
`PREVIEW_PREFIX` is 4096 bytes and `bounded_preview` can request a larger window;
this could eventually avoid full RAW reads, but must be measured per container.
The application's current validated ExifTool ranges already avoid repeated
extraction processes where offsets are available.

## Stable cache and scheduling contract

All paths below remain relative to the configured preview-cache directory.
Hashes are lowercase SHA-256 hex of the exact UTF-8 strings, using the existing
JS interpolation of the fingerprint and item revision. Consumers should request
`PreviewService.get(item, 'preview')` and use `service.key(item, kind)` after
`displayItem(item)` when they need the disk representation; do not reproduce
fingerprints in Rust. A future Rust sharpness command should receive the cache
JPEG path chosen by Node, rather than deriving a second cache layout.

- Source key: `hash('sources-v2:' + path + ':' + fingerprint)`.
  `<source>.inventory.json` version 2 records dimensions, orientation, ranges,
  candidates and per-candidate status. `<source>.<tag>.embedded` contains original
  extracted bytes; its extension is not a codec declaration.
- Representation key: `hash('representation-v4-srgb:' + sourceKey + ':' + kind
  + ':' + policy + ':' + itemRevision)`.
  `<key>.jpg` and `<key>.jpg.json` hold pixels and source information. Atomic
  writes, file-stamp invalidation, access-time touching and current disk pruning
  stay owned by Node. Existing representations are readable without re-encoding.
- RAW render identity uses `DECODER_ID:path:fingerprint`, then a separate hash
  for `identity:half` / `identity:full`. Keep `.render.jpg`, `.render.json` and
  `.failure.json` and the decoder id while LibRaw rendering is unchanged.
- Three representation jobs, two extraction jobs, one sensor render run at once.
  Visible/focused work supersedes queued prefetch; duplicate jobs share a
  promise. Active ordinary encoding can finish, but policy/item revision guards
  prevent stale cache publication. Sensor rendering has abort/timeout support.
- Pixel-encoder replacement must not change `missing`/`small`/`off` render gates,
  candidate retry on decode failure, source-info labels, `peek`, memory LRU,
  external-edit fingerprinting or Windows file-lock release during hand-off.

A future production Rust encoder should bump only the representation version
when changed pixels require invalidating old output. Source inventories,
embedded bytes and unchanged LibRaw render caches must remain reusable. Inform
cache consumers of that version change; use the Node-selected path as the API.

## Browser mode and packaging

A Tauri-only command cannot replace the encoder: all browser smokes exercise a
standalone Node backend. The preferred future transport is a persistent Rust
helper executable with a bounded request queue, built for the host target and
bundled next to Node. Build once in a separate package with no Tauri/WebKitGTK
requirements. Pin the same Lightcraft revision, declare the Rust MSRV and
provide an explicit helper-build command in development setup and staging.
WSL's current Rust 1.80 cannot compile the pinned edition-2024/modern-Rust stack;
upgrade that toolchain or use a matching prebuilt Linux helper. A Windows helper
is useful for measurements but does not satisfy Linux browser mode.

A development-only sharp fallback would preserve browser smokes but leave two
implementations and the native dependency installed for development. It would
also make those smokes poor coverage for the shipped encoder. Do not silently
fall back in production; report a missing/incompatible helper at startup.
Prefer the same helper protocol in desktop and browser modes once supported.

The experimental `display_preview_probe` example is deliberately not packaged.
It accepts newline-delimited `{file,output,edge,quality,orientation?}` requests,
applies the 160 MP limit, uses the JPEG fast path with a color-managed fallback,
orients, encodes and embeds sRGB. `preview-codec-bench.cjs` runs three persistent
workers through the actual PreviewService pixel-encoding function. This probe is not a
production protocol: it lacks ids, negotiated version/capabilities, timeout,
abort/restart, output containment and source-stamp checks. Add those before
shipping; Node must remain the path/queue/cache authority. Send job ids and
JSON metadata plus binary image bytes, or securely owned temporary outputs;
never send large RGBA buffers as JSON arrays.

## Dependency decision

Keep sharp and its bundled libvips for now. It still performs production
JPEG/PNG/TIFF/WebP display encoding, source and cache validation, dimensions,
embedded JPEG/TIFF inspection, and the LibRaw worker's RGB-to-JPEG encoding.
Changing only the visible display encoder does not remove any native dependency.
libvips is LGPL; retaining it retains the associated distribution obligations.
LibRaw WASM also remains separately licensed even after a future sharp removal.
No packaging or third-party notice is removed on the strength of the probe.

## Reproduction

Use Windows Rust 1.99 and Windows Node in an isolated checkout, with the shared
Cargo target cache as described in the project build instructions. All photo
arguments below must refer to disposable copies, except the benchmark's source
folder, which is only read to create 102 copies in a fresh OS temporary folder.
Do not run test code against the owner's live data directory.

```sh
cd src-tauri
cargo test --locked
cargo build --locked
cargo build --locked --example display_preview_probe --example export_scheduling_bench
cd ..
node scripts/preview-codec-parity.cjs PROBE_EXE COPIED_TIFF COPIED_JPEG REPORT_DIR
node scripts/preview-codec-bench.cjs PROBE_EXE SOURCE_FOLDER REPORT_DIR
```

The parity check compares ICC tagging, dimensions, all eight orientations and
five 10×10 normalized color regions, following `display-color.md`, for copied
TIFF/JPEG and generated sRGB/P3/untagged 16-bit TIFF, PNG and WebP. It checks
source hashes. This is an encoded-image check; the isolated real-app check
separately verifies actual WebView2 presentation and grid/loupe behavior.

Measured results and the final migration decision follow below.

## Windows measurements — 2026-11-06

ThinkPad i7-12800H, 20 logical processors, 16 GiB RAM; Windows Rust 1.99
(debug executable, optimized processing dependencies), Windows Node 24.20.0.
102 distinct temporary copies made from only three source RAW/JPEG pairs,
51 RAW + 51 JPEG items with different stems to avoid RAW/JPEG pairing. This is
a repeated-image throughput workload, not a 102-scene camera compatibility set.
Each trial uses cold application caches, warm filesystem caches, three workers,
and includes RAW inventory/extraction, color conversion, JPEG encoding and cache
publication. Rust process startup is included; scanning, HTTP and presentation
are excluded. Two trials alternate sharp/Rust order. Values below are means;
individual trials and extraction counters are retained in the JSON.

| Size | sharp first image | Rust first image | sharp all 102 | Rust all 102 | sharp images/s | Rust images/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 400 px thumbnail | 172.6 ms | 216.2 ms | 5.313 s | 4.862 s | 19.36 | 20.98 |
| 2560 px preview | 380.5 ms | 250.9 ms | 14.798 s | 9.964 s | 6.90 | 10.25 |

The second thumbnail trial filled in 4.829 s with sharp versus 4.864 s with
Rust (0.7% slower). First-thumbnail latency increased in both trials, by 32.3
and 54.8 ms. Bulk preview throughput is promising, but the required absence of
a first-image or grid regression has not been demonstrated. Persistent helper
prewarming may remove startup cost; it must be measured rather than assumed.
No claim is made about actual screen grid fill from this backend measurement.

All 43 encoded-image parity cases retain expected dimensions and ICC metadata.
Synthetic sRGB/P3/untagged RGB16 TIFF, PNG, WebP and all eight orientations stay
within three channel levels across the five averaged patches. The copied
JPEG stays within 2.47 at 400 px and 1.23 at 2560 px; the copied TIFF stays
within 0.83 at 2560 px, but differs by 5.75 in a textured thumbnail patch at
400 px. Lightcraft resizes in linear light; sharp's current resize has different
sampling/transfer behavior. That thumbnail difference is not evidence of the
previous P3-tagging bug, but a visible rendering difference needing a deliberate
acceptance decision. Original copied TIFF/JPEG SHA-256 hashes are unchanged.

Raw measurements: [timings](measurements/rust-preview-codecs.json) and
[43-case color/orientation results](measurements/rust-preview-parity.json).
The parity script intentionally exits nonzero when any patch exceeds three;
its failing case is retained rather than weakening the gate.

## Decision and next implementation steps

Do not switch production display encoding yet. Keep the sRGB fix and the
working browser-mode path. The safe partial implementation is the tested pixel
encoder boundary and the independent export scheduling investigation.
sharp/libvips remains installed and shipped; no license simplification is claimed.

1. Agree on linear-light resize differences using textured photos at thumbnail
   scale, while retaining exact source-space conversion and explicit sRGB tags.
2. Prewarm a production helper, bound its global processing threads, add ids,
   cancellation/restart and version negotiation, then repeat cold-start/visible
   priority benchmarks including actual grid and loupe presentation.
3. Validate TIFF compression/ICC layouts, transparent/animated PNG/WebP first
   frames, uncommon JPEG coding, all orientation overrides and supported camera
   families. Keep ExifTool and LibRaw fallbacks until equivalent coverage exists.
4. Supply Linux/macOS helper builds and a workable Linux Rust toolchain. Run the
   same helper in browser smokes; macOS runtime validation remains outstanding.
5. Replace sharp metadata/validation and the LibRaw worker JPEG encoder. Only
   then remove sharp, platform packages, staging logic and the libvips notices,
   with a separate review of what native/licensed dependencies actually remain.

## Local validation and limits

The isolated Windows debug app uses separate PhotoCull data and WebView2
folders. The existing display-color script passes its grid, 7008-pixel TIFF
loupe, Dehancer association, native draft/settled/result ICC, before/after,
source-hash and export-pixel checks. The reference export was made with the
unchanged export codec from this checkout immediately before verification;
that comparison establishes repeatability, not a separate old-build comparison.

Physical `CopyFromScreen` capture returned the Windows lock screen, so physical
monitor/ACM comparison could not be completed unattended. The added explicit
`PHOTOCULL_COLOR_CAPTURE=cdp` option tests WebView2 screenshot pixels and labels
the report accordingly. It passes the original five-region reference tolerance;
it does not claim to verify physical display color. The normal script still
uses physical capture unless that option is explicitly set. Failed-run overlay
cleanup allows rerunning in the same isolated app.

[Windows app/color summary](measurements/rust-preview-windows.json).

`npm test` passes with copied real RAW fixtures enabled (the ordinary run
skips the two optional real-photo cases). All eleven
WSL browser smokes pass: general UI, Develop, finished-image export, RAW policy
cases, viewer, culling, settings, copy export, redesign, culling/Compare and the command/settings/backup workspace. Browser smokes use
the unchanged Node encoder and require no Rust helper. Windows `cargo test`
passes the Rust suite and `cargo build` / example builds have no Rust warnings.

The isolated real Windows export script passes the full-size three-RAW JPEG
batch, 16 resized RAW/edited codec variants, standalone TIFF→PNG16, monotonic
progress, ordered results, independent failure, skip-existing, metadata policy,
Display P3, JPEG byte limits and cancellation. Source-fixture hashes remain
unchanged. No owner settings, source photos or running installed app are touched.

Export scheduling results, including the negative throughput results and the
rejected first-file/buffer tradeoff, are in [the follow-up export table](recipes-export.md#export-scheduling-investigation--2026-11-06).

The offline notice generator leaves the inventory unchanged. Repository-wide
`cargo fmt --check` reports existing compact Rust formatting, starting in the
unchanged `examples/export_readback.rs`; the two new examples are rustfmt-formatted.
The preview quality regression guard was verified to fail when preview/full
quality was temporarily reduced to the thumbnail setting, then restored.

Combined-branch checks include the Node suite with both optional RAW cases,
eleven browser smokes, and Windows Rust tests (including the copied real TIFF).
The new boundary assertions extend the existing preview/cache regression test
rather than adding another owner for the same cache/pass-through behavior.

The production export scheduler retains the uniform half-core/max-three cap;
the slower per-format candidate is confined to the benchmark. After integrating source
sidecar autosave, the copy-only and fixed-file-count workspace smokes disable
source writes in their own temporary settings; welcome dismissal waits for its
asynchronous save before reading settings. No application behavior changes are
needed for those smoke assumptions.

Measurement files use anonymous sample identifiers; only labels were changed.
Use `scripts/prepare-samples.cjs` to copy arbitrary RAW/JPEG pairs into the
fixture aliases required by the reproduction scripts. Source folders always
come from explicit arguments or environment variables.

The culling integration requests the original oriented sRGB cache via
`analysis-source`, including republishing a cached JPEG after disk eviction.
Coverage uses the real PreviewService and verifies that external-edit paths
do not replace the original analysis pixels. Export worker selection and its
ordered-result/cancellation tests are unchanged from main.

Rebased onto `875089e`: 167 Node tests with optional copied RAW cases, eleven
WSL UI smokes, and 14 Windows Rust tests/build pass. The isolated native app
verifies a finite sharpness score reused from the cache, focus overlays at Fit
and 100%, Compare, Develop split view and unchanged source/copy hashes.
The required privacy scan reports only project copyright lines plus the
unchanged upstream license holder attribution in bundled notices.
