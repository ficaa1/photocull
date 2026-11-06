# Interface design notes

PhotoCull is a dark, keyboard-first photo tool. The photograph is the brightest thing on screen; chrome stays neutral and quiet so it does not tint colour judgement. All styling lives in `src/renderer/styles.css`, with tokens on `:root`.

## Layout

```text
[≡] PhotoCull  [Open folder|▾]  path…     [Grid|Review|Develop]     [Copy picks] [Edit in X|▾] [Export…] [≡]
[sources   ][Photos 15  Expand burst  Keep sharpest     ● Focus ready  AF  Compare | colors  search ][details  ]
[cards     ][                                                                               ][navigator]
[filters   ][                              photograph                                       ][capture  ]
[reviewed  ][name                         ★★★★★                          Pick  Reject  ↺   ][labels   ]
[hand-off  ][filmstrip                                                                      ][         ]
[settings ?][save status                                              thumbnail size (Grid) ][         ]
```

- **App bar** (44 px): pane toggles at both ends, source actions on the left, the view switch centred, output actions on the right. **Export…** is the one primary button. **Open folder** and **Edit in…** are split buttons; their menus hold the less frequent actions (Back up card or folder…, Treat folder as card, other editors, Configure editors…). The editor menu stays available without a RAW selection: its edit items are disabled but Configure editors… still works. Treat folder as card is disabled when the session is already a card, in the menu and the palette alike. Every menu action, including each configured editor, is also in the command palette (Ctrl/Cmd+K).
- **View toolbar** (44 px): the current filter's title and count, then context actions (burst, Trash, originals). On the right: the analysis status, AF and Compare toggles, colour filter and search.
- **Status bar**: save status on the left; in Grid, the thumbnail size slider on the right, so it is available at every window width.
- **Sidebars**: Sources (196 px) and Details (248 px), each hidden with B / I. Develop replaces Details with its own panel.

Labels give way before controls as the window narrows. At 1320 px the analysis status keeps only its dot (the text stays in its title and live region) and Compare becomes an icon, so the toolbar stays on one row at 1280 px; search shrinks before anything wraps. Copy picks and AF become icon buttons at 1200 px; at 1150 px the path and view-switch labels go, Pause/Resume/Retry analysis becomes an icon button and the colour filter narrows to 100 px. If the right-hand group still cannot fit at its minimum it moves below the title as one group, and the panes become overlays below 900 px. Hidden labels fall back to each button's title as its accessible name.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--canvas` | `#0e0f10` | Photo surround, inputs, wells |
| `--app` | `#141516` | Window background |
| `--panel` | `#1b1c1e` | Sidebars, app bar, dialogs, thumbnails |
| `--raised` / `--hover` / `--pressed` | `#242629` / `#2c2f32` / `#33363a` | Default button, hover, press |
| `--line` / `--line-strong` | `#2c2e31` / `#3f4246` | Dividers / button borders |
| `--field-line` | `#666b71` | Input, select and textarea borders |
| `--text` / `--text-2` / `--muted` | `#e8e9ea` / `#b7bbbf` / `#8e9398` | Primary, secondary and tertiary text |
| `--accent` (+ `-bg`, `-line`) | `#8fb3c9` | Focus ring, current item, selection, pressed toggles |
| `--ivory` | `#e6e3da` | Primary action only |
| `--green` / `--red` / `--star` / `--warn` | | Pick, reject, rating, caution |
| `--star-empty` | `#6b7177` | Unset rating stars |
| `--danger` / `--danger-hover` | `#a3443f` / `#8f3a36` | Destructive button, white text |
| `--overlay` | `#101112d9` | Chips and controls over the photo |

Greys are neutral (no hue) so they do not bias the photo. Pick green is reserved for picks and positive states; selection and "on" states use the accent. Contrast was measured for each resting, hover and pressed pairing:

- Text meets WCAG AA (4.5:1). `--text` is at least 9.6:1 on every surface, including hover, pressed and accent-selected rows; `--text-2` at least 6:1; `--muted` 4.9–6.2:1 on panel, app, canvas and raised surfaces. Muted text is not used on hover or accent backgrounds. Danger buttons are 6.1:1 resting and 7.4:1 on hover; the primary button is 13:1 or more.
- Non-text graphics meet 3:1: input borders (`--field-line`) are 3.2–3.6:1 against panel, app and canvas; empty rating stars 3.5–3.7:1; the focus ring 7.7:1.
- Button outlines (`--line-strong`) are below 3:1 by design. Buttons are identified by their labels and fills rather than their borders.
- Chips over the photo use a dark overlay. Their contrast depends on the photo and is not guaranteed over very dark areas.

