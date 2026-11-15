# Preview tabs 2: Snoozed and Archived rows drag

With the shell drawing the window, rows in the sidebar's Snoozed and Archived sections now drag
into the pane grid as Active and Working rows do (`shell-16-sidebar.md`, "Dragging a row"). They
keep their one-line look. GUI only: no daemon, command or proto change.

## What is in it

| File | Holds |
| --- | --- |
| `components/sidebar/shell/ShellRows.tsx` | `ShellQuietRowView`: the classic one line (`SingleLineLabel`, now exported from `SidebarRow.tsx`) as a `useThreadDrag` source, dimmed while dragged |
| `components/sidebar/shell/ShellSidebarList.tsx` | Snoozed and Archived rows use it instead of the classic `SidebarRow` |
| `shell/drag/threadSource.ts` | pure: `openThreadTab`, `rowDragSource` (was ShellDnd's `openThreadAsTab`), `threadDropsInGrid` |
| `shell/drag/dropPlan.ts` | pure: what a drag's end runs (was inline in `ShellDnd.onDragEnd`) |
| `shell/drag/targets.ts`, `draggable.ts` | the thread source carries `archived`; no drag while the row's name is being edited |
| `shell/spaces.ts` | `spaceDropCommands`: an archived thread with no tab open goes to no space tab |
| `components/shell/ShellDnd.tsx` | uses the three helpers above |
| `e2e/shell-row-drag.spec.ts` | an archived row into a pane of a non-default space, a snoozed row onto a pane's edge; SHOTS |

## Rules and how they are met

1. **Same targets as an active row.** The row is a `useThreadDrag` source, so the strip, the
   middle, the pane edges, the outer edge and a rail all take it, and the drop is the same single
   `thread.open` with the place (`threadDrop.ts`).
2. **No unarchive, no unsnooze.** `thread.open` never changes either; the daemon's `OpenThread`
   takes an archived thread into the space it opens in (`Archived: true`, set by the command from
   the thread's `archived_at`). Checked against a dev daemon: `thread list --archived` still
   shows `[archived]` / `[snoozed]` after each drop.
3. **An open tab moves.** As before, a row whose thread has a tab in the current space drags as
   that tab (`rowDragSource`), so its drop is `tab.move`. This now holds for an archived thread
   opened while archived too.
4. **Space tabs.** A snoozed row goes through `spaceDropCommands` as an active one does
   (`thread.space.move`). An archived row is taken by a space tab only while its tab is open
   anywhere; then the drop is `thread.space.move`, which moves that tab (and its linked tabs) to
   the space. No daemon change was needed: an archived thread opened while archived has a layout
   record in the space it opened in, and `MoveThreadToSpace` moves it like any other. With no
   tab open, `spaceDropCommands` returns null, so `ShellDnd` sets no `space` and the tab shows no
   highlight.
5. **Look and click.** One line as before; `opacity-60` while dragged (the active row's dim); the
   ghost is the thread tab ShellDnd draws for any thread source. A click is `onActivate` as before
   (dnd-kit's 4px activation keeps it a click). The row menu is a right press (dnd-kit's pointer
   sensor takes the primary button only).
6. **Keyboard instructions.** `aria-describedby` from `useDraggable`, the same id as every row.

## Decisions

- **The grid rule for an archived thread.** `spaceOfThread` falls back to the default space for a
  thread with no record, and keeps the space an archived thread was opened in after its tab
  closed. Neither says where an archived thread "is": it lives in no space. So
  `threadDropsInGrid` lets an archived thread with no tab open drop in the current space's grid
  whatever its record says; without that, an archived row could not drop anywhere while the window
  is in a space other than the default one. An archived thread open in another space stays out of
  this grid (as a Needs you row of another space does): its tab is there, and only a space tab
  moves it.
- **`archived` comes from the threads store**, read by `useThreadDrag`, not from the row's
  section, so any row of an archived thread says so.
- **`dropPlan` is pure** so vitest checks the command each drop runs from the code ShellDnd runs.
  Grid drops now go through `runSpaceDrop` too (run, then wait for the rev), which is what the two
  inline paths did.
- **No drag while renaming** (both row kinds): a press and a small move in the name field
  selected text and could lift the row.

## Verification

- `make check` green.
- vitest `shell/drag/threadSource.test.ts`: the `archived` flag through `sourceOf`; which source a
  row drags as (open here: its tab; archived and open elsewhere, archived and closed, snoozed:
  the thread); which thread sources the grid takes; per drop kind (middle, strip, edge, outer, a
  rail) the `thread.open` arguments for an archived (no record, and a record elsewhere) and a
  snoozed row; an archived row open here moves its tab (`tab.move`); space tabs for snoozed,
  archived without a tab (null on every space) and archived with a tab (here or elsewhere; null
  for its own space); tab and pane plans unchanged. `ShellSidebarList.test.tsx`: the rows keep
  their one line and share the active row's drag instructions; a pointer drag in jsdom lifts
  `{thread, archived: true}` and `{thread}`; nothing lifts while renaming; the dragged row dims; a
  click still runs `thread.open --focus`.
- e2e `shell-row-drag.spec.ts` (WebKit, mock): an archived row into the pane of Review while the
  default space is Main (stored `[s-2,s-7]`, the row still under Archived); a snoozed row onto a
  pane's right edge (stored `row([s-1] [s-8])`, one `thread.open --split p-1 --edge right`, the
  row still under Snoozed).
- End to end with `make drive DAEMON=dev` on scratch homes under /tmp (removed after), `?shell=1`,
  driven by pointer with `playwright cli`: an archived thread (no record; default space Main,
  window in Review) dropped into Review's pane opened there, still archived; dragged again (now
  open) onto Main's space tab, its tab moved to Main. After `thread close`, with its record in
  Review and the window in Main, neither space tab highlighted under it and the drop on Review did
  nothing; dropped on Main's pane, it opened there (still archived). A snoozed thread dropped on
  the pane's right edge split it (`row [0.50 0.50]`), still snoozed.

## Gotchas

- In an empty space (no panes) no drag starts at all: `ShellDnd.onDragStart` needs the grid's
  frame. True for every row before this change too; not changed here.
- dnd-kit's click swallower after a jsdom drag (`testing-gotchas.md`): the click test in the new
  describe runs first.
