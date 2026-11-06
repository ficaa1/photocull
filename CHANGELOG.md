# Changelog

All notable changes to PhotoCull are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Searchable command palette, customizable shortcuts and portable settings bundles with import preview and backup.
- Skippable welcome, local diagnostics with rotating logs, and configurable camera-card detection.
- Resumable whole-card backups with SHA-256 verification and complete-backup status; optional verification for Copy picks.
- Autofocus-point overlays, persisted visibility and 100% zoom centered on recorded focus coordinates.
- Capture-time burst stacks, cached background sharpness ranking and confirmed, undoable keep-sharpest decisions.
- Two-to-four-photo Compare with linked zoom/pan, and draggable Develop before/after splits.

- MIT license, contributor and security guidance, third-party inventory and in-app About credits.
- Guarded public-repository build workflow and portable Windows symlink checks.
- Configurable external editors with format, color space, destination and cleanup controls.
- Recipe duplication/import/export and persistent finished-image export presets.
- Lossy WebP export, bounded parallel export jobs and faster AVIF encoding.

### Fixed

- Explicit sRGB preview ICC encoding for color-managed displays.
- Saved external-editor folder preferences and edited-result visibility across views.

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

[Unreleased]: https://github.com/ficaa1/photocull/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/ficaa1/photocull/releases/tag/v0.8.0
[0.7.0]: https://github.com/ficaa1/photocull/commit/134f146
[0.6.0]: https://github.com/ficaa1/photocull/releases/tag/v0.6.0
