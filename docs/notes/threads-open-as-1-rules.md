# Threads open as, part 1: the setting and the layout rules

A user found that with the sidebar as the thread switcher, thread tabs are a second list of the
same threads to manage by hand. The setting `layout.threads_open_as` (`tabs` | `panes` |
`single`) lets a pane show "the thread I am on plus its surfaces": opening another thread swaps it
in, and its linked tabs switch with it. The spec is `docs/notes/shell-model.md`, "Threads open
as". This part builds the rules in the daemon, the CLI and the mock; the GUI keeps today's chrome
(a thread pane is a strip with one tab). Part 2 builds the tab-less thread pane header, the
setting's dropdown and the switch dialog; part 3 makes Panes the default for new installs. The
default stays `tabs` here.

## How it is built

- **One option, one pass.** `internal/layout/modes.go`. `Options.Mode` carries the setting into
  every op, read at every op like `layout.smart_swap` (`store.Options.ThreadsOpenAs`). Under Panes
  and Single, `ApplyWith` ends every op with `conform`, which puts any layout in the mode's form:
  one thread-like tab (a thread or a composer) per pane, under Single one thread pane per space,
  and no other tab in a thread pane. The same pass is the conversion: the op `conform` does
  nothing itself, so applying it under the new mode converts. Ops that should replace or open
  beside do so explicitly (`openPanes`, `placeComposer`, `seat`, placement's `admits` and
  `surfacePane`); `conform` is the safety net for every other path (a tab dragged into a thread
  pane, a pane merged, a pane moved to a space, a reopened pane), so the invariant holds after any
  op. A property test runs random op sequences under both modes and checks it
  (`TestModeOpSequences`).
