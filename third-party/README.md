# RAW decoder notices and source

PhotoCull's RAW fallback uses the unmodified `libraw-wasm-nothread` npm binary,
version 1.6.0-nothread.1, upstream commit
`d03be9f0eb0efda42e807a87045b4ac18ad8ca98`:
https://github.com/garbarok/libraw-wasm-nothread

The JavaScript/C++ wrapper is ISC licensed (see libraw-wasm-LICENSE.txt).
The binary statically includes LibRaw 0.22.1 and Little CMS 2.19.1. PhotoCull
selects LibRaw's CDDL 1.0 license option. LibRaw's copyright and both license
texts are included. The complete LibRaw source is supplied in
LibRaw-0.22.1-source.tar.gz (https://github.com/LibRaw/LibRaw/tree/0.22.1).
Its source notices cover dcraw, DCB/FBDD, X3F and Adobe DNG contributions.

libraw-wasm-build-source.tar.gz contains upstream wrapper source and build
scripts at the exact npm release commit, excluding generated binaries and
sample photos. `compileLibraw.sh` records the build configuration change
(removing OpenMP configuration), pinned dependency sources, and Emscripten
flags. PhotoCull has not modified that decoder binary or wrapper. To rebuild,
extract these scripts, install Emscripten and the native autotools prerequisites,
and run `FORCE_LIBS=1 bash compileLibraw.sh` as described upstream.

Little CMS is MIT licensed: https://github.com/mm2/Little-CMS/tree/lcms2.19.1
The Emscripten build enables JPEG, PNG and zlib ports. Their notices are included,
along with Emscripten's license. The upstream build does not pin its Emscripten
SDK/port revisions; the bundled port notices cover IJG JPEG 9f, libpng's combined
historical license, and zlib's license. We do not claim a bit-reproducible build.

Other runtime dependencies retain licenses in the packaged node_modules tree.
The bundled Node.js runtime's license, including its third-party notices, is
copied to `Node-LICENSE.txt` at build time. The Tauri shell's Rust crate licenses
are those of the crates listed in `src-tauri/Cargo.lock`; the system webview
(WebView2, WKWebView or WebKitGTK) is not bundled.

## Lightcraft Develop

The native Develop engine uses Lightcraft at commit
`d58b4d67238ef1aafd8e3394a9f8428a3d91e561`:
https://github.com/storytold/lightcraft

Preview sRGB ICC metadata uses `lightcraft-codecs`' profile writer, and Windows
display diagnostics use the same revision's `lightcraft-wincolor` crate. Both
are unmodified dependencies under the MIT / Apache-2.0 choice above; no source
from their display-transform implementation is vendored.

The histogram smoothing, scaling, grayscale detection and tonal-zone interaction in
`src/renderer/histogram.js` and `develop.js` are JavaScript adaptations of
`crates/ui-egui/src/panels/edit/hdr_flow.rs`, `panels/histogram.rs`, and
`crates/raster/src/histogram.rs`. Copyright (c) 2026 ArtCraft Team and the
LightCraft contributors. These adaptations use the MIT license option; the
complete license and upstream notice are in `lightcraft-LICENSE-MIT.txt` and
`lightcraft-NOTICE.txt`. Lightcraft’s brands, fonts, showcase images and optional
models are not included by these UI adaptations.

Lensfun data is not bundled. The native engine downloads it only on request,
with its CC BY-SA 3.0 notice stored beside the downloaded data.

## Lossy WebP

`webp` 0.3.1 (MIT OR Apache-2.0), https://github.com/jaredforth/webp,
wraps `libwebp-sys` 0.9.6. The latter compiles its bundled libwebp C sources
with `cc` on Windows and macOS; no system WebP library or image crate is
required (`webp`'s default image integration is disabled). PhotoCull uses
Lightcraft's existing decoder and lossless encoder. The added wrapper supplies
quality-based lossy encoding; PhotoCull writes ICC, EXIF and XMP RIFF chunks.
The wrapper's license texts and libwebp's BSD copyright and patent grant are
included as `webp-LICENSE-*`, `libwebp-COPYING.txt`, `libwebp-PATENTS.txt`.

## Complete runtime inventory

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is generated offline by
`scripts/notices.cjs`. `cargo-licenses.json` records lockfile-bound metadata and
license texts; `rust-license-supplements.json` preserves omitted workspace
licenses and provenance. `sources/*.crate` are unmodified MPL crate sources.
Native versions and upstream sharp-libvips notices are recorded separately.
The exact Windows ExifTool Strawberry Perl license archive is retained intact.
See [licensing](../docs/licensing.md) for LGPL/native-runtime source requirements
that must be resolved before distributing public installers.
