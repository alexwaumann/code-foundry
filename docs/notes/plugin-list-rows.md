# Plugin list rows: check, reorder, add, rename in place

Status: built on branch `cf/plugin-list-rows` (2026-11-08). One PR of the plugin UI
primitives build-out; the approved design is the "todo" sketch (a real-app sketch of a Todo
surface in the side panel: checkbox, grip with a lifted row and a drop line, an add input,
an inline title editor). The sketch's date field is another builder's.

## What landed

| Path | What |
|---|---|
| `pluginsdk/ui/ui.go` | `List.Checkable`, `List.Reorderable`, `List.Add *ListAdd`; `Row.Checked`, `Row.Editable` (kept in a block of their own at the ends of both structs, apart from `Row.Menu` on `cf/plugin-menu`) |
| `pluginsdk/ui/list_rows.go` | `ListAdd`, `MaxRowText`, builders (`Node.AsCheckable`, `AsReorderable`, `WithAddRow`; `Row.AsChecked`, `AsEditable`), the validator's `listRows` / `noListRows` |
| `pluginsdk/list_acts.go` | `ActCheck`, `ActMove`, `ActAdd`, `ActEdit`; `SurfaceAct.Checked()`, `After()`, `Text()` |
| `pluginsdk/plugintest/list_rows.go` | `h.Check`, `h.Move`, `h.AddRow`, `h.EditRow`; the `view.list.rows` capability |
| `internal/store/plugin/list_rows.go` | row acts indexed per view version, found by key + kind, values checked and typed; `view.list.rows` announced |
| `plugins/examples/hello/todo.go` | the demo's **Todo** tab; fixture `hello-demo/todo.json` (the other seven gained the tab) |
| `gui/frontend/src/components/plugin/rows.ts` | the pure parts: apply/settle pending changes, move arithmetic, drop slot, edge scroll, edit commit rule |
| `…/plugin/listRowsState.ts`, `ListRows.tsx`, `nodes/ListNode.tsx` | the state hook, the pointer drag, the keyboard move; checkbox, grip, title editor, add input; `InteractiveList` |
| `gui/frontend/mock/pluginRows.ts` | the mock's row acts (shaped and checked as the daemon does), the Todo state, row acts on a custom view |
| `internal/skills/…/reference/{nodes,primitives,testing}.md` | the reference; `plugin.go`'s limits table names `MaxRowText` |

No proto change: `SurfaceActRequest.action` already existed; the GUI now sends it for row acts.

## Decisions

