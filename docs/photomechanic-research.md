# What the supplied Photo Mechanic binary tells us

This document records the **initial static-inspection pass**. A subsequent [function-level RAW-loading investigation](raw-loading-investigation.md) now traces the actual loader and rendering fallback with REA/Ghidra, including the Windows startup selecting Adobe DNG Converter. Read that follow-up for the stronger, current findings about RAW files without JPEG previews.

Inspected `C:\Program Files\Camera Bits\Photo Mechanic Plus\Photo Mechanic Plus.exe` from WSL on 2026-10-30. This is a 21,860,664-byte PE32+ AMD64 image. Its SHA-256 is:

```text
247df2d84ac5240c0f4dd014b56f4eef1a9f3dd70294870e8790b5ee81860c7a
```

The investigation used REA 6.8.0's PE import parser and desktop-installation scanner, plus a separate read-only extraction of ASCII and UTF-16LE diagnostic strings. Photo Mechanic was not executed, patched, or copied into this project. No native decompiler was installed. Raw local observations are retained under the Git-ignored `analysis/evidence/` directory; the report below separates those observation sources.

## Observed evidence

REA's `inspect_pe_imports` identified 62 imported DLL descriptors. Among them:

- `ippi.dll`: `ippiResizeAntialiasing_8u_C3R`, `ippiResizeAntialiasingLanczosInit`, `ippiResizeNearest_8u_C3R`, `ippiResizeGetSize_8u`, and related resize/warp primitives.
- `ipps.dll`: `ippsMalloc_8u` and `ippsFree`.
- `tiff.dll`: `TIFFReadScanline`, `TIFFScanlineSize`, `TIFFClientOpen`, and other TIFF primitives.
- `jpeg62.dll`: imports by ordinal. The import parser does not identify the JPEG functions behind those ordinals.
- `KERNEL32.dll`: thread, semaphore, file-read, and memory-mapping APIs, including `CreateThread`, `SetThreadPriority`, `ReadFile`, `CreateFileMappingW`, and `MapViewOfFile`.

Imports establish declared dependencies, not hot-path reachability or relative contribution to performance. REA's installation scan examined 6,201 entries and probed 5,630 files within its bounded scan. Ordinary directory inspection also found `turbojpeg.dll`, `libraw.dll`, and Intel IPP libraries. A DLL being present does not prove the executable calls it.

The following **ordinary string observations**, with file offsets in this exact executable, are stronger architectural clues than the dependencies alone. They are not decompiled code or REA-generated Evidence:

| File offset | Embedded diagnostic text or identifier | Implication to investigate |
| --- | --- | --- |
| `0x149beee` | `Use embedded preview` | There is an embedded-preview choice in this build. |
| `0x7d1ff8` | `GalleryViewPrecacheItems():` | Gallery precaching is represented in diagnostics. |
| `0x7d2020` | `GalleryViewPriorityItemsForDocumentCellWithPreview()` | The gallery distinguishes preview-related priorities. |
| `0x838a60` | `PMCacheWorker::run: worker %d exception in do_work` | Image-cache work has named background workers. |
| `0x838c40` | `set_memory_cache_size_limit_mb` | Memory cache sizing is explicit. |
| `0x838c90` | `set_disk_cache_size_limit_mb` | Disk cache sizing is separate. |
| `0x839150` | `LoadFileScaled: loaded bmap at reduced size ... wanted_size ... is_precache` | Reduced-size loads and prefetch status are distinguished. |
| `0x839560` | `load_best_fastest: PRECACHE work would be wasted, ignoring request` | Some speculative work can be rejected. |
| `0x839720` | `load_best_fastest: before load full-size: haveTransientDraft` | Temporary and full-size representations coexist in diagnostics. |
| `0x83a180` | `found potential standin size ... is_transient` | A stand-in representation can be considered. |
| `0x83a520` | `local_create_work_queue: request: pri ... vis ... vsoon ... size` | Queue entries include priority, visibility and size fields. |
| `0x839f68` | `prune oldest image info` | Some cached image information can be pruned. |
| `0x7cd070` | `DocumentLoadMetadataBatch(): nextIndex ... batchSize` | Metadata can be loaded in batches. |
| `0x7e5e98` | `RenderCacheWorker` | RAW rendering has a named cache worker. |

