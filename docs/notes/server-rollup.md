# Servers roll up to the parent thread 2/2: the card and the bottom panel

Status: done on branch `cf/server-rollup`. PR 2 of 2 (1/2: `docs/notes/action-run-ports.md`).
GUI and mock only. A thread's info card now lists, as one flat set of rows, what listens on a
port for it and for every thread below it: background shells and running action runs alike.
A server with a terminal opens that terminal in the bottom panel of the thread whose card you
are on.

## Rows (`lib/servers.ts`, `stores/servers.ts`, `components/threadinfo/ShellsGroup.tsx`)

* The walk is `subtreeIds` (`lib/lineage.ts`), the daemon's `thread.Subtree`: depth first,
  spawn order, cycle-safe, `MAX_LINEAGE_DEPTH` 8. It follows `createdBy`; a fork has `parentId`
  and no creator, so forks stay out with no rule of their own.
* `rollupThreadIds` drops archived threads from the rows and walks on through them. The walk
  passing through is only belt and braces: `thread.archive` and `thread.remove` take the whole
  subtree along (`commands_thread_cascade.go`).
* Order: thread by thread, each thread's shells, then its runs, oldest first. No headings.
* One row per port (`serverRows`): `localhost:<port>` is the same place whoever reports it, and
  the `child-server` fixture reports 5173 from both a shell and a run. The port goes to a run
  with a terminal, then any run, then a shell (first in the list among equals). A source left
  with no port has no row; its other ports stay on its row. If the winner ends, the loser's row
  comes back.
* Line 2 is `command · source · uptime`. The source is "Dev action" and/or the owner's name when
  it is not this thread. The runtime word (node, python) is gone from the line, so
  `shellRuntime` went with it. The source gives way before the command (`shrink-[100]`) but
  keeps `min-w-16`: without the floor a long command squeezed the thread's name out entirely.
* The hover card keeps the ports and adds the whole command and, for a child's server, its
  thread. Your own thread is not named there: it is on screen.
* The "N more shells" fold stays this thread's. A shell whose ports all went to a run is in
  neither list until the run ends.

## Selectors

Three shallow selectors, encoded as before: thread ids, shells with ports, running runs with
ports. The owner's name is read per row (`s.byId[ownerId]?.name`), so a rename of a thread with
no server re-renders nothing. `childIndex` moved from `lib/liveCount.ts` to `lib/lineage.ts`,
keeping its memo, so the sidebar rows and the card share the one pass per list change and the
walk costs the subtree. Measured at 5,000 threads: a walk over a subtree of 50 takes about 1 µs,
an index rebuild at most 9 ms (the figure includes copying the list for the test).

## The click, and why no new command

`openServer`: a server with a terminal calls `showTerminalIn(id, key)`; any other opens the
browser, as does a terminal the store does not know.

No command: which panel shows a tab is window state, like clicking a tab
(`activateBottomTab`), `revealShell` or `showPluginTerminal`. A command would need a panel key
and reach every window. `thread.focus`/`focusTerminal` navigate to the owner, which is what this
must not do. Everything with an effect outside the window stays a command: `view.open.url`,
`thread.shell.stop`, `terminal.kill`, `action.stop`.

## Rolled-up tabs (`stores/bottomPanel.ts`, `stores/bottomActions.ts`)

* `TerminalsData.shownIn` is now `id -> keys`, not `id -> key`, and `bottomTabIds` no longer
  asks for plugin labels. Several keys because a grandchild's terminal can be opened from its
  parent's card and its grandparent's; with one key the second click would silently pull the
  tab out of the first panel. A plugin's terminal still has one key.
* Labels are untouched: `thread` drives kill and reap, so `ownerKeyOf` is still the child and
  the child's panel keeps its tab. A thread's own terminal gets no `shownIn` entry, or its × would
  turn into a hide.
* `isRolledUpTab` is the one test: another thread's terminal opened here, not a plugin's.
  `closeBottomTerminal(id, key)` hides such a tab. Without a key it closes, which is what Rerun
  wants. The × says "Hide tab".