* **Host-shaped acts, like `tab` and `select`, not plugin-named events.** A list opts in
  with a flag, not an `Action`: the act's `Kind` and `Action` are `check` / `move` / `add` /
  `edit`, `Node` is the list's key. The plugin dispatches on `Kind` (a list's own events
  would need four more event names per list for nothing; `Node` tells two lists apart).
  No `Data`, no form values (dropped like a tab's).
* **Addressing.** A row may both act on click and be checked, moved and renamed, so the
  row acts live beside the view's elements in their own index keyed by kind + key. An act
  names one with the row's key and the kind as `action` (the GUI always sends both); with
  a row act's kind as `action`, the row act wins over a click whose event has the same
  name. Keyless (`plugin act --action check`) is refused like a tab: name the row.
  `SurfaceElements` lists them after the view's elements.
* **Move's value: the new upper neighbour.** `Value` is the key of the row directly above
  the moved one after the move, `""` when it is now first. A neighbour, not an index: in a
  filtered view (the demo's open tasks, a search) an index means nothing to the plugin's
  full list, while "after t4" does. The daemon refuses the row's own key and a key that is
  not a row of that list.
* **Check's value is a bool**; add's and edit's text is trimmed, one line, not empty, at
  most `MaxRowText` (= `MaxLabel`, 200) code points, valid UTF-8. The daemon checks all of
  it; the GUI never sends what it would refuse.
* **Optimistic until the next view.** A change shows at once and goes when the plugin
  refuses (toasted, as every act), or, once taken, when a view shows it or a newer view
  comes (whatever it shows: the plugin decided), at most `CHOICE_HOLD_MS` (5 s) after the
  answer: the master-detail choice's rule. Later changes of the same kind on the same row
  replace earlier ones; moves of different rows compose in order. Held per list in
  `InteractiveList` (a virtualized row can unmount; the list cannot while shown).
* **Add input = one in flight.** Enter does nothing while an add is pending; on success
  the input clears only if the text is still what was sent (typing on meanwhile is kept);
  on refusal the text stays. Escape blurs. No optimistic row (the plugin picks the key).
* **Rename vs a row-wide `Action` (deliberate).** A row with an `action` keeps its click
  and Enter: double-clicking its title does **not** rename (the first click already ran
  the action), only **F2** does. A row without one renames on double-click of the title,
  F2 or Enter. Enter or blur commits, Escape cancels; empty or unchanged commits nothing;
  Enter and Escape give focus back to the row.
* **Keyboard reorder matches the panel tabs' convention** (`panel-tab-reorder.md`:
  alt+←/→ moves the focused tab one slot, no KeyboardSensor): alt+↑/↓ moves the focused
  row one place, nothing at an end, and the key is handled either way. Rows of a
  reorderable or editable list are focusable (`role="group"` with the title as its label
  when they have no action; `aria-keyshortcuts` says F2 / Alt+Arrow).
* **Our own pointer drag, not dnd-kit.** Sortable needs every item mounted; a virtualized
  list mounts the rows near the viewport only. The drag reads the rows drawn under the
  pointer (which are always mounted) and names the gap by the list's order, so it works
  the same over a plain or a virtualized list. 4 px before a press becomes a drag (the
  panel tabs' distance); the row stays in place at 35% and a copy follows the pointer
  (portaled to `body`: the virtual rows' transforms would capture `position: fixed`); the
  drop line is drawn in the list's own box. Escape cancels; a release where it was moves
  nothing; the grip swallows its click, so a drag never runs the row's action.
* **Edge scroll** while dragging within 40 px of the scroll box's top or bottom, up to
  14 px a frame. The box is the list's `VirtualScrollRoot` (a sized pane, else the
  surface's body), the same one the list virtualizes against.
* **Checkbox in the glyph slot**: a checkable list's rows may not set a glyph (refused),
  and `checked` without `checkable` is refused (it would not show). Checked titles are
  muted and struck through by the host.
* **Not on a master-detail's list** (refused): choosing a row is its interaction.

## How it degrades at panel width

Nothing is hidden at ~360 px: the grip column (14 px, kept on every row of a reorderable
list, shown on hover or focus) and the checkbox (16 px) take about 36 px with their gaps;
the add input is the list's width. A reorderable list's rows therefore start 22 px further
in than a plain list's; the grip could not go in the row's gutter instead because a sized
pane clips its content horizontally (tried: the grip vanished in a pane).

## Gotchas

* `act()`'s Value from the GUI is a string; the daemon types it (bool for check) before the
  plugin sees it. A Go plugin reads `act.Checked()` / `After()` / `Text()`.
* The mock's acts log (`/__mock/plugin/acts`) now ends a row act's line with ` action=<kind>`.
* macOS WebKit: `End` does not move the caret in an input (the shots use Meta+→).
* jsdom has no `scrollIntoView`: the keyboard move checks for it.

## Tests

* Go: validator table (`list_rows_test.go`), element count, builders; fuzz: `viewgen`
  (both copies) makes lists interactive and breaks the rules; the property counter counts
  the add input; the Todo fixture seeds `FuzzView`. Daemon: an end-to-end act table over a
  test surface (`TestListRowActs`: shaping, values, refusals, listing). `plugintest`
  helpers. The hello demo's Todo tab through the helpers.
* vitest: `rows.test.ts` (arithmetic), `listrows.test.tsx` (payloads, optimistic + revert
  and settle, hold timeout, keyboard reorder, edit commit/cancel and the action conflict,
  add input rules, a drag sequence on faked geometry, the demo fixture).
* WebKit e2e (`e2e/plugin-list-rows.spec.ts`): the real pointer drag on the Todo tab, and a
  drag held at a 300 px pane's edge over an 80-row virtualized list (it scrolls, the drop
  lands at a row that was not drawn when the drag began). Screenshots behind `SHOTS`.
