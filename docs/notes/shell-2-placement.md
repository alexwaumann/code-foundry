# Shell PR 2: placement, smart swap, closing and restoring a thread

Second PR of the shell stack (`docs/notes/shell-plan.md`, section 4). It adds the spec's "Linked
surfaces" rules to `internal/layout` as pure ops: placement (`place.go`), a thread's tab and its
linked set (`thread.go`) and smart swap (`swap.go`). Nothing is wired to the daemon, the CLI or the
GUI. The specification is `docs/notes/shell-model.md`; where it differs from the plan or the toy,
it is what was built.

## What is in it

| File | Holds |
| --- | --- |
| `place.go` | `open_surface`: rules 1 to 6, the "+" pane, a thread not open, an unlinked tab, the composer; `rank` (the tie-breaks), `roomBeside` (rule 5) |
| `thread.go` | `open_thread` (with `restore`, `putBack`, `groupRun`), `close_thread` (`putAway`), `move_thread`, `archive_thread`, `snooze_thread` |
| `swap.go` | `smartSwap`, run by `ApplyWith` |
| `op.go` | `Options` (`no_smart_swap`), `ApplyWith`, new `Result` fields: `rule`, `kept`, `ended`, `back`, `placed`, `fresh`, `swapped` |
| `identity.go` | the composer's key is now `compose`: one composer per space |
| `testdata/ops/*.json` | 66 new cases (126 in all) |

Every op takes the pane area as `w` and `h` in layout px (default 1180 x 820, plan 2.4) and measures
it with PR 1's plain `Rects`.

## The rules as built

`open_surface` (any kind but `thread`). Its space is `space`, else the pane's, else the thread's
space for a linked tab, else the current space.

1. **Already open** (same key in its scope): focused where it is; params and title given replace the
   open tab's (as `add_tab`). From a pane's "+", a linked tab stays where it is; an unlinked tab
   (the Pull Requests page, a composer) open elsewhere in the space moves into that pane. A terminal
   key is global, so a terminal tab open in another space is focused there (and that space becomes
   current when `focus`).
   - **The "+" pane** (`pane`): the new tab goes there after its active tab (`rule: "pane"`).
   - **No thread, or its thread has no tab in the space**: the focused pane after its active tab,
     or the first pane of an empty space (`rule: "focused"`). This comes before rule 2: the spec
     says a closed thread's surfaces "go to the focused pane".
2. **A pane holds this thread's linked tabs**: the new tab goes right after the last of them. With
   several such panes, the nearest wins. The thread's own pane counts, at distance 0.
3. **A pane next to the thread's pane holds linked surfaces** (any thread, a pane with a thread tab
   too): a pane holding a tab of this thread first; then the side, in the order right, left, below,
   above; then the nearest. Appended at the end of its strip.
4. **Any pane of the space holds linked surfaces**: a pane holding a tab of this thread first, then
   the nearest. The thread's own pane counts. Appended at the end.
5. **Room**: a new pane to the right of the thread's pane (`insertBeside` on the pane, so in a column
   only that pane is split and in a row the room comes from that pane alone). It takes the kind's
   `DefaultFrac` of the pane's width minus a gutter, raised to `FloorPx` when the conversation still
   keeps 480px there. There is room when the conversation keeps `KeepPx` (480) at that size.
6. **Otherwise**: the thread's own pane, right after the thread's tab.