- **Spacing**: `--s1`…`--s6` = 4, 8, 12, 16, 24, 32 px.
- **Radius**: `--r1` 4 px (controls), `--r2` 6 px (cards, menus, panels), `--r3` 10 px (dialogs).
- **Type**: the platform UI font (Segoe UI, SF, Ubuntu/Cantarell/Noto on Linux); no bundled or remote fonts. Sizes 10 (thumbnail badges only), 11 (metadata, captions), 12 (body, controls), 13 (titles), 15 (dialog titles). Counts and values use tabular figures.
- **Controls**: 28 px tall (`--control`); 24 px for dense rows in Develop and Compare; 32 px for empty-state and Develop's hand-off button. Smaller graphics sit inside a 24 px hit area: sliders are 24 px tall around a 2 px track, colour labels are 16 px dots in 24 px buttons, the histogram clipping toggles are 24 px.
- **Icons**: 24-unit outline icons, 1.65 stroke, drawn at 14–16 px with `currentColor`.

## Components

- **Buttons**: `.button` (bordered, default), `.button.primary` (ivory, one per surface), `.button.quiet` (borderless in toolbars and over the photo; outlined inside dialogs, panels and Compare so it still reads as a button), `.button.danger` / `.danger-quiet`, `.icon-button`, `.text-button` for links. `aria-pressed=true` gives any button the accent "on" state. Hover lightens, press darkens and moves down half a pixel. Disabled primaries fall back to the neutral surface.
- **Menus**: `.split-button` + `.menu` with `role=menu` items. Arrow keys, Home/End, letter typeahead, Escape (returns focus to the trigger) and Tab work inside the menu. While a menu has focus it consumes every key, so decision, rating and navigation shortcuts never fire. Choosing an item returns focus to the trigger first, so a dialog it opens hands focus back there when closed. Pointer-down outside closes the menu; background renders never do.
- **Dialogs**: `.dialog-header` (title + close), content, then `.dialog-actions` right-aligned with the primary action last and a quiet secondary (Open folder, Show in folder) pushed to the left. Settings uses a side tab list with a scrolling page and a fixed footer. The Export footer always shows the destination with a Change… control beside the Export button. The welcome card is a modal dialog: it takes focus (Open folder…), keeps Tab inside, and Escape dismisses it like Skip. A connected card never opens automatically behind it: automatic opening waits for the Welcome decision, follows Skip or Escape, and is suppressed for the rest of that launch when the user chooses another path, including cards discovered after the choice. Choose camera card reveals Sources (docked or overlay), opens a single card directly, focuses the list when there are several, and explains what to do when no camera card is connected while keeping any other volumes reachable.
- **Over-photo chips** (`.chip`, zoom group, wipe labels): `--overlay` background, no border, 11 px.
- **Thumbnail badges** (grid and filmstrip share them): top-right row holds sharpest ◆, burst count and colour label; bottom row holds develop marks (left) and flag + stars (right). Flag and stars are separate glyphs: the flag is green or red, stars are always gold. Rows never wrap. The filmstrip index sits top-left. In the filmstrip the "Sharpest" word is dropped. Each badge keeps a hover title, and each thumbnail exposes the same status (flag, rating, colour, burst, sharpest, edits) as its accessible description.
- **Analysis status**: a dot plus short text. Accent and pulsing while running, green when finished, amber on failures, grey when paused.
- **Develop**: section headers with a chevron, 2 px slider tracks with a 12 px thumb, numeric fields that only show a border on hover or focus. Recipe keeps the selector, Save as and Reset photo to recipe visible; library management (update, duplicate, default, delete, import, export) is in the Recipe library… menu, which spans the action row so it never leaves the panel. Each of these actions is also a Develop command in the palette.

## Rules

- One primary action per surface. Destructive actions are red and never primary.
- Keep element ids; the UI smokes and keyboard commands depend on them.
- Every action needs a mouse path, a command palette entry and, where it is frequent, a shortcut.
- Focus is always visible (`:focus-visible`, 2 px accent), including labels that wrap hidden file inputs. Targets are at least 24 px.
- Motion is short (80–160 ms) and limited to hover, menus, dialogs, toasts and the fullscreen dock; `prefers-reduced-motion` removes transitions and animations.
- Over the photo, use the overlay surface and keep chips out of the image centre.
