# Sidebar bulk select

Several threads selected in the shell sidebar and acted on at once: a bulk context menu, a
dragged selection, and the Archived and Snoozed headers as drop targets. Why: the Active list
should hold only what the user works on now, so clearing several threads must be cheap.

## What is in it

| File | Holds |
| --- | --- |
| `lib/sidebarSelection.ts` | pure: toggle (cmd-click), range (shift-click) over the shown order, prune, in-order |
| `stores/sidebarSelection.ts` | the window-local selection (ids, anchor, the range's base, the shown order, the open row); Escape outside the list |
| `components/sidebar/shell/ThreadListbox.tsx` | `multiSelect` (the expanded list only): click modifiers, Escape, the bulk menu on right click, `aria-multiselectable`, no text selection on shift-press |
| `components/sidebar/shell/ShellRows.tsx`, `multiSelect.ts` | a row reads only "am I selected"; the accent tint; `aria-selected`; a Needs you row's title and request lines let a modified click through |
| `components/sidebar/shell/BulkRowMenu.tsx`, `lib/bulkMenu.ts` | "N threads", then only what applies to every one |
| `stores/bulkThreadActions.ts` | each action as one command given `ids`; the selection drops once it ran |
| `components/snooze/SnoozeMenu.tsx`, `SnoozeDialog.tsx`, `stores/snoozeDialog.ts` | the presets, Pick a date and time and Save for later for several threads |
| `shell/drag/groupDrop.ts`, `dropPlan.ts`, `state.ts`, `announce.ts`, `components/shell/ShellDnd.tsx` | the dragged group, its plans, the header targets, the ghost's count, announcements |
| `shell/spaceActions.ts` | `runSpaceDrop` places a step "after" the thread before, from the layout the step before committed |
| `internal/command/commands_thread_snooze.go`, `commands_thread_open.go`, `commands_thread_bulk.go` | `ids` on `thread.snooze` and `thread.space.move` |
| `mock/world.ts`, `mock/layoutVerbs.ts` | `ids` on the mock's archive, snooze, remove and space move |
| `e2e/sidebar-bulk-select.spec.ts` | the drags and the ghost; SHOTS |

## Decisions

- **Finder's rules.** Plain click opens and drops the selection. Cmd-click toggles a row and makes
  it the anchor, without opening it. Shift-click selects every shown thread row between the
  anchor and the clicked one, across sections; with nothing selected the anchor is the open
  thread's row. A second shift-click from the same anchor replaces the range, and rows picked
  before the range began (by cmd-click) stay. A cmd-click that removes the anchor row keeps it as
  the anchor, as Finder does. Draft rows and headers never take part.
- **Only the expanded list.** The rail and its section cards share `ThreadListbox` but do not pass
  `multiSelect`; their rows never show the tint. Collapsing the sidebar unmounts the list, which
  drops the selection.
- **Prune by what is shown.** A selected thread whose row is no longer drawn (it left the list, or
  its footer was collapsed) leaves the selection, so nothing hidden is acted on.
- **Escape.** In the list, Escape drops the selection before it does anything else. Outside it, a
  window listener drops it when no one took the key first (default not prevented) and the key is
  not in a field, a dialog or a menu.
- **Look.** A selected row is `bg-cf-accent-surface` (the theme's accent at 10%), the open thread's
  row stays the neutral `bg-cf-sidebar-row-selected`; a row both open and selected shows the tint.
  `contrastPairs.ts` now holds the sidebar's text and muted text on that tint over the sidebar to
  4.5:1, and every curated theme passes.
- **Menu.** A right click on a selected row while two or more are selected opens the bulk menu with
  the ids in display order; on any other row it drops the selection and opens that row's menu.
  The menu offers only what applies to every one, by the row menu's rules: no Snooze ▸ while one is
  being set up, Unsnooze only when all are snoozed or saved, Save for later left out once one is
  saved, Archive or Unarchive only when all are alike. Move to space ▸ marks a space "here" (and
  disables it) only when every one lives there, and moves only those that do not.
- **One command, one question.** Every bulk action is one registry command given `ids`
  (`thread.archive` and `thread.remove` had it; `thread.snooze` and `thread.space.move` gained it).
  The daemon's DynamicConfirm asks once: archive and snooze name the count and the busy ones, remove
  names the count and the ids. A declined question keeps the selection; one that ran drops it.
  Run in the first thread's context, so the command's availability (a thread in view) holds.
- **`thread.snooze --ids`** mirrors `thread.archive --ids`: `id` becomes optional, `When` is
  `hasThreadOrCLI`, each thread gets the same request past one that fails, a thread snoozing itself
  mid-turn is deferred. Messages read "saved 2 threads for later: a, b", "snoozed 2 threads until
  …: a, b" (`afterCount` puts the object after the count).
- **`thread.space.move --ids`** runs one `MoveThreadToSpace` per thread and answers
  `SpaceMoveResult`: the done and failed lists and the rev of the last move, which the window waits
  for. A thread already in the space fails as it does alone; the GUI sends only those that move.
- **Dragging.** A selected row with two or more selected drags the selection (`rowDragGroup`); any
  other row drags alone and drops the selection. The ghost is the grabbed row's thread with the
  count in an accent badge; every selected row dims.
- **Grid drops** (`groupGridSteps`): one command per thread, never one split per thread. The first
  thread lands where the drop says (a pane's middle means the end of its strip, so the order holds;
  a strip place; an edge or the outer edge, which makes the one new pane); each next one is placed
  right after the one before, in that one's pane, read from the layout the step before committed
  (`after`, resolved by `runSpaceDrop`). This is robust to linked tabs coming back and to the
  space's lone composer being replaced. A thread whose tab is open in this space moves as that tab
  (`tab.move`), any other opens (`thread.open`). The grid takes a group only when it takes every
  one of them (a Needs you row of another space keeps it off the grid; space tabs still take it).
  A drop is therefore N commands, run in order, each after the last one's commit; one op that opens
  several threads would need a new layout op, which this did not seem worth.
- **Space tab drops**: one `thread.space.move --ids` with those not living there; no target when
  none would move or one could not go (an archived thread with no tab open lives in no space).
- **Header drops**, for a single row as well as a selection: the Archived header archives
  (`thread.archive --ids`) those not archived; the Snoozed header saves for later
  (`thread.snooze --ids --save`) those not snoozed or saved and not being set up. A drop that would
  act on none is no target (an archived row on Archived). They are hit-tested by their boxes
  (`data-drop-section`), measured on every move, so they work collapsed or expanded, and light up
  as a space tab does. The confirm rule is the menu's (the daemon's).
- **A row drag in a space with no pane** now starts (a gridless snapshot): only space tabs and the
  headers take it. Before, no row drag started there (`preview-tabs-2-row-drag.md`, Gotchas).
- **Announcements**: a group is "3 threads (Fix login and 2 more)"; over a header "… is over the
  Archived header; dropping archives 3 threads."; the drag instructions mention space tabs, the
  headers and the selection.

## Verification

- `make check` green.
- Go: `TestThreadSnoozeIDs` (save, until, clear, one question naming the busy ones, a single id
  asking as alone, ids over the context thread, bad args), `TestThreadSpaceMoveIDs` (open and
  closed threads, the message, one already there failing past the rest, from inside a thread, the
  rev and the window staying in its space).
- vitest: `lib/sidebarSelection.test.ts`, `lib/bulkMenu.test.ts`, `shell/drag/groupDrop.test.ts`
  (lift, header ids, grid gate, steps per target, resolve, space commands, the plan),
  `announce.test.ts`, `SnoozeDialog.test.tsx` (several threads), `ShellSidebarList.test.tsx`
  (cmd, shift with and without an anchor and the open thread, plain click, no text selection,
  Escape in the list and outside, pruning, the bulk menu vs the row's, the menu's contents by
  selection, each item's command and ids, a declined question, dimming, the header boxes),
  `mock/bulkThreads.test.ts`, `mock/layoutVerbs.test.ts`, `themes` (the new contrast pairs).
- e2e `sidebar-bulk-select.spec.ts` (WebKit, mock): a selection into a pane's middle (order, ghost
  count), onto a pane's edge (one split), onto a space tab, onto the collapsed Archived header, a
  single row onto Snoozed, an archived row over Archived being no target. Run with the drag,
  sidebar, spaces, snooze and archive specs, twice each: 80 passed.
- Driven by hand with `make drive` (mock): cmd-click, shift-click, the bulk menu, one archive
  question for two threads with Cancel keeping the selection, every drag above; the mock's
  invocations showed one command per action with the ids in list order.

## Gotchas

- The mock's threads change status on a clock and Active reorders under the pointer: a drag by
  hand can lift the row that moved under it. The e2e spec uses the stable `s-t-*` threads from
  `/__mock/threads` and holds s-6 besides resetMock's s-1 and s-5.
- `runCommand` inside `stores/commands.ts` calls its own `runCommandForResult`, which a test's
  `vi.mock` of the export does not reach: the bulk actions call `runCommandForResult` directly.
- `react(refs)` lint: the open thread's id for a shift-click lives in the selection store
  (written by the list's effect), not in a ref assigned during render.
