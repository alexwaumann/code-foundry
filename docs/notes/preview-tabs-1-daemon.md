# Preview tabs, PR 1: the daemon

The first of three pull requests for preview tabs (`docs/notes/shell-model.md`, "Preview tabs").
This one carries the state from the layout to the GUI's layout slice and changes nothing visible.
PR 2 makes Archived and Snoozed sidebar rows draggable (GUI only); PR 3 is the GUI: the sidebar
click sends `thread.open --preview`, the dashed tab look, and the window's keeps (typing in the
composer, a double click on the tab, "Keep open" in its menu, all through `tab.keep`).

## What was built

- `internal/layout/preview.go`: `Tab.Preview`, `ThreadState.Snoozed`, the ops `keep_tab` (by tab
  or by thread) and `set_snoozed` (mark, or wake). `open_thread` takes `preview` and `snoozed`
  (what the caller knows, as `archived`). Check and Sanitize hold at most one preview per space,
  previews on thread tabs only, and none in a reopen history or a remembered set.
- The keeps inside layout ops: `move_tab` (any move, a reorder in its own strip and a drop on its
  own pane's edge too), `move_pane` (both forms), `merge_pane`, `swap_pane` (both panes),
  `move_thread` (the tab opens kept in the new space), and a surface of the preview's thread
  opened (`open_surface` through `place`, which restores use too, `add_tab` and `split_pane` with a
  linked tab, `set_quick` open). `prepare` drops a `preview` flag any other op is given, so only
  `open_thread` makes one.
- `record` skips preview tabs: neither a replaced nor a hand-closed preview reaches the reopen
  history. A pane closed with a preview in it is recorded without it.
- `internal/daemon/layout.go`: the glue remembers each thread's archived, snoozed, pinned and name
  between events. Unarchived, woken (snooze ended, unsnoozed, saved for later ended), renamed or
  pinned: `keep_tab` by thread when its tab is a preview. A message to an archived or snoozed
  thread unarchives and unsnoozes it in the thread store (`backToList`), so a send keeps through
  that transition; the glue does not watch sends. When an event's snoozed state differs from the
  layout's mark, the glue reads the thread store's state now and sends `set_snoozed`. At start it
  does that for every thread either side holds (a thread that woke while the daemon was down, or
  one an older build snoozed).
- Proto: `LayoutTab.preview`, `KeepTabOp`, `SetSnoozedOp`. `OpenThreadOp` has no preview field: a
  preview is only asked for through `thread.open --preview`, which reads the thread from the
  thread store (archived, snoozed or saved) before the layout sees the op.
- Commands: `thread.open --preview`, refused from a thread or a page (`FromUser` is false) and with
  `--pane`, `--split` or `--outer`; `tab.keep` (no palette entry, no key: the window calls it).
  `tab.list` and `layout show` print "(preview)" after a preview's words; their JSON carries
  `preview`. The guide's byte budget did not move: the new verb is not in the guide.
- GUI plumbing: `LayoutTabView.preview` (required, false for a kept tab) from the proto, carried
  into the slice's `TabEntry`; the `keep_tab` op view. The mock ports the keeps in the ops it runs
  against the shared cases, `keep_tab`, a simplified preview in its `open_thread`, and its verbs
  `thread.open --preview` and `tab.keep`.

## What today's code did with a snoozed thread's tab (rule 10)

Before this change, opening the tab of a thread that was still snoozed restored its whole
remembered set at once: its linked tabs went back to their panes, each terminal came back as a
fresh shell in the checkout with its "Run again" line, and an open quick terminal came back open
as a fresh shell. Opening did not unsnooze the thread, so a snoozed thread could run fresh shells
while it stayed in the Snoozed section. When the snooze later ended, nothing happened in the
layout. Now an open while snoozed restores nothing; the wake restores, through `set_snoozed`,
whose commit's `Fresh` and `FreshQuick` the glue answers with shells as it answers an open's.

## Decisions

- **A hand-closed preview is not recorded** (rule 9 left it open): the user looked at it and let
  it go, as a replaced one; reopening an archived thread's row is one click away in the sidebar.
- **Opening the current preview without `--preview` keeps it.** Rule 5 says opening it as a
  preview leaves it one; rule 8 says every open that is not a sidebar click is kept. So a drop of
  the same row on the grid, the CLI or a model's open focuses the tab and keeps it.
- **The layout keeps its own snoozed mark** instead of every caller of `open_thread` passing it:
  a restore, cmd+shift+t, the quick-terminal verbs and the window's own `open_thread` all open
  threads without asking the thread store. `snooze_thread` sets the mark (before the thread store
  commits the snooze), the glue corrects it from the store, and `thread.open` passes what it read.
- **`set_snoozed` is the glue's op** but has a `LayoutOp` case, since every op has one (as
  `replace_terminal` and `drop_terminal` do). The mock does not port it.
- **A keep is a separate op from the move**: the move ops clear the flag themselves, so a drag is
  still one op and one commit.
- **A replaced preview's linked tabs are remembered** like any closed thread's. They can only be
  there when its row's menu opened them before the preview did (opening one after keeps it).

## Gotchas

- Adding an op shifts the property tests' random stream (they pick op names by index). The new
  stream found a gap on `main`: a collapsed pane holding a thread's linked tabs is not rebuilt
  when the thread opens again (the record does not keep the collapse, and the pane rebuilt open
  does not fit), so its tabs land elsewhere. `TestCloseOpenRoundTripRandom` left such
  threads out (`collapsedLinked`) until the gap was fixed (`collapsed-pane-restore.md`).
- The glue tests that snooze and reopen a thread had to wake it first: they published the thread
  unsnoozed and opened at once, which raced the glue's `set_snoozed`. They wait for the wake now
  (`woken`), and the stepped race tests apply `set_snoozed` themselves.
- `go test -update` rewrites every case file it runs, reformatting old ones: run it with `-run`
  on the new cases only.
- Focus history needs nothing: a replaced preview's tab id is gone, and the window's history
  already skips an entry whose tab is gone.
