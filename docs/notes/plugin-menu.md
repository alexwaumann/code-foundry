# Plugin menus

The plugin UI's Menu primitive (sketch C): a row's ⋯ and right-click menu, the header's ⋯,
and a button that opens a menu. Text only. The coming Table node's rows reuse the row
parts as they are.

## SDK (`pluginsdk/ui/menu.go`)

- `Menu{Items}` of `MenuItem`. Each item is exactly one of an action item (`Action`, the
  existing event / command / openUrl / copy), a submenu (`Submenu`, one level), or a
  separator (`Separator: true` and nothing else). Items also take `Disabled`, `Danger`,
  and `Group` plus `Checked` for one-pick groups.
- Where menus go: `Row.Menu` (list rows and master-detail rows), `Header.Menu`, and
  `Button.Menu` (set `Action` or `Menu`, not both). A menu button is refused on a header's
  buttons (use `Header.Menu`), on a row's buttons (use `Row.Menu`), and on a form's
  submit or secondary buttons, because those act with the form's values.
- Validation: 1 to `MaxMenuItems` (24) entries per menu or submenu, separators included.
  Labels are required, at most `MaxMenuLabel` (60) characters. Keys share the view's
  namespace. A separator is never first, last, or next to another separator. Submenus go
  one level deep, and a submenu is never danger, grouped or checked. A group's items sit
  next to each other with at most one checked, and `Checked` needs a `Group`. Items
  (separators too) count toward `MaxElements`.
- Builders: `NewMenu`, `EventItem`, `CommandItem`, `URLItem`, `CopyItem`, `Separator`,
  `Submenu`, `PickGroup(group, checkedKey, items...)`, `.AsDanger()`, `.AsDisabled()`,
  `Button.WithMenu`, and `Menu.AllItems()` (walks).
- Capability `view.menu`. `plugintest.Host.PickItem(ctx, instance, key)` sends the click the
  GUI sends for an item. It refuses disabled items, submenus, and the host's own actions
  (command, URL, copy).
- Fuzz: `menuSeed` in `FuzzView`, and menus in the shared view generator (both copies).
  The property tests count menu elements on their own, and the daemon's reflective
  expected-elements walk includes menu items.

## Host

- `buildIndex` indexes every action item of a row's, the header's and a menu button's menu,
  submenus included, the way it indexes buttons: an event is a `click` act with the item's
  key and data. Command items go through the same permission check as command buttons.
  Submenus, separators and menu buttons do not act.
- As with buttons, the daemon does not refuse an act on a disabled item (`plugin act --key`
  reaches the plugin). The GUI keeps them inert, and `PickItem` refuses them.

## GUI

- `menu.ts` (pure):
  - `foldRowActions(width, actions, dense)` is the fold rule.
  - `rowMenuItems(row, folded)` returns the folded buttons, then a separator, then the
    menu's items.
  - `menuBlocks` groups a group's adjacent items, nests submenus, and drops stray
    separators.
  - It also has `menuKeys`, the context-menu key test, and `openRowMenuFromKey`.
- `PluginMenu.tsx`: `MoreMenu` (the ⋯ dropdown), `RowContextMenu`, and `MenuButtonMenu`.
  They use the app's own Radix dropdown and context menus, with the Projects page's
  classes: 200 px wide, the destructive item variant, text items, 8 px from the window's
  edge. The `menuPending.ts` hook spins the ⋯ or the menu button while one of its items'
  acts is in flight, since the menu has already closed.
