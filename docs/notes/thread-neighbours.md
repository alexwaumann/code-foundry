# Previous and next thread in sidebar order

The positional companion to back and forward (docs/notes/selection-history.md):
cmd+shift+[ selects the thread above the current one in the sidebar and cmd+shift+] the
one below, the macOS tab-switching chords (Safari, Terminal).

## Commands

* `thread.previous` ("Previous Thread", cmd+shift+[) and `thread.next` ("Next Thread",
  cmd+shift+]) in `internal/command/commands_view.go`, category View, next to
  `view.back` / `view.forward`. Each emits `UiIntent.ShowView` "thread.previous" /
  "thread.next" (`command.ViewThreadPrevious`, `command.ViewThreadNext`).
* No `When`: available in every context, so they work from the dashboard, the Projects
  page and the composer. The registry does not care which file registers a `thread.*`
  name; the CLI verbs are `code-foundry thread previous` / `thread next`.
* Commands, not GUI view actions (cmd+1..9 and cmd+shift+a are view actions), so the
  chords are not reserved and users can rebind them. `NormalizeChord` and the GUI's
  `normalizeChord` take shift with `[` / `]`; the GUI reads the key from `e.code`
  (`BracketLeft`), so the `{` / `}` that shift produces on the event's `key` does not
  matter.
* Window-local presenters in `keys/bindings.ts` `commandPresenters` (chord, palette,
  menu), like view.back: this window's sidebar order. The CLI's reach every window
  through ShowView (`stores/views.ts`).

## Semantics (`stores/threadNeighbours.ts`, `lib/tree.ts` `neighbourIn`)

* The order is cmd+1..9's: `threadOrder(getListThreads(showCreated), getListOptions())`.
  Rows of a collapsed section and hidden threads do not count; Ember's row is not in it
  (cmd+shift+a adds it only while it waits on the user; these do not).
* From a thread: one row up or down, wrapping at both ends.
* A hidden thread selected starts from its creator's row (`sidebarAnchor`), as
  cmd+shift+a does: next goes to the row after the creator, previous to the creator's
  own row's predecessor.
* From anything that is not a row (dashboard, Pull Requests, Projects, Ember, the
  composer, or a thread inside a collapsed section): next selects the first row,
  previous the last.
* No rows: nothing happens.
* The selection goes through `select(…, { focusPrompt: true })` like cmd+1..9, so it
  lands in the window's history: cmd+[ steps back through threads reached this way.
* The logic lives in a store module rather than in bindings.ts because `stores/views.ts`
  (the ShowView path) needs it and bindings.ts already imports views.ts.

## Key dispatch

* Both chords start with cmd, so `terminalYieldable` yields them out of a focused shell
  and the thread prompt (`[data-chord-yield]`).
* No component handles them: the side panel's own chords are cmd+w, cmd+alt+\ and bare
  letters, the bottom panel's only cmd+w, the PR keys stop only unmodified keys, and the
  native menu has no accelerator on them.
* A plain text field (the settings search, a rename field) keeps them: `fieldYielded`
  stays back and forward only, as the brief asked. The composer and shells are what
  matter here, and both yield.
* Not added to the native Thread menu (neither was Back / Forward).

## Verified live (2026-10-21)

`make build gui-build`, daemon and GUI on an isolated `CODE_FOUNDRY_HOME=/tmp/cf-neigh`,
three no-project threads (alpha, bravo, charlie; Haiku 5.5, never prompted), so the
sidebar reads charlie, bravo, alpha. Real keystrokes through System Events, the window
captured with `screencapture -l` (window number from `CGWindowListCopyWindowInfo`; the
system Python has no Quartz module here, so a ten-line Swift script did the lookup).

* Dashboard (`view dashboard`): cmd+shift+] selected charlie; again from the dashboard,
  cmd+shift+[ selected alpha.
* Wrap: cmd+shift+] on alpha went to charlie, cmd+shift+[ on charlie to alpha.
* Composer focused (each switch focuses the prompt): previous and next kept switching
  threads; every prompt stayed empty, no `{` / `}`.
* Bottom panel shell focused (cmd+j in alpha): cmd+shift+[ went to bravo; back on alpha
  the shell showed only its prompt.
* History: after charlie, alpha, charlie, bravo by these chords, cmd+[ went to charlie,
  then alpha.
* Palette: "thread" lists "Next Thread thread.next ⇧⌘]" and "Previous Thread
  thread.previous ⇧⌘[" right under New Thread; running Next Thread from it on alpha went
  to charlie.
* CLI: `code-foundry thread next` on charlie selected bravo (`{"delivered":1}`).
* Settings: with its search field focused, cmd+shift+] did nothing (the field keeps it).
  Searching "Previous Thread" and "thread.next" finds both under Keybindings › View with
  ⇧⌘[ and ⇧⌘].
* Collapsed sections and hidden threads are covered by `keys/bindings.test.ts` only (no
  live Working or hidden threads: the threads were never prompted).

Seen in passing, not from this change: typing into the palette in the same instant it
opens can leave the unranked list up (no RESULTS header, "Show Thread" first) until the
next keystroke.
