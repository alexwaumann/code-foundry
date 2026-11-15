# A folded pane comes back folded with its thread

A pane that holds only a thread's linked tabs goes away when the thread's tab closes, and is
rebuilt beside its old neighbours when the thread opens again in the pane it was in
(`internal/layout/thread.go`, `putBack`). The record of that pane did not say the user had
folded it to a rail, so it was rebuilt open. Two things followed:

- With room for it open, the pane came back unfolded: the user's fold was lost.
- Without room (a narrow pane area, where the fold was what made the layout fit), the rebuilt
  tree did not fit, the rebuild was undone, and the tabs were placed by the rules instead,
  usually into the thread's own pane.

## Decisions

- `RememberedTab.Collapsed` records the fold on the record that also carries `Beside`, the one
  for the last tab to leave the pane, which is the record that rebuilds it. The pane is rebuilt
  with the mark, so it costs the tree only its rail and fits wherever it sat before.
- The field is in the stored layout only. It is not in the proto: no window or verb reads it,
  and the mock does not rebuild panes on a restore (it places each tab by the rules).
- A record written before this change has no mark and rebuilds open, as before.
- A thread's tabs taken from another space by a snooze (`putAwayElsewhere`) record it too.
- `reopen_closed` is a different path and already folds a pane that does not fit; unchanged.

## Tests

- `TestCloseOpenKeepsFold`: the fold survives a close and open, at the default pane area and at
  one too narrow for the pane to open.
- `TestCloseOpenRoundTripRandom` no longer leaves out threads with a folded pane of linked tabs
  (the `collapsedLinked` skip added in `preview-tabs-1-daemon.md` is gone).
