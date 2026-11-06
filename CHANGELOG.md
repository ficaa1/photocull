# Changelog

All notable changes to PhotoCull are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.2] - 2026-11-06

### Fixed

- The macOS app is ad-hoc signed, so a downloaded copy no longer opens as "damaged". The first launch asks for **Open Anyway** in Privacy & Security. Builds are still not notarized.

## [0.9.1] - 2026-11-06

### Fixed

- Hand-off files stay relative to the photo folder when it is opened through a symlink, junction, Windows short path or macOS `/var` alias, so edits survive moving the folder.
- Copy picks resolves each original to its real path, accepting equivalent source paths and refusing links that lead outside the source folder.

## [0.9.0] - 2026-11-06

### Added

- Searchable command palette with recent commands and filename navigation, customizable shortcuts, and current bindings in Help.
- Portable settings bundles with import preview, path mapping and a restorable backup; modal, skippable Welcome and local diagnostics with rotating logs.
- Resumable whole-card backups with SHA-256 verification, complete-backup status and explicit rechecking; optional hash verification for Copy picks.
- Configurable camera-card layouts, manual card folders and backup naming.
- Portable XMP autosave for decisions, colors, RAW adjustments, effective recipe settings, external-editor attribution and hand-off records; source-write policy and newer-sidecar merging when reopening folders.
- Autofocus-point overlays and focus-centered 100% zoom; capture-time burst stacks, cached preview-detail ranking and confirmed, undoable Keep sharpest.
- Two-to-four-photo Compare with linked zoom/pan, and draggable Develop before/after splits.
- Configurable external editors with TIFF/PNG/JPEG hand-offs, color space, multi-file launch, exit/watch save detection, destinations and confirmed cleanup.
- Recipe duplication/import/export, finished-image export presets and lossy WebP export.
- MIT license, contributor/security guidance, offline third-party inventory and in-app About credits.
- Newcomer installation and workflow guide, documentation index and public project metadata.

### Changed

- App bar, split menus, view toolbar, sidebars, thumbnail badges and dialogs use a consistent compact layout; the grid-size control stays in the status bar.
- Tab/Shift+Tab moves focus; menus own keyboard input, support typeahead and return focus when closed. View switching uses G/E/D or Ctrl+Tab.
- Finished-image exports run at half the logical core count, rounded down, with one to three simultaneous photos. AVIF defaults to Faster; lossless WebP remains available.

### Fixed

- Explicit sRGB conversion and ICC tagging for generated previews, including 16-bit TIFFs, while leaving display conversion to the webview/OS.
- Remembered external-editor folders, saved-result visibility across views and preview file handles during replacement/cleanup.
- XMP merges preserve unrelated application metadata and distinct RDF subjects; shared-sidecar conflicts and background write failures are reported without losing local decisions.
- Relative hand-off paths survive moving photo trees; missing hand-offs fall back to original previews.
- Compare selection stays valid across filters and sessions, linked zoom resets for each new comparison, and burst decisions refresh through undo/redo.
- Autofocus overlays use orientation/crop-aware geometry, including Sony preview-coordinate dimensions.
- Welcome holds automatic card opening until a choice is made; explicit folder/editor/card choices also prevent late discovery from overriding that launch.
- Filename navigation works across empty filters, and system fullscreen shortcuts remain available while editing text.

## [0.8.0] - 2026-11-05

### Added

- Lightcraft RAW development with recipes, per-photo adjustments, interactive histograms and clipping warnings.
- Loupe zoom and pan, Dehancer TIFF hand-off and saved-result detection.
- JPEG, JPEG XL, TIFF, PNG, AVIF and WebP export with color, metadata and naming controls.
- Opt-in Lensfun database download and lens corrections.
- Windows and Apple Silicon installer builds and tag release uploads.

### Fixed

- Source protection through symlinked export paths.
- macOS UI smoke setup and bundled Node license distribution.

## [0.7.0] - 2026-11-05

### Added

- Tauri desktop shell using the system webview and a bundled Node sidecar.
- Photo deletion with in-app Trash, multiple selection and adjustable preview-cache limits.

### Fixed

- Windows sidecar startup and cross-platform build setup.

## [0.6.0] - 2026-10-30

### Added

- Preview-first RAW and JPEG culling, ratings, picks, rejects and XMP sidecars.
- Gated WASM RAW fallback, cached rendering and unsupported-file suppression.
- Settings and presets, copy export with naming and embedded metadata.
- Cross-platform packaging, UI smoke checks and performance measurements.

0.7.0 is reconstructed from the versioned Tauri migration commits; it has no release tag. 0.6.0 and 0.8.0 correspond to the repository tags and 0.8.0 release notes.

[Unreleased]: https://github.com/ficaa1/photocull/compare/v0.9.2...HEAD
[0.9.2]: https://github.com/ficaa1/photocull/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/ficaa1/photocull/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/ficaa1/photocull/releases/tag/v0.9.0
[0.8.0]: https://github.com/ficaa1/photocull/releases/tag/v0.8.0
[0.7.0]: https://github.com/ficaa1/photocull/commit/134f146
[0.6.0]: https://github.com/ficaa1/photocull/releases/tag/v0.6.0
