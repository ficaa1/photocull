# Photo Mechanic: RAW-only files and missing previews

Function-level follow-up, 2026-10-30. This answers two different cases: no separate JPEG beside a RAW, and no usable preview inside the RAW.

**Finding:** the inspected Windows build reads embedded JPEG regions directly from the RAW file. It also has an enabled/disabled rendering fallback. The Windows startup code selects Adobe DNG Converter for that fallback; successful conversion produces a JPEG representation that Photo Mechanic stores in its render cache. If rendering is unavailable, smaller JPEG/TIFF thumbnails or placeholder/error images are possible fallbacks. Merely finding `Render_LibRAW` in the executable would have overstated what this Windows build actually does.

## Artifact and method

Target: `C:\Program Files\Camera Bits\Photo Mechanic Plus\Photo Mechanic Plus.exe`, PE32+ AMD64, 21,860,664 bytes. SHA-256 remains:

```text
247df2d84ac5240c0f4dd014b56f4eef1a9f3dd70294870e8790b5ee81860c7a
```

Used REA 6.8.0 with Ghidra 12.1.4, its default auto-analysis, and Temurin JDK 21.0.13. Tools were installed in `~/.local/share/photocull-analysis`, with per-process environment overrides. The original executable was not executed or modified. PhotoCull's application code and the camera card were not changed.

The first import reached REA's 330-second startup limit. After checking that cleanup was complete, the runtime startup budget was increased to 1,200 seconds, and the next import completed. No analyzers were disabled. The analysis session was reused for all subsequent function queries. GNU objdump provided independent checks of the critical call sites and settings bytes.

Ghidra's generated function names and types are incomplete because the matching PDB was not available. Names below are descriptive interpretations supported by calls and diagnostics, not recovered original C++ declarations. Decompiled pseudocode is evidence of the shipped machine code, not original source or observed runtime execution.

## 1. RAW-only does not require a companion JPEG

The generic fuzzy-JPEG/TIFF loader at `0x1400e7a60` gets the image's source filename and passes preview offsets/lengths to the JPEG file reader at `0x1404067f0`:

- Preferred preview location: image-info fields `+0x68c` / `+0x690`, conditional on `+0x69c`.
- Another embedded JPEG location: fields `+0x668` / `+0x66c`.
- A TIFF-thumbnail path is also present, with data-location fields `+0x680` / `+0x684` and dimensions `+0x662` / `+0x664`.

The reader at `0x1404067f0` opens the supplied source filename, seeks to the preview offset, allocates the specified preview length, reads that region, and passes the bytes to the JPEG buffer decoder at `0x140409970`. Its own diagnostics identify `NRFBasicJPEGLoadImage`, including failures to seek to an offset or read the requested byte count. The underlying file can be the RAW container; a neighboring `.jpg` is not required for this path.

This establishes the mechanism more directly than the earlier string-only inspection. It reads the pre-existing JPEG region rather than developing the sensor mosaic in that branch. Not every camera-specific loader was analyzed, so this is a confirmed generic path, not proof that every supported format uses identical offsets or code.

As an independent format sanity check, the public Nikon D3S NEF used for PhotoCull testing contains a 4256 × 2832 `JpgFromRaw`, a smaller `PreviewImage`, and a TIFF thumbnail, all inside the one `.NEF` file. Those measurements describe that fixture, not a Photo Mechanic runtime test.

## 2. Missing preview data can enter a rendering path

The generic loader calls the dispatcher at `0x1400e8050` **before** attempting its normal embedded JPEG/TIFF fallbacks.

The dispatcher receives a boolean indicating whether the preferred embedded JPEG is present and a request-flag mask. It considers rendering when that preview is absent or the request prefers a rendered representation. It then either queues work or tries to obtain a rendered bitmap synchronously. Rendering is still gated by enablement and the per-image blacklist.

The following is a deliberately simplified interpretation, with names assigned for readability:

```text
render_eligible = raw_rendering_enabled && !blacklisted(render_key)
prefer_render   = request_has_bit_0x02 && render_eligible

if prefer_render:
    try an existing cached rendered representation

if preferred_embedded_preview_is_missing || prefer_render:
    if request_has_bit_0x04:
        try cached bitmap, render if needed, then retry bitmap lookup
    else:
        queue rendering if eligible

if no rendered bitmap was returned and embedded decoding is permitted:
    try preferred embedded JPEG
    try other embedded JPEG
    try TIFF thumbnail
```

The precise symbolic names of flag bits were not recovered. Their effects were traced: `0x02` participates in render preference/eligibility; `0x04` selects the synchronous path; the outer generic loader's `0x01` controls whether embedded fallback is allowed. These should not be treated as public API constants.

The eligibility check at `0x1400e7f50` reads the global enabled state via `0x140108070`, builds an image/renderer key, and checks a blacklist through `0x14010a5d0`. The asynchronous route at `0x1400e8570` checks eligibility again before adding a render request. It does not automatically develop every RAW just because a separate JPEG is absent.

## 3. The verified Windows fallback is Adobe DNG Converter

This is the important correction to a conclusion based only on library filenames or strings:

- Preferences loading at `0x14047c160` reads `RawRenderingEnabled` with a false default, and reads `DNGConverterPath` / `ConvertDngConverterLocation`. An invalid converter path clears the rendering-enabled preference and stored path.
- Startup function `0x1401e8d80` sets the renderer preference to `1` and calls the render-cache initializer with renderer argument `1`:

  ```text
  DAT_140b5818c = 1;
  FUN_140107a50(DAT_140b58182 != 0, 1, ...);
  ```

