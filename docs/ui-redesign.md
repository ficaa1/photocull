# PhotoCull UI redesign

## Plan

PhotoCull is a fast photography workbench: the photograph is the focal point, and the primary sequence is source → review → copy picks. The user explicitly wants less text and useful controls rather than decorative UI.

- Canvas `#111315`: neutral dark surround for photographs.
- Chrome `#202326`: compact source and metadata panes.
- Raised `#2a2e31`: interactive surfaces and dialogs.
- Ink `#e7e9e9`: clear, quiet native typography.
- Slate `#8fb3c9`: navigation, keyboard focus and selections.
- Ivory `#e1dfd7`: the primary copy action, distinct from green pick labels.

Type uses the platform's native UI family deliberately: SF on macOS and Segoe UI on Windows, with normal case, tabular counts, a 12–14 px working scale, and no decorative display family. No remote fonts or network assets.

Layout is a compact image workstation, with left-aligned source navigation and metadata. Pane toggles reclaim horizontal photo space; a grid-size slider supports scanning versus inspection.

```text
[ sources ][PhotoCull]  source path                [Open folder] [Copy picks]
[folder     ][Photos 36] [colors] [search] [grid size] [views] [details]
[filters    ][                                               ][capture]
[reviewed   ][                   photograph                  ][labels ]
[           ][                                               ][       ]
[settings ? ][filename        stars          Pick Reject      ][       ]
             [                filmstrip                      ]
             [save status]
```

## Critique before implementation

The previous green-tinted chrome, acid-green primary action, generous sidebar gutters and duplicated zoom percentages felt like a generic dark app. They also took space away from images. This pass uses neutral chrome and a restrained slate navigation accent, reserves green/red for actual decisions, reduces persistent bars, and makes the Fit action distinct from the percentage menu. Inline SVG icons replace mixed text glyphs. No hero text, cards, explanatory paragraphs or decorative animation are added.

## Functional refinements

- Source and details pane toggles, with renderer-local layout persistence.
- Contact-sheet thumbnail-size slider, with matching keyboard row navigation.
- Fit is a real Fit action; image click and Space remain zoom toggles.
- Stable rating and filmstrip nodes avoid rebuilding loaded thumbnails on every decision.
- Active filter, selected thumbnail and label states are keyboard- and color-independent.

## Screenshot critique and validation

The first 1440 × 960 screenshot confirmed that shorter bars and a 182 px source pane leave a larger uninterrupted photograph. The 1024 × 700 review/contact-sheet screenshots kept every primary action visible; pane toggles allow the image to take both side columns when wanted. Dialogs use the same neutral surfaces and tighter field alignment. The first metadata screenshot exposed a capture-before-paint artifact in the temporary screenshot helper, so the final captures wait for the active tab paint. No decorative motion was added.

The critique also caught a real interaction issue: switching to the contact sheet before a pending preview completed could leave the same image stuck on return. The image stamp now carries its request generation, so canceled generations restart while valid loaded images and in-flight requests are reused. Rating buttons and thumbnail image nodes remain stable across rating edits, verified by identity checks.

Actual Electron checks passed: `scripts/ui-smoke.cjs`, `scripts/settings-ui-smoke.cjs`, `scripts/viewer-ui-smoke.cjs`, `scripts/raw-ui-smoke.cjs`, `scripts/culling-ui-smoke.cjs`, and the reusable `scripts/redesign-ui-smoke.cjs`. The redesign check verifies pane width recovery, B/I shortcuts, retained DOM nodes, contact-sheet density, the 1024 × 700 layout, visible keyboard focus, fullscreen filmstrip reveal/hide, and layout persistence between launches. All reported zero renderer errors. The RAW check also exercised previewless sensor rendering, full-resolution zoom and disk-cache reuse after restarting.

The reusable check writes `artifacts/redesign-validation/redesign-ui-linux.json` and platform-suffixed screenshots such as `review-linux.png`, `compact-review-linux.png`, `grid-linux.png`, `copy-linux.png`, `metadata-linux.png`, `colors-linux.png` and `fullscreen-filmstrip-linux.png`. Earlier captures of the real Sony image and compact Nikon review remain as `review.png` and `compact-review.png`. The check accepts a packaged executable or macOS `.app` path for native platform validation.

The focus check exposed a missing outline on the div-based zoom viewport, which now has an explicit `:focus-visible` outline. PhotoCull's existing Tab shortcut still switches views outside inputs and dialogs; the check enters keyboard modality through a native input before inspecting the viewport's focus outline.

The frontend-design skill was read from `artifacts/skills/frontend-design/SKILL.md`, downloaded from the source linked by https://agenticskills.io/skills/frontend-design.

## Integration accessibility refinement

The parent integration restored normal Tab/Shift+Tab focus navigation and Space activation for focused buttons. G/E select grid/review and Ctrl+Tab toggles views. This supersedes the earlier Tab-to-switch-view shortcut. The reusable redesign check exercises focus order, reverse focus and keyboard pane activation.
