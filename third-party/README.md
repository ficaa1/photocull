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