- The initializer passes that argument to `0x140108090`, which stores it in `DAT_140b4a348`. That setting selects `Render_ADNG` in the key builder at `0x1401083e0`. The same builder contains an alternate `Render_LibRAW` string, but startup selects the Adobe branch in this inspected build.
- `RenderRawToCache`, identified by its own diagnostics at `0x1401086d0`, reads the configured converter path, constructs arguments including `-p2`, `-d`, and `-o ... .DNG`, and launches a child process through the process-runner interface.
- After successful conversion it calls `0x1400c9ec0` / `0x1400ca0a0` to extract an image from the temporary DNG. The latter parses TIFF headers/SubIFDs, checks reduced-image fields and dimensions, reads strip offset/byte-count tags, and returns the selected image bytes. The render-cache routine writes those bytes to a temporary cache file, renames it into place and records dimensions.
- Recognized unsupported-format messages place the image key in a blacklist, avoiding repeated attempts through this route.

Thus the missing-preview fallback I could verify on Windows is **render through Adobe DNG Converter, then extract/cache the produced JPEG**. The mere presence of `libraw.dll` or an unused alternate renderer label is insufficient evidence of a working built-in LibRaw fallback in this executable. Other builds or platforms may differ.

## 4. What happens when rendering cannot provide an image?

With rendering disabled or the image blacklisted, the render helpers return failure or do not enqueue work. The generic loader can still try its other JPEG/TIFF thumbnail representations when the request permits them.

The cache-selection routine at `0x140262170` has an explicit branch for neither preview nor thumbnail being available. It calls an error-bitmap factory and marks the resulting representation as an error. A separate generic wrapper at `0x1400e74c0` can create a fallback bitmap after loader errors. The exact placeholder seen for a particular camera/plugin/request is not established by this static investigation.

This means “no embedded JPEG” does not necessarily mean “nothing visible”: a smaller TIFF thumbnail can still exist. But the application cannot manufacture a detailed preview for an unsupported or unrenderable RAW merely by caching.

## Corroboration from Camera Bits

Camera Bits' [RAW rendering documentation](https://docs.camerabits.com/support/solutions/articles/48000361383-raw-rendering-in-photo-mechanic) describes embedded previews as the ordinary RAW-viewing path and enabling rendering for files with missing or low-resolution previews. Its [Render Cache preferences documentation](https://docs.camerabits.com/support/solutions/articles/48001146201-render-cache-preferences) documents Adobe DNG Converter on Windows and retaining generated previews in the render cache. This corroborates the interpretation; it is separate evidence from the specific binary inspected here.

## Evidence index

Complete local REA responses, derived decompiler output and the exported bundle are retained under the Git-ignored `analysis/evidence/` directory. They are not part of the app distribution.

| Evidence | Scope |
| --- | --- |
| `ev_b96720d581057e3e19c7547d34922b3c61601b6d81753f970f2ff04c26f6fc55` | Rendering dispatcher at `0x1400e8050`. |
| `ev_68960bc5dafa518fd5d363759df6f9afb1ec604fd110e6d494b5fb9b941332ba` | Generic loader, cache worker, render-to-cache routine, JPEG loader, synchronous/asynchronous rendering helpers. |
| `ev_d80d40dd7172a46e6e98f8e41112512c0b916d13feeeabc4eeed2edfa38e74d1` | Enabled flag, renderer selector, eligibility/blacklist and rendered-cache read path. |
| `ev_6680a2906c090443ba0973fed1a5e86acaa9ad9abf5def1bd14dc054c35d25d8` | Preferences, JPEG range reader and DNG extraction wrapper. |
| `ev_9f6fb0ce0ef611c2e35a40d76af95e52130f3d34a0b7fe4e7a4a3d74ac21c9f3` | TIFF/DNG image extraction and availability helpers. |
| `ev_f5f2b2dcf522a195fa72ecf2f18a36c0576fa8f2c62e8975995a50527c621351` | Windows startup forcing renderer argument `1`. |
| `ev_0fd17e4f5577cb4367099d83fd5445ce021dd0ed048b727ef64f0bcf3fff9356` | JPEG buffer decoder reached after reading the embedded range. |

Independent assembly checks include `raw-windows-forces-adobe-renderer.txt`, `raw-render-to-cache-assembly.txt` and `raw-generic-fuzzy-loader-assembly.txt`. The working ledger is `raw-investigation-ledger.json`.

## Implication for PhotoCull

Our embedded-preview-first approach matches a mechanism confirmed in the inspected Photo Mechanic code. At investigation time our MVP lacked its gated rendering fallback, multiple embedded JPEG/TIFF representations, render-result caching and unsupported-image blacklisting. PhotoCull 0.2.0 now implements those mechanisms independently; see the [preview pipeline](../README.md#preview-pipeline) and [validation](validation.md).

PhotoCull uses a LibRaw WASM worker for fallback development and caches the result. This is an independent decoder choice; Photo Mechanic's verified Windows path uses the Adobe-converter subprocess described above.

No runtime experiment with a preview-stripped RAW was performed against Photo Mechanic. Subsequent PhotoCull 0.2.0 validation did render a Sony ARW with its embedded JPEG payloads zeroed; that validates our implementation, not Photo Mechanic's runtime behavior. No same-dataset speed comparison, full camera-plugin audit, or LibRaw execution test was performed. These findings concern the code paths above in the one supplied Windows build.
