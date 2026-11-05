# Third-party licensing

PhotoCull-owned code uses MIT, with the copyright line style used in the owner's public repositories. Those repositories' GPL/AGPL choices do not apply here. The reference LICENSE contains standard GPL text; its README identifies the holder as `Copyright (C) 2026 Filip Biljic`.

## Reproduce the inventory

`npm run notices` uses only package-lock.json, Cargo.lock and reviewed metadata/texts in third-party/. It needs neither node_modules, Cargo nor a network connection. `node scripts/notices.cjs --check` fails when generated output is stale. Cargo metadata is tied to a normalized Cargo.lock SHA-256; npm license expressions come directly from its lockfile.

After changing Rust dependencies, cache their sources with `cargo fetch --locked`, then run `node scripts/notices.cjs --refresh`. This uses `cargo metadata --locked --offline --format-version 1` to collect all target crates and license files. Review upstream workspace license files for crates that omit them from their package and update `third-party/rust-license-supplements.json`; each supplement identifies its source URL/revision. `--metadata FILE` accepts the same Cargo JSON from another build machine without retaining machine paths. Refresh the exact unmodified `.crate` source archives for MPL dependencies in `third-party/sources/` from Cargo's registry cache.

Native libvips versions for every locked platform are recorded in `third-party/native-versions.json`, extracted from each official npm tarball's `versions.json`. Update them and the upstream sharp-libvips notices when changing that dependency. The generated inventory includes build/test and optional target dependencies conservatively; it is not a claim that every lockfile crate is linked into every installer.

## Packaging

Staging verifies the offline generated notice, copies it and LICENSE into the backend, and includes third-party/ with source archives, licenses and the exact official Node runtime license. Tauri also installs LICENSE and THIRD_PARTY_NOTICES.md as top-level resources. Settings → About reads the bundled local notice; repository and website links open in the system browser.

Production node_modules retain their package license files. `ExifTool-Strawberry-Perl-licenses.zip` is copied unchanged from exiftool-vendored.exe 13.60.0; it includes licenses for the broader Strawberry distribution, including components not necessarily shipped in this reduced runtime. Its inclusion is not evidence that those extra components are used.

## Release prerequisites and remaining risks

- The prebuilt libvips shared library has LGPL-3.0 obligations, including complete corresponding source for statically included LGPL components. The dynamic boundary, replaceability statement, license texts, build provenance and version inventory are present. **Before public binary redistribution, supply the exact complete source/build set or a valid source offer.** The upstream repository URL alone does not satisfy this. PhotoCull imposes no restriction on reverse engineering to debug replacement libraries.
- Windows ExifTool ships a reduced Strawberry Perl runtime, including GMP, GCC runtime libraries and other XS/native modules. Preserve the bundled license archive and review corresponding-source requirements for those binaries, plus the package's downstream ExifTool patches, before redistributing installers. GPL runtime exceptions/dual licensing must be checked per component; npm's MIT packaging label does not cover them all.
- MPL-2.0 Rust dependencies are unmodified and their exact source archives ship with the app. Their files keep MPL; this does not relicense PhotoCull-owned files.
- LibRaw's CDDL-1.0 option is selected for the WASM fallback, with the exact LibRaw and wrapper/build source archives and notices included. Its alternative LGPL option is not used. Emscripten SDK/port revisions are not fully pinned upstream, so bit-reproducible WASM rebuilding is not claimed.
- Lightcraft uses the MIT option where offered. `lightcraft-fetch` declares Apache-2.0 only; its full workspace Apache license and notices are retained. All transitive crate license expressions are listed rather than assuming every Lightcraft-related crate is MIT.
- Lensfun data stays outside installers. Downloads retain upstream attribution and CC BY-SA 3.0 licensing beside the data, with credits at the download control and in About. If modified data is redistributed later, preserve attribution and share it under the same license.

The inventory found no required GPL-only license for PhotoCull-linked Rust/npm application code. This is not a declaration that the native binary supply chain is permissive-only or ready for redistribution without the source steps above.