- **Replace** is `replaceIn`: the occupant's linked tabs in the space go to its remembered set
  (`putAway`, as `close_thread`), and the new tab takes the occupant's slot, so the pane (and its
  id) stays. Because every thread passes through the same thread pane, the remembered sets name
  that pane and come back into their old panes (`restore`'s "same pane" rule) rather than placed
  fresh.
- **Smart swap forced on**: `ApplyWith` swaps when `!NoSmartSwap || Mode.Panes()`. The stored
  setting is never written, so going back to Tabs uses what the user had.
- **Conversion on change**: `internal/daemon/layout_mode.go` hooks the settings store's
  `OnChange`, which runs before the change is published, so `settings.set layout.threads_open_as
  panes` returns with the layout converted, and an external edit of the settings file converts
  too. At load, `store.New` conforms a layout stored under another mode (logged as a repair, and
  written). A newer build's layout is not converted (nothing is written then anyway).
- **Preview**: `layout.threads-open-as.preview --to <mode>` (read-only, `--json`) runs `conform`
  on a copy (`core.ConformPreview`) and reports `thread_tabs`, `composers`, `panes`, `moved`,
  `spaces`; the switch dialog of part 2 reads it. It is `NoIndex`: an agent switches with
  `settings.set`, and the agents' guide has a size budget it would go over.
- **`thread.open`** gains `--beside <pane|thread>` (a new pane on its right; under Tabs too) and
  `--from <thread>`: the thread the user's click is in. The command walks the opened thread's
  creator chain; when `--from` is on it, the op gets `Parent` and, under Panes, opens beside the
  parent's pane. The GUI's `openThread(id, {from})` (lineage rows, wake notes) passes it through
  the selection bridge.
- **Back and forward** are the GUI's focus history (`stores/focusHistory.ts`). An entry now carries
  its thread; under Panes and Single an entry whose thread tab is gone opens the thread again
  (`thread.open`, which replaces), and two entries of one thread are the same place, so the new tab
  id of a thread opened again does not push a new entry or drop the forward ones.
- **The mock** (`mock/layout.ts`) ports a simplified version: `open_thread` replaces, `--beside`,
  `--from` and Single's refusal behave as in Go, `conform` converts, and the preview verb counts. It
  remembers no linked tabs (as its `close_thread` never did) and does no smart swap.

## Entry points

What each way a thread opens does. "Target" is the focused pane when it holds a thread or a
composer, else the thread pane focused most recently, else a new pane on the left edge of the pane
area (the first pane in an empty space).

| How it opens | Tabs | Panes | Single |
| --- | --- | --- | --- |
| Sidebar click, palette, bell, Needs you row, cmd+1…9, a link (`thread.open`) | tab in the focused or nearest thread pane (smart placement) | replaces the target's thread | replaces the target's thread |
| Thread already open in the space | focused where it is | focused where it is | focused where it is |
| `thread.open` from a model (keeps the user's focus) | background tab | replaces the target's thread, focus stays on that pane | same as Panes |
| Row dropped on a thread pane's middle or strip (`--pane`) | tab at that place | replaces that pane's thread | replaces that pane's thread |
| Row dropped on a pane of other tabs (`--pane`) | tab in that pane | new thread pane on that pane's left | replaces the target's thread (a new pane on its left when the space has none) |
| Row dropped on a pane's edge or the outer edge (`--split`, `--outer`) | new pane there | new thread pane there | replaces the target's thread |
| `thread.open --beside <pane\|thread>` | new pane on its right | new thread pane on its right | refused: the error names the setting and says to leave `--beside` out |
| Child from its lead: lineage row, wake note (`--from`) | as a click (`--from` not read) | new thread pane on the right of the lead's pane (a preview when it would be one) | replaces the lead (Back returns to it) |
| Archived or snoozed row (preview) | the space's preview tab | replaces the target's thread as a preview; the old preview closes | same as Panes |
| A thread's tab dragged onto a thread pane's strip or middle | moves there | replaces that pane's thread (`conform`) | same as Panes |
| A thread's tab dragged into a pane of other tabs | moves there | its own pane on that pane's left | same, then the old thread pane closes (`conform`) |
| A thread pane merged into another thread pane | tabs join | replaces (`conform`) | same as Panes |
| New thread (cmd+n, `composer.new`) | composer where a thread opens | composer replaces the target's thread | same as Panes |
| New thread from a pane's "+" | composer in that pane | in that pane when it is a thread pane, else a new thread pane on its left | replaces the target's thread unless the space has no thread pane |
| A draft's sidebar row | draft's tab where a thread opens | replaces the target's thread | same as Panes |
| Sending a composer | the thread takes the composer's place | same | same |
| Back / Forward | skips a closed thread's entry | opens it again, replacing | same as Panes |
| cmd+shift+t on a closed thread (tab or pane) | its old place | replaces its old pane's thread if that pane is a thread pane, else the target's | same as Panes |
| Moving a thread to another space | tab in that space's focused pane | replaces that space's thread pane's thread | same as Panes |
| A model or the "+" opening a linked surface | placement rules 1 to 6 | the rules skip thread panes; rule 6 and the focused pane go to the most recent pane of other tabs, else a new pane on the right (folded without room) | same as Panes |

## Decisions

- **The other tabs of a thread's pane move together** when converting (and when `conform` meets
  one at op time): into one new pane on the right of the thread, at half its room, in their order,
  with their active tab, taking the focus when one had it. The thread keeps the pane and its id,
  which remembered sets name. One split, nothing scattered: the least disturbance. Placing each
  by the rules would scatter a pane's pages across the layout.
- **The tab kept on conversion** is the pane's active thread tab; when the active tab is not a
  thread (a diff), the thread tab focused most recently (the space's MRU), else the first.
- **Single keeps** the focused thread pane, else the one focused most recently.
- **A thread dropped into a pane of other tabs** opens in its own pane on that pane's left (not "no
  target"): the GUI's drop zones need no change, and the left side matches linked surfaces opening
  to the right of their thread. `--beside` opens on the right, next to the named pane.
- **A replaced thread is not recorded** for cmd+shift+t: it closed as the consequence of an open
  (shell-model "Reopening closed tabs": consequences are not recorded); Back reaches it.
- **No room** for a new thread pane (any of them, edge drops included) opens it folded, as
  `reopen_closed` brings back a pane that does not fit, and `Result.Collapsed` says so. Under Tabs
  an edge drop that does not fit is still refused.
- **A new pane for a surface** pushed out of a thread pane with no pane of other tabs to take it
  opens on that pane's right, folded without room, rather than in the thread's pane (rule 6).
- **`--beside` under Tabs** opens a new pane on the right of that pane, as a drop on its edge.
- **A composer is thread-like**: it occupies a thread pane, is replaced by an open (an empty one is
  dropped, a draft's tab closes and the draft stays listed), and replaces the thread when New
  thread opens it. An empty composer already open is focused where it is; a "+" never moves it.
- **Moving a thread to another space** replaces that space's thread pane's thread, as an open does,
  rather than adding a second thread pane.
- **Mode values the daemon does not know** read as Tabs; the settings schema refuses them anyway.

## Differences from the brief

- **No e2e test.** The GUI shows whatever the daemon's layout is, with today's chrome; the
  rules are covered by Go table and property tests and the mock's vitest, and the history change by
  vitest. The linked-diff swap the suggested spec would check needs remembered sets, which the mock
  does not port, so it would test the mock rather than the app. The app was driven by hand on a
  scratch dev daemon under each value instead.
- **A wake note's or lineage row's child opens beside its lead** only through `--from`, which the
  daemon checks against the creator chain: the GUI sends the thread the click is in, not a claim
  that it is the parent.

## Gotchas

- `randomOp` in `property_test.go` picks from `OpNames()`; a new op shifts every random sequence
  and exposed a round-trip case `TestCloseOpenRoundTripRandom` was not built for (a linked tab
  coming back in a rebuilt pane). The generator leaves `conform` out, which keeps the seeded
  sequences as they were; `TestModeOpSequences` covers the modes.
- `TestLayoutOpCasesConvert` wants every core op to have a `LayoutOp` case: `ConformOp` is in the
  proto though the GUI never sends it.
- Three open panes do not fit the default 1180px pane area: tests that make a third pane give a
  wider one, or the new pane opens folded.
- The settings `OnChange` hook runs under the settings store's lock; the layout's `Apply` reads
  settings through `Settings()`, an atomic snapshot, so it does not deadlock.
