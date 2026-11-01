# e2e → vitest: the shell

Part of the e2e → vitest series (docs/notes/e2e-unit-duplicates.md, e2e-vitest-surfaces.md,
e2e-vitest-projects.md). Area: the sidebar and thread list, snooze and archive, Ember, home and
no-project, Settings and its sheet, themes and the theme editor, usage, update, MCP and skills.
64 audited tests, 187 s by the audit's dev-server times.

## What moved

New test files:

* `components/sidebar/Sidebar.test.tsx` (16): the whole sidebar over the mock's world
  (`src/test/projectsWorld.ts`): the flat listbox's order with the Working, Snoozed and Archived
  headers; Home, ↓, Enter, End and ↑ on the list (the list's own onKeyDown); each row's badge
  (stopped reads idle, starting working, no lifecycle words); a stopped thread keeping its
  status (busy ends Interrupted, a prompt stays on top); the empty list and the daemon without
  ThreadService ("Threads: service unavailable"); the Working footer (collapse, count, the
  selection staying, the keyboard skipping hidden rows, counting threads as they start and
  stop, a pinned working thread on top); the Snoozed and Archived footers and a wake; Pin and
  Unpin and Regenerate name from the row menu through the faked daemon; the menu pane's
  current page; Ember's row reached by the arrows. TanStack Virtual is stubbed to render every
  row at its estimated size.
* `components/sidebar/RunIn.test.tsx` (4): Run in ▸ in the row menu (members, the current one
  disabled, thread.run-in's args and context), none for a one-project thread, the palette's
  RunInPicker, the row's "moving to …" until the move lands.
* `components/sidebar/SidebarStatus.test.tsx` (3): the status row's buttons in order, Usage as a
  toggle, Settings and Usage pressed one at a time (Themes in the sheet presses Settings).
* `components/ember/EmberTimeline.test.tsx` (3): only a turn's last text is the reply (Copy
  answer, task links), text between tool calls folds into its run and opens with it; paths in a
  reply (a chip only under a project's checkout, opening the File tab); the restart line and
  Interrupted on the row, the line staying after the wake. TimelineList is stubbed as in
  SubagentPane.test.
* `components/thread/SnoozeNote.test.tsx` (4): the composer's snooze line (until when with
  Unsnooze, "Snooze ended · just now" in amber, nothing otherwise).
* `components/thread/ThreadHeaderStopped.test.tsx` (2): a crashed or stopped thread's header
  names the project, never the path, model or state.

Additions to existing tests: `stores/update.test.ts` (the palette's app.update.check and
app.update presenters, the command re-list on a new update state), `SettingsPage.test.tsx`
(the "skills registries" hit; the keybinding recorder: the reserved chord, the daemon's
collision refusal shown, a valid chord saved, Escape cancelling a recording before it closes
the sheet), `SettingRow.test.tsx` (the theme slot editor: its options, no "(default)", the pick
saved, Choose…; Browse themes), `ThemesPage.test.tsx` (the sheet's way back to Appearance by ×,
crumb and Escape, theme.pick from outside, the scheme note after Light, a user theme applied,
the editor's initial filter and Escape from a slot view, the focus walk of fuzz 8,
no Delete on a curated row), `themeCards.test.ts` (undoFromLink, the toast's Undo),
`mcp.test.tsx` (the tools toggle per state and its collapse, a page's panel, the thread info
card's Open MCP panel), `views.test.ts` (theme.pick over usage), `UsageSheet.test.tsx` (cache
savings and rows following the range, the legend's order), `SidebarRow.test.tsx` (the card's
status for a permission and a plan, tone classes, a snoozed thread's card).

Product code: `SnoozeNote` (ThreadComposer.tsx) and `EmberPathPlace` (EmberPane.tsx) are
exported for their tests. No behaviour changed.

## e2e removed (26), shortened (37), kept (1)

Removed: mcp-panel "hidden for a page"; settings "the dark and light theme rows"; threads
"thread rows render with status badges", "a stopped thread keeps its status", "a crashed thread
keeps its composer", "Regenerate name"; theme-editor-fuzz "8, 9"; update "Check for Updates
finds a release", "app.update from the palette"; skills "Run setup"; home "no projects"; themes
"theme pick from the CLI"; archive "archiving a working thread asks first"; sidebar "the window
starts on the No project composer", "pin from the context menu", both Run in tests, "the header
counts threads as they start and stop"; snooze "snoozing a working thread", "a wake brings the
thread back", "the palette's Snooze"; ember "arrows reach the row", "only a turn's last text",
"paths in Ember's chat", "a restart that cut Ember's turn"; theme-model-flow "a theme a thread
applies shows a toast" (now a SHOTS-only test that takes its screenshot).

Shortened to the browser part, each with a comment naming the unit tests that took the rest:
computed CSS (the gallery's and the window's `--pane`, `--cf-canvas` after Save and apply, CSS
zoom, the swatch's colour, font weights, the hover-revealed row actions), html[data-theme]
following the scheme and the browser's dark, geometry (the menu pane's 8px, the dependent row's
indent, the header on the rows' edge, the footers stacked, the strip's edge, the tooltip's place
and width, the long status wrapping), global chords through the keymap (cmd+, cmd+1..5,
cmd+shift+a, cmd+= / cmd+0, cmd+N / cmd+T / cmd+j, the recorder swallowing cmd+k), real keys on
the focused list and the Themes list, Space on a header button, focus handoffs (the popover's
field, the search after Themes, the prompt after a FocusThread intent), clicks under a backdrop
and a toast over the sheet, reloads, the virtualized Ember chat, one WatchBoard stream, the
update source riding the events stream, the real ProseMirror send.

Kept as it was: home "with projects" (the window's first route, the editor's Escape and the
heading picker's Escape, which no unit test covers yet).

Time: the 26 removed tests took 74.2 s (dev server); the 38 that stay took 112.8 s and now take
51.1 s (bundled build, 2 workers). On the bundled build (about 0.95 s less per test,
e2e-bundled-build.md) that is roughly 75 s of serial test time saved.

## Rules that belong in Go, not here

Not moved, because they are the daemon's and have Go tests: the palette titles "Download vX"
and "Install vX and Restart" (`internal/command/commands_update_test.go`), view.panel.mcp's
availability on a page (`commands_mcp_test.go`), thread.run-in's availability, queuing until idle
and the new worktree (`internal/command`, `internal/store/thread/runin_test.go`), the per-scheme
theme lists (`internal/store/settings/theme_test.go`), the keybinding collision refusal
(`internal/store/settings`), the toast only for an applied save (`commands_theme_card_test.go`),
the "copy 2" names (`internal/store/usertheme/usertheme_test.go`), asking before archiving or
snoozing mid-turn (`commands_thread_snooze_test.go`), a message unsnoozing.

## Gotchas

* `projectsWorld.thread()` has no `flags` or `linkedPullRequests`; ThreadMenuItems reads
  `flags.length`. The new tests add them (and the mock's s-6 last activity, s-9's 4 d 1 h)
  in their own setup rather than changing the shared fixture.
* `putEmberThread` replaces the thread list: pass the world's threads as its `others`.
* jsdom does not turn Enter or Space on a button into a click: the focus walk clicks the row,
  and Space on a footer header stays e2e.
* Radix's Escape listener is on the document in the capture phase, so SettingsSheet's recorder
  check (`[data-key-recorder][data-recording]`) runs in jsdom too.
* Ember's path chips need `EmberPathPlace` (only paths under a project's checkout are chips);
  EmberTimeline alone chips relative paths against the thread's directory.
* `bun check -b` rejects assigning the commands store's readonly list to `daemon.commands`.
* Mock endpoints with no e2e caller left: `GET /__mock/themes`, `POST /__mock/ember/restart`,
  `/__mock/ember/task/add`, `/__mock/thread/wake`. They stay for now.
