# Shell 25d: collapse a pane on demand; a divider that stops at the minimum and says so

The owner tested the `shell` branch and decided two changes. Both changed agreed behaviour, so
`shell-model.md` was edited first ("Dividers", "Collapsing a pane", the fold order, the key table,
full screen, the direction keys), then each was built.

## 1. Collapsing a pane

### The daemon

- **The mark is the pane's**: `Node.Collapsed` (`collapsed` in the space's stored document, so it
  survives a restart with no migration; an older build ignores the field). The proto's
  `LayoutPane.collapsed` carries it to the window. One op, `set_collapsed {pane, collapsed}`
  (`internal/layout/collapse.go`, `SetCollapsedOp` = 70).
- **Normal form**: a space with panes keeps one that is not collapsed, and only a pane is ever
  collapsed (`Check`; `Sanitize` repairs a document that breaks it by opening the focused pane).
  `finish` keeps it after every op (`keepOneOpen`): when the last open pane is closed or moved
  away, the pane that takes the focus opens. `set_collapsed` refuses to collapse the last open pane
  (`failed_precondition`); `pane.collapse` says so in words before it asks.
- **Focus.** Collapsing the focused pane hands the focus on as closing a pane does: `refocus`
  now skips panes that are collapsed (the most recently focused tab in an open pane), and
  `dropPane` hands the focus to the nearest open pane. With no open pane in the MRU, the first open
  pane in layout order takes it.
- **The focus may rest on a collapsed pane.** `focus_pane` (the direction keys, a press) focuses it
  and leaves it collapsed, so the direction keys pass over it. An op that gives one of its tabs the
  user's focus opens it: `tx.focusTab` (a tab placed with the focus through `show`, `focus_tab`, a
  tab or pane dropped into it: `move_tab` and `merge_pane` into it, a thread opened or an "already
  open" surface focused there, `tab.reopen`). With `KeepFocus` (a thread's call) the op collapses
  those panes again (`tx.revealed`, `keepCollapsed`), so a model never opens a pane the user
  collapsed; the tab it added becomes the pane's active tab, and the rail's icon carries the dot.
  `move_pane` (a pane moved, to another space too) and `swap_pane` (shift with a direction key)
  keep the mark: it is a field of the node. A pane rebuilt by `tab.reopen` is a new node, open.