The binary also contains user-facing descriptions of memory, disk, and render caches, and a separate sort-cache database (`PMSortCache_3.db`). Their exact scheduling behavior, cache key format, algorithm implementation and current defaults have not been recovered.

## Interpretation for this MVP

The evidence is consistent with a pipeline that minimizes time to the first useful image: get an existing preview, decode at the needed size, prioritize visible frames, retain useful representations, and load a higher-quality representation later. Culling can use the JPEG already produced by the camera rather than developing the RAW sensor mosaic for each frame. That is a design conclusion for PhotoCull, not a claim that every Photo Mechanic path behaves identically.

PhotoCull implements these general principles independently:

1. ExifTool extracts a RAW's embedded JPEG; a companion JPEG is a fallback. No RAW demosaicing is attempted.
2. sharp/libvips produces 400 px thumbnails and 2560 px fit previews, using native shrink-on-load and orientation handling. Original embedded dimensions are available on demand.
3. The UI displays a thumbnail while a fit preview becomes ready. Neighboring previews are prefetched; active images outrank speculative work, and obsolete pending large-image jobs are canceled.
4. Content representations are cached in bounded compressed-image memory and a soft-bounded disk cache. Keys incorporate source and companion file identities.
5. The contact sheet mounts only visible/nearby rows. Capture metadata is requested lazily for the selected frame.
6. Picks, rejects and ratings are small local state updates. XMP publication is a separate user action, so photo metadata writes do not sit on the image navigation path.

These techniques are sufficient for a useful first culling app. PhotoCull has not established parity with Photo Mechanic's color management, RAW support, metadata compatibility, focus assessment, performance, or large-catalog behavior.

## What remained unknown after the initial pass

- No function-level disassembly/decompilation or call-graph analysis was performed. The diagnostic names do not prove execution order or control flow.
- No Photo Mechanic runtime traces, CPU profiles, IO traces, or same-dataset timing comparison were recorded. There is no measured attribution of its speed to any single library or technique.
- The imported memory-mapping APIs could be used elsewhere; mapping the image hot path is unverified.
- JPEG ordinal imports were not resolved against DLL exports. Bundled `turbojpeg.dll` is a clue, not proof of a particular decoding path.
- Hardware, storage, RAW camera settings and preview dimensions materially affect browsing. The included measurements only characterize PhotoCull's tested datasets and host.

The subsequent RAW-loading investigation installed local Ghidra/JDK tools and followed selected loader/cache functions. A separate controlled runtime comparison could still measure cold open, warm navigation, 100% preview, memory use and disk IO on identical copies of a real shoot.

## REA installation verification

- Linux Node.js 24.22.2 installed through the existing `nvm`.
- `npx rea-agents@latest setup --client codex` resolved to REA 6.8.0. The reviewed plan added the MCP registration and bundled workflow skill.
- Existing Codex settings were preserved, with backup `/home/alex/.codex/config.toml.rea.backup`.
- MCP command is `npx -y rea-agents@6.8.0 mcp`, with its server environment PATH prefixed by `/home/alex/.nvm/versions/node/v24.22.2/bin` to avoid the pre-existing Windows npm/npx entries.
- Final scoped doctor check: healthy; registration and skill aligned.
- An independent stdio MCP client initialized server `rea` version `6.8.0`, discovered 229 tools, and successfully called `inspect_pe_imports` for the supplied executable.
- The already-running coding-agent session cannot gain newly registered MCP tools without reconnecting. CLI analysis and the independent MCP check worked during this session. Restart/reconnect the agent to expose REA directly.

The REA workflow was followed from its installed [skill instructions](/home/alex/.agents/skills/reverse-engineer-anything/SKILL.md), with ordinary shell observations identified separately.
