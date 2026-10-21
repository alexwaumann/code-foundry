# Back and forward through visited threads and pages

A user asked for cmd+[ / cmd+] to step back and forward between the threads they visited,
like vim's ctrl+o / ctrl+i. The design was agreed with Alex on 2026-10-21: browser
semantics (Safari, Finder), not vim's jumplist.

## Commands

* `view.back` ("Back", cmd+[) and `view.forward` ("Forward", cmd+]) in
  `internal/command/commands_view.go`. Each emits `UiIntent.ShowView` "back" / "forward"
  (`command.ViewBack`, `command.ViewForward`), the same pattern as `view.panel.split`.
* They are commands, not GUI view actions, so the chords are **not** in `ReservedChords`
  and users can rebind them in Settings → Keybindings. `[` and `]` were already accepted
  by `chordKeyPattern`.
* **Window-local presenters** (`keys/bindings.ts` `commandPresenters`), like
  `view.panel.toggle`: the chord, the palette and the menu step only this window's
  history. The CLI's `code-foundry view back` goes through the daemon and reaches every
  window as a ShowView, like the other `view.*` actions.

## History (`stores/ui.ts`)

* `history: Selection[]` and `historyIndex`, seeded with the dashboard as entry 0.
  `select` is the one place a selection changes, so it is the one place that pushes:
  `selectionUpdate(s, sel, { push })` is shared by `select` (push) and `back`/`forward`
  (no push; they move the index themselves).
* A push drops the forward entries, skips a selection equal to the **current entry**
  (consecutive duplicates collapse; re-selecting the current entry after going back keeps
  the forward entries, as in a browser that reloads the same page), and keeps the last
  `HISTORY_MAX` = 50 entries.
* Every selection kind is recorded: dashboard, Pull Requests, Projects, Ember, the
  composer, threads.
* Stepping onto a thread asks its prompt for focus (`promptFocusSeq`), like a sidebar
  pick or `select(…, { focusPrompt: true })`.
* **Stale entries.** Before stepping, `pruneHistory` drops entries that can no longer be
  shown and collapses the duplicates that leaves next to each other; the current entry
  always stays (the index follows it). Gone means: a thread no longer in
  `useThreadsStore.byId` (archived threads are still there and stay selectable), or a
  composer whose workspace or project is no longer registered (the no-project composer
  never goes stale). Nothing counts as gone until its store has loaded. The subagent
  view is not a selection (it is extra state on the thread selection,
  `stores/subagentView.ts`), so it is not a history entry and cannot go stale; stepping
  off a thread leaves its subagent view as any selection change does.
* Not persisted: `partialize` lists fields explicitly and history is not among them, so
  a window starts with `[DASHBOARD]` like its selection.

## Settings, Usage and Themes pages

These are window-level pages in `stores/views.ts`, not selections, so they are **not**
history entries (the brief listed settings as a selection kind; it is not one). What
`historyCommand` does instead:

* **Back with one of them up closes it** the way its Esc or × does (`closeThemes`,
  `closeSettings`, `closeUsage`), revealing what was on screen before it, and does not
  step. The Themes page opened from Settings goes back to Settings. So Thread A →
  cmd+, → cmd+[ lands on Thread A, as a user would expect; a second cmd+[ steps back.
* Forward with a page up steps when there is a forward entry (the selection change
  closes the page through `startViewSync`); with none it does nothing.
* Forward cannot reopen a page that back closed. Making the pages history entries would
  need a second entry kind spanning two stores; not worth it until someone asks.

## Key dispatch

* Both chords start with cmd, so `terminalYieldable` yields them out of a focused shell
  and the thread prompt (`[data-chord-yield]`). No component handles cmd+[ or cmd+]
  (the side panel's own chords are cmd+w, cmd+alt+\ and bare letters; the PR keys stop
  only unmodified keys), and the handler runs in the capture phase anyway.
* **Gotcha found live: the Settings page swallowed them.** Opening Settings focuses its
  search field, and rule 3 of `handleKeyDown` (a plain text field consumes every chord)
  meant cmd+[ did nothing there. Back and forward now also leave a focused text field
  (`fieldYielded` in `keys/bindings.ts`), as Safari's do, but only for cmd chords that do
  not edit text (a rebind to cmd+arrowleft or cmd+backspace stays with the field) and
  never from the palette's input.
* WKWebView does **not** treat cmd+[ as page back in the Wails window: no native menu item
  carries the accelerator, and the page stayed put in every check below.

## Verified live (2026-10-21)

`make build gui-build`, daemon and GUI on an isolated `CODE_FOUNDRY_HOME=/tmp/cf-selhist`,
three no-project threads (alpha, bravo, charlie; Haiku 5.5, never prompted). Clicked
through them and the dashboard, then:

* Nothing focused (on the dashboard): cmd+[ went to charlie, whose prompt took focus.
* Composer focused: cmd+[ went to bravo, cmd+] back to charlie; no `[` reached the
  prompt.
* Bottom panel shell focused (cmd+j in charlie): cmd+[ went to bravo; the shell got no
  stray characters.
* Settings open (search field focused): cmd+[ closed it onto charlie; cmd+[ again stepped
  back. This failed before the text-field fix above.
* The palette lists "Back view.back ⌘[" and "Forward view.forward ⌘]"; running Forward
  from it stepped forward. Settings → Keybindings lists both under View.