- **Plain rectangles** (`Rects`, what placement measures and the CLI's direction verbs read) lay a
  collapsed pane out as a 36 px rail: a child of a split that is all collapsed panes takes its
  rails' length along the split, the others share the rest by their sizes; when every child is
  all collapsed they share by their sizes. The GUI's `plainRects` gives the same px
  (`neighbour.json`).
- **`pane.collapse [pane] [--on|--off]`** (default: the focused pane, toggled), key cmd+shift+m,
  in the palette as "Toggle Collapse Pane". Opening from the user takes the focus; from inside a
  thread the pane must be named and the user's focus stays. `layout show` marks a pane
  "(collapsed)".
- **The chord**: cmd+m is the native menu's Minimize (`ReservedChords`); cmd+shift+m is bound by no
  command, no view action and no native menu item (Wails' Window menu binds only cmd+m). Dictation
  has no default chord; its tests use cmd+shift+m only as a chord a user might bind, and the
  settings page refuses a second binding of one chord, as for any command.

### The window

- **Geometry** (`shell/geometry`): `GeoPane.collapsed`. `foldRails` starts from the collapsed set,
  `foldOrder` leaves them out, so they never fold or unfold there; `frameRects` and `minimumOf`
  always count them as rails, whatever rails a caller passes. They are drawn by the rule of every
  fold: a rail in a row, a strip in a column, a column narrowing only when all its panes are
  folded. Their room goes to the neighbours by the stored sizes, which do not change.
- **The strip** has a collapse control left of full screen (`PaneCollapseButton`: fold-horizontal
  in a row, fold-vertical in a column; tooltip "Collapse pane ⇧⌘M" from the user's binding).
  On the last open pane it is `aria-disabled` (a disabled button gets no pointer events, so no
  tooltip) with the reason as its tooltip. Not shown in full screen. The strip keeps 30 px for it
  when fitting tabs.
- **The rail** of a collapsed pane is marked (`data-collapsed`, "Collapsed pane") and has an open
  control before its full screen button, as the strip has collapse before full screen. It takes
  the focused border when it has the focus, and a focus request puts the keyboard on its selected
  icon (Enter opens it on that tab, cmd+shift+m opens it).
- **cmd+shift+m** (`shell/collapse.ts`): the focused pane collapses, or opens when collapsed; the
  keyboard follows the focus the daemon left. On the last open pane the command runs anyway, so
  the daemon's refusal is the toast that says why. Nothing in full screen, like the focus and move
  keys (written into the spec).
- **Optimistic focus**: `overlayFocus` opens a collapsed pane for `focus_tab`, not for
  `focus_pane`, as the daemon does.
- **Full screen** of a collapsed pane (its rail's button, which focuses it with `focus_pane`)
  draws it whole; leaving draws the rail again. Nothing is stored.
- **Drops**: a collapsed pane is a rail, one target as a whole; `treeAfterDrop` opens it for a
  middle drop, so the highlight is the open pane's rectangle after the drop (the shared fixture
  covers it).
- **The space icon** lays the tree out plainly, so a collapsed pane is a 4.5 px bar.
- **The mock** ports the op, the focus rules and the verb; it runs every collapse case of Go's
  op fixtures but the one that opens a thread (`open_thread`, a rule it does not port).

## 2. Dividers

### What the divider did before (audit)

- **Minimums ignored folds.** `startDrag` read each side's minimum with no rails folded, so a
  column holding a rail or a strip counted the folded pane's minimum: the divider stopped early
  (beside a column of a folded diff and a terminal, at the diff's 260 px, not the terminal's 240).
- **It jumped beside a pane held at its minimum.** The drag scaled the split's stored sizes. A
  pane drawn wider than its share (held at its minimum) is laid out again from those sizes on the
  first move, so grabbing the divider between a held thread (10%, drawn 360 px) and a diff moved
  the diff from 308 to 260 px with the pointer still.
- **Beside a side that is all rails** the gutter drew nothing: no cursor, nothing to tell why it
  would not move. Elsewhere the cursor was always the two-way resize cursor, and a press on a
  divider whose two sides were both at their minimums started a drag that did nothing.
- It never folded a pane: `dragSizes` clamps at the minimums. Kept so (no snap to a rail).

### The rule now

- Minimums are read with the frame's rails (`minimumOf(kid, rails)`).
- A drag starts from what is drawn (`drawnSizes`): when the split's open sides are drawn at their
  stored proportions (to the rounding px), the stored sizes stand; otherwise the open sides' sizes
  are their drawn lengths, scaled to the share they had together, and a side that is all rails
  keeps its stored size. Grabbing never moves anything. The consequence: after a drag beside a
  held pane its stored share is what was drawn (10% becomes about 37% in the test's 1000 px), so a
  wider window keeps it at that share. Chosen over solving for sizes that keep the other sides'
  stored shares, which holding at minimums does not always allow.
- The cursor (`gutterReach`, `gutterCursor`): `col-resize`/`row-resize` both ways, the one-way
  cursor pointing the way it can still go (`w`/`e`-resize in a row, `n`/`s`-resize in a column),
  `not-allowed` when it cannot move. During a drag a transparent layer over the grid carries the
  cursor for where the drag took it (the pointer leaves the gutter once the gutter stops). A
  divider that cannot move starts no drag and shows no handle; an arrow key the way it cannot go
  commits nothing. A `fixed` gutter (beside a side that is all rails) is drawn now
  (`shell-gutter-fixed`): the cursor only, no keyboard.
- The minimum numbers are untouched and read only through `minimumOf`/`paneMinimum`.

## Differences from the brief

- A collapsed pane moved to an empty space opens there: it is that space's only pane, and the
  last open pane cannot be collapsed. Everywhere else the mark goes with the pane.
- cmd+shift+m does nothing in full screen (a choice, as the focus and move keys; in the spec).
- The cursors are not in the screenshots: Playwright's screenshots do not draw the pointer. The
  e2e test asserts the cursor WebKit computes under the pointer (`elementFromPoint` and
  `getComputedStyle`) during and after a real drag.

## Tests

- Go: 21 op cases (`set_collapsed-*`, the focus, drop, close, swap, move and open cases with a
  collapsed pane), the op fuzz with `set_collapsed` and a check that only `set_collapsed` collapses
  and that a call keeping the focus opens nothing, `pane.collapse` (toggle, on, off, the refusal,
  the focus handed on, a thread's call), the store's reload, and the shared fixtures extended:
  ten `neighbour.json` cases with collapsed panes, eight `drops.json` cases (8 drops onto a
  collapsed pane, 10 tabs dragged out of one). Appended after the existing cases, which stay
  byte for byte (their random draws come first).
- vitest: `shell/geometry/collapse.test.ts` (rails at any size, room by proportions, opened
  sizes, fold order, a column, plain rects, 300 random trees), `shell/resize.test.ts` (rails'
  minimums, no jump, stored sizes kept, the cursor table), `shell/collapse.test.ts` (the chord,
  the keyboard, full screen, the last open pane), `PaneGrid.collapse.test.tsx` (rail, controls,
  tooltips, focus, full screen, cursors), the slice, the API mapping, the space glyph, the drop and
  neighbour fixtures' coverage, the key table.
- e2e (`shell-collapse.spec.ts`, WebKit): the chord in a row (geometry, focus handed on, a
  direction key onto the rail, opened back to the same px), the strip button in a column, the last
  open pane, a drop onto a collapsed pane (highlight equals the landed pane), the divider's
  cursor and stop under a real drag and beside a collapsed pane. `shell-grid-fuzz.spec.ts` grabs
  a pane between "+" and the collapse control now.
- End to end on a scratch daemon with the CLI: panes made, `pane.collapse` on the focused pane
  (the focus handed to the open one), again (nothing changed), the last open pane refused (exit 2),
  the daemon restarted, the pane still collapsed, `pane.focus.right` onto it (focused, still
  collapsed), `pane.collapse` opening it; the split's sizes stayed 0.50/0.50 throughout.

## Gotchas

- A scratch `CODE_FOUNDRY_HOME` under the session's long scratch path makes a socket path over
  macOS's 103 bytes; the daemon refuses it. A short directory under /tmp works.
- `go test -run TestOpCases -update` rewrites every op case in its own formatting, hand-written
  ones too; only the new files belong in the diff.
- A daemon restart ends its terminals and the sweep closes their tabs, so a terminal's pane is gone
  after one (known, `shell-build.md`).
- oxlint's `only-export-components`: a component file exports only components; helpers live in
  `shell/collapse.ts`.
