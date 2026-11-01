# e2e → vitest: cleanup (DROP and GO rows)

First PR of the e2e → vitest series that follows docs/notes/e2e-bundled-build.md. The audit
classed 60 e2e tests (64 cases, 174 s of serial test time measured on the dev server before
#467) as DROP (a unit test or another e2e test already makes the assertions, or the test
asserts the mock) or GO (a daemon rule asserted through the mock; Go tests own it). Each was
checked against the test it was said to duplicate before it went. Where the unit test lacked a
small GUI part, that part was added to vitest first.

## e2e removed (55 tests, 3 files) and kept for SHOTS (5)

Removed, each with a pointer comment at its old place:

* projects: Refresh and a failed refresh; worktrees to tidy.
* composer-files: Enter before the first answer; a slow search; a failing search.
* mcp-panel: a stopped thread; a check going stale.
* settings: a bool and an enum saving; cmd+/ and the shortcuts tab.
* theme-editor-fuzz: 3 (Escape with edits) and 5 (a light surface on a dark theme).
* composer-polish: shelf headers (pixel offsets of a static header).
* page-verbs-panel: view.panel.page refusing a non-page (Go).
* bottom-panel: an off-screen panel's last shell exiting.
* thread-prompts: a failed answer bringing the prompt back.
* ember: the row opening the chat and its menu.
* page-library: the TSX syntax error box (the "errors name the page's file" test checks
  broken.html too, and now takes its screenshot).
* update: daemon.restart asking (Go), dev builds saying updates are off.
* user-themes: Delete and the slot falling back (Go).
* welcome-composer: the first project clearing an untouched prompt.
* plugin-gaps: the info card's flag and Clear flags.
* gitops: a second op waiting.
* row-error.spec.ts (the file): a row that fails to render.
* plugin-flags: an until-seen flag going on open (Go).
* plugin-owned: Ask the main thread with the panel's context.
* themes: Escape discarding the preview; the companion suggestion.
* archive: put-away selection going home.
* subagent-view: thread.agent.open from the CLI (refusals are Go's).
* lineage: the wake note; a created thread not taking the view (a 500 ms sleep proving a
  negative); archiving the creator (Go).
* bridge: a call waiting on the confirm not timing out (two 1.5 s sleeps); cf.on with a bad
  source; the File tab without a thread; the File tab with one (duplicate of "the panel copy");
  a page starting a thread.
* sidebar: the Projects view's actions; a multi-project thread's card.
* panel: disabled surface hotkeys.
* composer-fixes: 12 (the crumb names the workspace).
* file-tabs: a missing path relocated.
* inline-html: pages shown between turns.
* workspace-page: the synthetic workspace.
* theme-model-flow: theme.save's contrast check and toasts (Go).
* code-block-actions: Copy.
* paths: Tab completion (Go owns the listing rules); the 200 cap (Go).
* thread-header: the crumb loop (4 cases), including tombstone checks for nine test ids that
  no longer exist in src.
* plugin-env-restart: restarting a working thread asks (Go).
* page-verbs: view.settings --page; project.add.
* plugin-registry.spec.ts (the file): no registry configured.
* daemon-unreachable.spec.ts (the file): sending while the daemon is down.

Kept only to take screenshots (`test.skip(!SHOTS)`), every assertion now unit-tested:
theme-model-flow's Apply and Undo, path-chips' Write row, bridge's confirm dialog (cut to the
dialog and its screenshot), and thread's live tool strip (cut to opening the strip, both
schemes). Without SHOTS none of them runs, so all 174 s go from a normal run.

## What moved to vitest

New files:

* `components/compose/CompletionCard.test.tsx`: Searching… with the hints hidden, the rows
  replacing it; a failed search's empty text.
* `components/palette/pathCompletion.test.tsx`: "Folders (first 200)" for a bounded listing;
  the git and already-added marks.
* `components/plugin/PluginSurface.test.tsx`: the surface's watch opens with the panel's
  thread as its context (an act carries it: pluginAct.test.ts).
* `components/thread/activity.test.ts`: `timelineStrips` on while working or waiting mid-turn,
  off 2 s after the turn and for a stopped thread (the ThreadPane wiring the strip e2e covered).
* `stores/openRequests.test.ts`: a request being answered leaves, a failed answer brings it back.
* `stores/sendDraft.test.ts`: a send that never reached the daemon keeps the draft with the
  unreachable line; a sent one clears it.

Additions: `HelpOverlay.test.tsx` (the guide's wording, the App section's chords, a command's
chord), `ThemesPage.test.tsx` (the question stays after the Escape that asked, Cancel keeps the
editor, focus back on the list; Cancel on the save modal hands focus back to Save),
`UpdateDialog.test.tsx` (a refused check's line), `RowError.test.tsx` (TimelineList puts each
row behind its own boundary), `lineageRows.test.tsx` (the wake note collapses again),
`ConfirmDialog.test.tsx` (the "Asked by" caller line), `AddProjectDialog.test.tsx` (no folder
picker without a host), `keys/chord.test.ts` (escape formats as Esc, Back to Parent's chord).

No product code changed. No Go test was missing: every GO row's rule has one
(commands_view_panel_page_test, commands_update_test TestDaemonRestart, commands_theme_test,
store/thread/flags_test, commands_agents_view_test + palette_test,
commands_thread_cascade_test, commands_theme_check_test + commands_theme_card_test,
fsx/list_test, commands_thread_restart_test).

## Gotchas

* TanStack Virtual renders nothing in jsdom (no layout). Stubbing `offsetHeight` and
  `offsetWidth` on `HTMLElement.prototype` is enough for `TimelineList` to render its rows.
* The mock and the daemon disagree on the creator-archive question: the mock says "2 child
  threads are still working", the daemon "2 hidden child threads …"
  (commands_thread_cascade_test.go). The removed e2e test asserted the mock's words.
* mcp-panel's `expectStale` helper stays: its SHOTS loop uses it.
* The local `main` ref in a worktree can lag the branch point; diff against the commit the
  branch started from.