- New shadcn parts: `DropdownMenuRadioGroup`/`RadioItem` and
  `ContextMenuRadioGroup`/`RadioItem`. They draw a check at the left of the picked item
  (sketch C's Move to), not shadcn's dot.
- A row with a menu, or with folded buttons, wraps itself in the context menu trigger and
  shows a ⋯ "More options" in its trailing cluster. The ⋯ is shown on hover, on focus within
  the row, and while its menu is open. Its place is kept while it is hidden (opacity), so the
  trailing values of a list's rows line up.
- The header's ⋯ follows its two icon actions on the sub-line. A menu button gets a chevron
  after its label; an icon-only menu button gets none.
- A pick is recorded, and its action runs from `onCloseAutoFocus` after Radix has returned
  focus, as in the Projects page's menus. A command's confirm dialog then keeps its focus.

## The fold (sketch C)

- A row folds its `Row.Actions` into its ⋯ when its width is less than the buttons' width
  plus `ROW_TITLE_MIN` (200 px for padding, glyph and about 20 characters of title).
- A button's width is estimated as PluginButton draws it: 24 px icon-only, else 16 px
  padding + 14 px icon + 7 px per character. WebKit measured 64/72/82 px for the demo's
  three buttons; the estimate gives 65/72/86.
- All of a row's buttons fold, or none.
- A dense row always folds its labelled buttons. Before this they were hidden in dense
  rows, so they were reachable only from the CLI.
- Only a row that has buttons follows its own width (one ResizeObserver each). The rule
  needs no list context, so a table row can use it as it is.
- At panel width (the row is 402 px), the demo's Build #2 folds its three buttons
  (Rerun, Open log, Copy error), and two short buttons would stay. Expanded, the three
  show on the row's second line.

## Keyboard

- Radix handles opening the ⋯ with Enter and Space, arrow keys, ArrowRight into a submenu,
  and Escape. Focus goes back to the ⋯.
- The ContextMenu key and Shift+F10 on a focused row, or on the ⋯ inside it, dispatch a
  `contextmenu` event at the row's start (left + 24 px, bottom), as
  `projects/rowMenu.ts openCursorRowMenu` does. Escape gives focus back to the row.
- A row without its own action is not focusable. Its ⋯ is the keyboard's way in.

## Hello demo, fixtures, mock

- The header has a menu: Reset the click count, Go to the form, | Open the SDK reference.
- Build #2 has three buttons and a menu: Rerun without the cache, Priority ▸ (Low / Normal /
  High, one-pick), | Open in CI, Copy link, | Delete run (disabled, danger).
- The actions bar's Copy greeting moved into a More ▾ menu button, with Reset the click
  count. The bar was at its 6-button limit.
- The new events are `reset-clicks`, `set-priority`, `open-log` and `rerun-run`.
- The seven fixtures gain the header menu, and `overview.json` gains Build #2's buttons and
  menu and More ▾. They were edited by script, keeping the captured ids and times.
  `plugins/examples/hello/menus_test.go` checks that they match what the plugin sends.
- The mock indexes menu items and moves Priority's check.

## Tests

- Go:
  - `pluginsdk/ui/menu_test.go` (every validation branch, JSON, element count).
  - `internal/store/plugin/menu_internal_test.go` (index, permissions).
  - `plugintest/menus_test.go`.
  - The hello demo's `menus_test.go`.
  - The generator and property tests.
- Vitest, `src/components/plugin/menu.test.tsx` (44 tests):
  - The fold table and the items' order.
  - The blocks.
  - Each action kind's path: event, command, URL, copy.
  - Disabled and danger items, the submenu's check, right-click.
  - The ContextMenu key and Shift+F10.
  - Inert, pending, the header's ⋯, the menu button.
- WebKit, `e2e/plugin-menu.spec.ts`:
  - A real right-click opens the menu within 6 px of the pointer.
  - Escape and Shift+F10 give focus back to the row; the ⋯ gets focus with Option+Tab
    (WebKit's Tab skips buttons).
  - The fold at panel width, and the buttons back after widening by 500 px.
  - A Priority pick comes back checked.
  - SHOTS-gated screenshots.
- End to end, with a dev daemon in a short home (`~/.cfmenu`, removed afterwards):
  `plugin dev` hello, `thread new --no-project`. `plugin surface` lists every menu item as
  an acting element, and `plugin act --key run-2-p-high` comes back with High checked. No
  messages were sent.

## Gotchas

- `CODE_FOUNDRY_HOME` under the scratchpad is too long for the daemon's Unix socket (103
  bytes on macOS).
- `document.getAnimations()` never settles while spinners run. The SHOTS wait skips
  infinite animations.
- When the pointer moves from a menu to a submenu that opened to the left, it can cross
  another item and close the submenu. The SHOTS spec opens it with the keyboard.
- Radix's `DropdownMenuTrigger asChild` needs its own `disabled`. With only the child's,
  a synthetic pointerdown still opens the menu.
- oxlint's `only-export-components` counts hooks too: `useMenuPending` lives in
  `menuPending.ts`.
