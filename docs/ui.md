# Interface design notes

PhotoCull is a dark, keyboard-first photo tool. The photograph is the brightest thing on screen; chrome stays neutral and quiet so it does not tint colour judgement. All styling lives in `src/renderer/styles.css`, with tokens on `:root`.

## Layout

```text
[≡] PhotoCull  [Open folder|▾]  path…     [Grid|Review|Develop]     [Copy picks] [Edit in X|▾] [Export…] [≡]
[sources   ][Photos 15  Expand burst  Keep sharpest     ● Focus ready  AF  Compare | colors  search ][details ]
[cards     ][                                                                               ][navigator]
[filters   ][                              photograph                                       ][capture  ]
[reviewed  ][name                         ★★★★★                          Pick  Reject  ↺   ][labels   ]
[hand-off  ][filmstrip                                                                      ][         ]
[settings ?][save status                                                                    ][         ]
```

- **App bar** (44 px): pane toggles at both ends, source actions on the left, the view switch centred, output actions on the right. **Export…** is the one primary button. **Open folder** and **Edit in…** are split buttons; their menus hold the less frequent actions (Back up card or folder…, Treat folder as card, other editors, Configure editors…). Every menu action is also in the command palette (Ctrl/Cmd+K).
- **View toolbar** (44 px): the current filter's title and count, then context actions (burst, Trash, originals). On the right: the analysis status, AF and Compare toggles, colour filter, search and the thumbnail size slider in Grid.
- **Sidebars**: Sources (196 px) and Details (236 px), each hidden with B / I. Develop replaces Details with its own panel.

Labels give way before controls as the window narrows: the path and view-switch labels go at 1150 px, Copy picks and AF become icon buttons at 1200 px, and the panes become overlays below 900 px. Hidden labels fall back to each button's title as its accessible name.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--canvas` | `#0e0f10` | Photo surround, inputs, wells |
| `--app` | `#141516` | Window background |
| `--panel` | `#1b1c1e` | Sidebars, app bar, dialogs, thumbnails |
| `--raised` / `--hover` / `--pressed` | `#242629` / `#2c2f32` / `#33363a` | Default button, hover, press |
| `--line` / `--line-strong` | `#2c2e31` / `#3f4246` | Dividers / control borders |
| `--text` / `--text-2` / `--muted` | `#e8e9ea` / `#b7bbbf` / `#8e9398` | Primary, secondary and tertiary text |
| `--accent` (+ `-bg`, `-line`) | `#8fb3c9` | Focus ring, current item, selection, pressed toggles |
| `--ivory` | `#e6e3da` | Primary action only |
| `--green` / `--red` / `--star` / `--warn` | | Pick, reject, rating, caution |
| `--overlay` | `#101112d9` | Chips and controls over the photo |

Greys are neutral (no hue) so they do not bias the photo. Pick green is reserved for picks and positive states; selection and "on" states use the accent. Contrast: `--muted` is at least 4.9:1 on every neutral surface and `--text-2` at least 7.8:1, so text meets WCAG AA.

- **Spacing**: `--s1`…`--s6` = 4, 8, 12, 16, 24, 32 px.
- **Radius**: `--r1` 4 px (controls), `--r2` 6 px (cards, menus, panels), `--r3` 10 px (dialogs).
- **Type**: the platform UI font (Segoe UI, SF, Ubuntu/Cantarell/Noto on Linux); no bundled or remote fonts. Sizes 10 (thumbnail badges only), 11 (metadata, captions), 12 (body, controls), 13 (titles), 15 (dialog titles). Counts and values use tabular figures.
- **Controls**: 28 px tall (`--control`); 24 px for dense rows in Develop and Compare; 32 px for empty-state and Develop's hand-off button.
- **Icons**: 24-unit outline icons, 1.65 stroke, drawn at 14–16 px with `currentColor`.

## Components

- **Buttons**: `.button` (bordered, default), `.button.primary` (ivory, one per surface), `.button.quiet` (borderless in toolbars and over the photo; outlined inside dialogs, panels and Compare so it still reads as a button), `.button.danger` / `.danger-quiet`, `.icon-button`, `.text-button` for links. `aria-pressed=true` gives any button the accent "on" state. Hover lightens, press darkens and moves down half a pixel. Disabled primaries fall back to the neutral surface.
- **Menus**: `.split-button` + `.menu` with `role=menu` items. Arrow keys, Home/End, Escape (returns focus to the trigger) and Tab work inside the menu; these keys never reach photo navigation. Pointer-down outside closes it.
- **Dialogs**: `.dialog-header` (title + close), content, then `.dialog-actions` right-aligned with the primary action last and a quiet secondary (Open folder, Show in folder) pushed to the left. Settings uses a side tab list with a scrolling page and a fixed footer.
- **Over-photo chips** (`.chip`, zoom group, wipe labels): `--overlay` background, no border, 11 px.
- **Thumbnail badges** (grid and filmstrip share them): top-right row holds sharpest ◆, burst count and colour label; bottom row holds develop marks (left) and flag + stars (right). The filmstrip index sits top-left. In the filmstrip the "Sharpest" word is dropped; its title keeps the meaning.
- **Analysis status**: a dot plus short text. Accent and pulsing while running, green when finished, amber on failures, grey when paused.
- **Develop**: section headers with a chevron, 2 px slider tracks with a 12 px thumb, numeric fields that only show a border on hover or focus.

## Rules

- One primary action per surface. Destructive actions are red and never primary.
- Keep element ids; the UI smokes and keyboard commands depend on them.
- Every action needs a mouse path, a command palette entry and, where it is frequent, a shortcut.
- Focus is always visible (`:focus-visible`, 2 px accent). Targets are at least 24 px.
- Motion is short (80–160 ms) and limited to hover, menus, dialogs, toasts and the fullscreen dock; `prefers-reduced-motion` removes transitions and animations.
- Over the photo, use the overlay surface and keep chips out of the image centre.
