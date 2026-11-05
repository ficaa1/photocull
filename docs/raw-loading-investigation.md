# RAW loading

Culling first uses embedded JPEG/TIFF previews or companion JPEGs. When the configured preview policy permits it, files without a usable preview enter a single-worker LibRaw WASM development queue. Results and failures are cached so navigation does not repeatedly develop the same unsupported file.

Native Develop uses Lightcraft independently of this fallback. See [third-party notices](../THIRD_PARTY_NOTICES.md) for decoder licenses and source, and the [validation guide](validation.md) for preview-stripping fixture preparation.