* Hiding runs `afterTabLeft`, the part of `onRemovedTerminal` that moves to the neighbour or
  hides an emptied panel. `onRemovedTerminal` now runs it for the owner's key and each shown key.
  A plugin's terminal therefore also leaves its panel properly now; before, the key was null and
  nothing happened.
* `focusedBottomShell` returns "" on a rolled-up tab, so the palette's Close Terminal and Kill
  Terminal do not reach it: the tab's Stop stays the only kill. This is the one surprise of the
  change: with the keyboard in such a tab those two commands are simply unavailable.
* Rerun from a rolled-up tab runs for the owner (`ownerOfTerminal`), and `carryShownTerminal`
  puts the new terminal in the panels the old one showed in, so the user is not left with a
  vanished tab. Hidden first, then rerun from the child's panel: nothing carries, the new run's
  row opens it.
* One Attach: only the selection's panel is mounted and it has one `TerminalHost`, so a terminal
  in both panels has one stream. No code was needed; e2e pins it.
* Window-local, as before: a reload forgets rolled-up tabs, the child keeps its tab, and
  `closeEmptyPanels` hides a panel left with none.

## Stop

Shell: `stopShell` with the owner's id. Terminal run: `stopActionRun` (`terminal.kill`, so the tab
reads Stopping…, then Stopped), which now answers a boolean for `holdOnce`. Background run:
`action.stop` (`stopBackgroundRun`; new to the GUI, added to the mock). The tooltip names what is
stopped ("Stop action", "Stop shell"), never the port: the live check below left a port open.

## Mock

`action.stop`, as a NoPalette command. `child-server` is unchanged.

## Tests

Vitest: `subtreeIds` (order, forks, cycles, depth, a removed thread); `serverRows`, the source
words; `showTerminalIn`, hide, the panel moving on, several ancestors, a Rerun's carry
(`bottomActions.test.ts`); `isRolledUpTab`, `focusedBottomShell`; the rows, clicks, buttons and
when rows leave (`ShellsGroup.test.tsx`, including a Profiler check that unrelated updates commit
nothing); the tab's ×, middle click, cmd+w, Stop, Rerun (`BottomPanel.test.tsx`).

E2e `server-rollup`: xterm attaching with the keyboard in it, typing reaching the terminal, one
Attach across both panels, the stream going with a hidden last tab, the buttons' place on the row
and the keyboard showing them. There was no `servers` e2e spec to change: that coverage had moved
to `ThreadInfoCard.test.tsx`.

## Verified live

Scratch `daemon --dev`, scratch repo, three real actions, a real Sonnet 5.5 medium session on a
child, parent → child → grandchild:

* The parent's card listed the child's Claude shell (19714), the child's terminal run (19711) and
  the grandchild's background (19712) and terminal (19713) runs.
* A click attached the child's terminal in the parent's panel, keyboard in xterm, view unchanged.
* × hid it: the run went on and the port stayed. The row brought it back.
* The footer's Stop: Stopped, tab stays, port closed. Rerun from the parent's tab: a new run owned
  by the child, its tab in the parent's panel, active, and the old terminal gone.
* ■ on a background run: exited 143, port closed. ■ on the child's shell, through the parent's
  card: port closed, gone from `thread get`.
* ■ on a run whose child called `setsid`: run exited 129, row gone, **port still open**.
* Archiving the child with its tab open in the parent's panel: rows gone, tab gone, panel hidden,
  port closed.

## Not verified live

* **An orphan through the daemon**: `thread.remove` takes the subtree along, so no CLI path leaves
  a child whose creator is gone. It takes older data. Checked instead by dropping the middle
  thread from the store of a window on the real daemon, with the grandchild's tab open in the top
  thread's panel: the rows ended, the leftover tab kept working and its × only hid it, the run
  went on, and the orphan's own card listed the server. Its sidebar row is `lib/inSidebar`,
  unchanged and tested there.
* ↗ was exercised in vitest and the mock, not on the real daemon: it would have opened a browser
  on the machine running the check.

## Gotchas

* The `child-server` child's panel is closed on a fresh load: its terminal came with the List, not
  an `updated` event, so `onNewTerminal` never ran.
* `playwright cli` refs go stale on every tick of a row's uptime: snapshot right before a click.
