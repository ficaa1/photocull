# Documentation

Start with the [project README](../README.md) for installation, quick start and building from source.

## Using PhotoCull

- [Workflow reference](workflow.md): culling, zoom/pan, deletion, XMP portability, Develop, hand-offs, copying, export and filenames.
- [Commands, settings and card backup](workspace.md): shortcuts, settings transfer, Welcome, diagnostics and verified backups.
- [External editors](external-editors.md): launch arguments, save detection, destinations and cleanup safeguards.
- [Recipes and finished-image export](recipes-export.md): recipe files, presets, codec options, worker cap and measurements.
- [macOS](macos.md): native build setup, unsigned-app opening and unverified behavior.

## Contributing and validation

- [Contributing](../CONTRIBUTING.md), [security reporting](../SECURITY.md), [changelog](../CHANGELOG.md) and [third-party licensing](licensing.md).
- [Validation guide](validation.md): automated checks and disposable native/RAW fixtures.
- [Commands, settings and backup validation](app-ux-validation.md): coverage and limits.
- [Interface design](ui.md) and [interface validation](ui-redesign.md): current layout, tokens, accessibility and smokes.
- [Display color](display-color.md) and [display color validation](display-color-validation.md): sRGB encoding, webview presentation and measured limits.

## Pipeline investigations and measurements

- [RAW loading](raw-loading-investigation.md) and [preview pipeline design](photomechanic-research.md).
- [Performance audit](performance.md): backend measurements and reproduction.
- [Rust display-preview investigation](rust-display-previews.md): experimental codec probe; production still uses sharp/libvips.
- [Measurement data](measurements/): JSON used by the export and preview investigations.