"Nearest" is the distance between rectangle centres, |dx| + |dy| (the toy's measure), and layout
order breaks a tie. A pane that is joined is never resized: the property run checks that no rule
other than 5 changes any split's sizes. Terminals follow the same rules: there is no family rule and
no "below".

`open_thread`: an open thread tab is focused (`rule: "1"`). Otherwise the thread opens in its own
space: in place of `compose` (sending from a composer; the thread then lives in that composer's
space), in `pane` (which must be in the thread's space), in place of the space's composer when it
is the only tab there (ephemeral), else in the focused pane after its active tab, else as the first
pane of an empty space. Then its remembered set comes back.

**Close and restore.** `close_thread` takes the thread's linked tabs in its space out in layout
order. For each one it records the pane, the index at that moment, whether the tab was active, and
whether its pane was the thread's pane or touched it (`adjacent`). When the tab was its pane's last,
it also records where that pane sat (`beside`, from PR 1's `BesideInfo`, taken at that moment). Then
it closes the thread's tab. `Result.kept` lists the linked tabs; their terminals keep running.
`open_thread` puts the records back last first, the exact inverse of the close. When the thread is
back in the pane it was in, a record goes into its old pane at its old index (active again unless
that pane has the focus). A pane that went away is rebuilt under its old id beside the surviving
neighbours, at its old share. A record that was adjacent goes back only where it still touches the
thread's pane. Everything else is placed fresh by `open_surface`'s rules, in its old order. A record
whose surface is open again is dropped.

**Snooze** closes like `close_thread` (or, for a closed thread, puts its open linked tabs away).
Every remembered terminal is then marked `fresh` (its manual name and the command it ran, from the
op's `ran` map by terminal id) and listed in `Result.ended`. On restore such a tab comes back with
that name and a `ran` param, and is listed in `Result.fresh`, so the caller starts a shell for it and
sets its `terminal` param. **Archive** closes the thread's tab and its linked tabs in every space,
lists its running remembered terminals in `ended`, and deletes its `ThreadState`. **Move** takes the
thread's tab and its linked tabs in its space to the target. An open thread's tab lands in the
target's focused pane, active, without switching spaces, and its tabs are placed by the rules. A
closed thread's tabs go to the target's focused pane. A tab whose surface is open in the target
closes in favour of that one, and linked tabs in a third space stay there.

**Smart swap** runs in `ApplyWith` after any op that leaves a thread tab newly focused, so that is a
different tab or a different space than before. That includes `focus_tab`, `focus_pane`,
`open_thread`, `switch_space`, and focus returning to a thread tab after a close. In every pane of
that space whose active tab is a linked tab of another thread, the pane switches to this thread's
tab of the same kind if one is in that pane. The choice is this thread's `Last[kind]`, then the
newest in the space's MRU, then strip order. The thread swapped away records its tab as its own
`Last[kind]`, so swapping back restores it. Nothing opens, moves or closes. `Options.NoSmartSwap`
is the setting.

## Decisions to confirm

1. **Rule 2 with several panes**: the nearest wins, and the thread's own pane counts (rule 6 may
   have put linked tabs there). The spec does not order them.
2. **Rule 4 counts the thread's own pane** when it holds another thread's linked surface ("a pane
   that also holds a thread tab counts like any other"). So such a pane is joined even when rule 5
   would have room.
3. **Rule 4 has no side order**: the spec lists sides under rule 3 only, and rule 4 is "a tab of this
   thread wins, then the nearest". The plan said "the same as rule 3".
4. **"Mine first" in rules 3 and 4 cannot change an outcome through the op**, because rule 2 takes
   any pane holding this thread's linked tab first. It is kept in `rank`, and `TestRankMineFirst`
   pins it.
5. **Rule 5 does not shrink the new pane to make room**: it opens at the kind's size or not at all
   (the toy cut it down to a 360px minimum). The floor applies only while the conversation keeps
   480px.
6. **A closed thread's surface goes to the focused pane even when its other linked tabs are open**
   in some pane: the spec's sentence for closed threads comes before rule 2.
7. **Smart swap runs on any focus gain, not only on `focus_tab` and `open_thread`** (the plan's two),
   because the spec says "when a thread tab gains focus". So focus returning to a thread after
   `cmd+w` swaps too.
8. **Snoozing ends the thread's terminal tabs in other spaces too** (closing them, as a terminal
   cannot end under an open tab). Its other dormant tabs stay.
9. **Archive deletes the thread's layout state**, so it falls back to the default space; unarchiving
   should move it into the space the user is in.
10. **Moving a closed thread** sends its open linked tabs to the target's focused pane and does not
    open the thread (the toy opened it).
11. **An empty space reopens a thread under its old pane id** when that id is free, so a thread that
    was alone in its space gets its set back in place rather than placed fresh.
12. **There is no unsnooze op**: unsnoozing changes nothing in the layout; the set stays remembered
    until the thread opens.
13. **One composer per space by identity**: the composer's key is the kind. A later spec addition
    lets drafts have their own identity (see "For later PRs").

## Gotchas

- A removal can normalise a split into its parent of the same direction. For example,
  `row(col(row(a, b), c), d)` loses `c` and becomes `row(a, b, d)`. A pane recorded beside `[a, b]`
  then has no node to go back beside: their `Lca` is the whole row. `groupRun` regroups the run
  `a, b` under a new split at its old share before the insert. Without it the round trip puts `c`
  under all three panes. A case in `TestCloseOpenRoundTrip` fails without it.
- `putBack` tries a rebuild on a clone of the tree and puts the clone back when the pane would not
  touch the thread's pane. `removeNode` is not an undo, because it gives the room to the sibling
  before.
- `groupRun` and other id makers must take an id only when they use it. `SeqIDs` advances on every
  call, and the cases name the ids they expect.
- The random round trip (`TestCloseOpenRoundTripRandom`) puts every tab back in its pane, but not
  every tree is exact (60 of 76). The rest differ only because the thread's tab opens after the
  pane's active tab rather than at its old index, because smart swap changed another pane's active
  tab, or because an old share under 0.05 was clamped by `insertBeside`.
- The smart-swap check compares ids, not pointers: `putBack` may replace a space's root with a clone.

## Verification

- `make check` green.
- 66 new JSON cases. Each was written as a state and an op, with a hand-written expected `result`
  and expected panes, actives, sizes, focus and thread state in a scratch script. `-update` wrote
  the `want`; the script then checked it against the hand expectations, and all matched.
  Corrupting three of those expectations made the script fail, to show it checks.
- Go tests: `TestRankMineFirst`, `TestRoomBeside`, `TestOpenThreadSwapSetting`,
  `TestCloseOpenRoundTrip` (six layouts, exact), `TestCloseOpenRoundTripRandom`.
- Property run (400 sequences of up to 60 ops, smart swap on or off at random) covers the new ops.
  After every step the state is in normal form; a kept tab is in its thread's remembered set; a
  restored tab is open; and a joined pane is never resized. In that run every rule fires, along
  with restores and swaps. `FuzzOps` uses the same generator.
- No end-to-end step: nothing is wired yet.

## For later PRs

- **The drafts PR**: the composer is keyed `compose`, one per space. Drafts need their own identity
  (`compose:draft:<id>`, say), and `open_thread`'s ephemeral rule must skip a draft.
- **PR 3** (store): call `ApplyWith` with `layout.smart_swap` and the viewport from `SetViewport`
  (`w`, `h` on each placing op). `Result.rule` answers `ApplyLayoutResponse.rule`, and `kept`,
  `ended`, `fresh` and `swapped` should reach the event or the response.
- **PR 4** (commands): `cmd+w` on a thread tab is `close_thread`, not `close_tab`. `close_pane` on a
  pane with thread tabs runs `close_thread` for each thread first, then closes the pane. New thread
  is `open_surface` with a `compose` tab; sending is `open_thread --compose`. A call from inside a
  thread passes `focus: false`.
- **PR 6** (lifecycle glue): end the terminals in `Result.closed` from `close_tab`, `close_pane`,
  `archive_thread` and `snooze_thread`, plus those in `Result.ended`. Never end the ones in `kept`.
  For each tab in `Result.fresh`, start a shell and `set_tab_params` its `terminal`. Pass `ran` to
  `snooze_thread` from the foreground commands. On unarchive, `move_thread` it to the current space.
- **PR 7** (`view.open.*`): every verb is `open_surface`. The "+" menu passes `pane`; the Projects
  and Pull Requests pages pass their own pane for an unlinked tab.
- Reopening a thread puts its tab after the pane's active tab, not at its old index. Remembering
  that index would make the round trip exact; the spec does not ask for it.
