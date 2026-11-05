## Runtime inventory and license choices

| Component | Version / identity | License | Distribution |
| --- | --- | --- | --- |
| Node.js | Official Node 24 runtime used for staging | MIT plus embedded third-party licenses | Sidecar; exact version and complete Node-LICENSE.txt added during staging |
| sharp | 0.35.5 | Apache-2.0 | Node addon |
| sharp-libvips | 1.3.4, libvips 8.18.7 | LGPL-3.0-or-later plus component licenses below | Unmodified dynamically loaded DLL/dylib/so; platform dependencies recorded in versions.json |
| ExifTool | exiftool-vendored 39.1.0; platform binary from lockfile | MIT wrapper; ExifTool/Perl: Artistic-1.0-Perl OR GPL-1.0-or-later; Windows native components have additional terms | Separate process; Artistic option selected; copyright Phil Harvey. Preserve vendored package notices and Perl runtime licenses |
| libraw-wasm-nothread | 1.6.0-nothread.1, LibRaw 0.22.1 | ISC wrapper; LibRaw CDDL-1.0 OR LGPL-2.1-or-later | CDDL-1.0 selected; unmodified static WASM; complete LibRaw and wrapper/build source archives in third-party/ |
| Little CMS | 2.19.1 in WASM | MIT | Static WASM; notice supplied |
| Emscripten JPEG/PNG/zlib ports | SDK port revisions not pinned upstream | IJG / libpng / Zlib; Emscripten MIT and University of Illinois/NCSA | Port notices supplied; see third-party/README.md for reproducibility limits |
| Lightcraft | d58b4d67238ef1aafd8e3394a9f8428a3d91e561 | MIT OR Apache-2.0 | MIT selected; native Rust crates and adapted histogram UI; notices supplied |
| Camera spectral matrices in Lightcraft | rawtoaces-data v1.1.0 / CIE 1931 | Apache-2.0 / CC-BY-4.0 | Derived by Lightcraft contributors (2026) from Weta Digital, scitech and National Physical Laboratory measurements; no raw measurements redistributed; see lightcraft-NOTICE.txt |
| Lensfun database | Latest data downloaded only on request | CC-BY-SA-3.0 | Not bundled; copyright Lensfun contributors; https://lensfun.github.io/ and https://creativecommons.org/licenses/by-sa/3.0/; no data modifications by PhotoCull |
| System webview | WebView2 / WKWebView / WebKitGTK | Operating-system/distributor terms | Not part of PhotoCull's bundled runtime |

### Redistribution conditions

The LGPL libvips shared library is replaceable in `backend/node_modules/@img/sharp-libvips-*/lib/`. PhotoCull imposes no restriction on reverse engineering for debugging modifications to that library. Replace it with an ABI-compatible build for the same platform and restart the app; its addon remains a separate module. Do not statically link it or add integrity enforcement that prevents replacement. LGPL-3.0 and its GPL-3.0 companion text are included in third-party/.

The prebuilt libvips shared library contains other libraries statically. Shipping notices and a dynamic boundary alone does not discharge its source obligations. Binary redistributors must provide the complete corresponding source and build scripts for that exact platform build (including LGPL/MPL internals), or a valid compliant source offer. Upstream build provenance: https://github.com/lovell/sharp-libvips/tree/v1.3.4 ; versions.json in each platform package records native dependency versions. **Release prerequisite: archive and distribute the exact native corresponding-source set; this repository currently supplies provenance and notices, not that complete set or a source offer.** Do not infer source compliance from an upstream URL alone.

MPL-2.0 Rust files remain under MPL; unmodified exact crate source archives are provided in third-party/sources/. No MPL files are copied into PhotoCull-owned code. CDDL LibRaw sources and build scripts already ship with the WASM fallback. GPL license text is supplied solely as the LGPL companion and an upstream alternative; PhotoCull does not select a GPL-only dependency. ExifTool runs separately under its Artistic option; the Windows Perl runtime includes GMP (LGPL), GCC runtime libraries (GPL with runtime exceptions) and other native modules. The upstream license archive is supplied as ExifTool-Strawberry-Perl-licenses.zip; its complete bundled-component provenance and corresponding sources still need release review.

Individual npm packages retain their full license/copyright files in packaged node_modules. Rust copyright/license texts are reproduced below; source archive filenames identify the crate/version. Node's complete runtime notices are copied from the official distribution at staging time. See third-party/README.md for decoder source and notices.

### Trademarks

Dehancer is a trademark of its owner; PhotoCull is not affiliated with or endorsed by Dehancer.
Adobe and Lightroom are trademarks of Adobe; PhotoCull is not affiliated with or endorsed by Adobe.
