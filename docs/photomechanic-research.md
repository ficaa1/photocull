# Preview pipeline design

PhotoCull uses an embedded-preview-first pipeline: extract a camera JPEG, decode at the requested size, prioritize visible frames, cache useful representations, and upgrade detail on demand. RAW development is a separately gated fallback.

The implementation uses ExifTool, sharp/libvips and the LibRaw WASM fallback independently. It includes no Photo Mechanic code, binaries, assets or databases. Binary import and diagnostic-string observations do not establish another application's execution order or performance. No same-dataset performance comparison has been established.

See the [preview pipeline](../README.md#preview-pipeline), [performance measurements](performance.md) and [validation guide](validation.md) for PhotoCull's behavior and reproducible checks.
