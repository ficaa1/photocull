# Interface validation

The current layout, tokens, components and accessibility rules are in [interface design notes](ui.md). The app uses a centered Grid/Review/Develop switch, split menus for source and editor actions, a context toolbar, collapsible sidebars and a status-bar grid-size slider. Export is the app bar’s primary action.

## Browser checks

```sh
node scripts/redesign-ui-smoke.cjs - artifacts/redesign-validation
node scripts/workspace-ui-smoke.cjs
```

The redesign smoke uses generated photos and isolated state. It checks recovered photo space after hiding panes, B/I shortcuts, stable rating and filmstrip nodes, grid density, compact layouts, visible focus, Tab/Shift+Tab order, keyboard pane activation, fullscreen filmstrip reveal/hide and persisted layout. Reports and screenshots go to the ignored artifact directory. Set `CHROMIUM_PATH` when Chrome/Chromium is not discovered.

The workspace smoke checks menu keyboard ownership, typeahead and focus return, command-palette parity, editor configuration without a RAW selection, Welcome choices and late card discovery. Welcome is modal; a card cannot open automatically behind it. Menu decision/navigation keys never reach photo commands. G/E selects contact sheet/Review and Ctrl+Tab switches them; Tab remains focus navigation.

These scripts drive Chromium with the Node backend, regardless of the compatibility executable argument accepted by the redesign script. They do not automate native Tauri webviews, dialogs or physical fullscreen. See [validation](validation.md) for native checks and [macOS](macos.md) for unverified platform behavior.
