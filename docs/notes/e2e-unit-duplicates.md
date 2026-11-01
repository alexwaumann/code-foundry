# e2e: unit-covered duplicates out, vitest-first rule

An audit read all 102 mock-daemon specs (about 760 tests; the 13 `live-*` specs were out of
scope). Its rough split was 331 tests whose logic belongs to one component, store or function
(vitest could check it), 178 that pair unit logic with one browser-only check at the end, and
251 that really need the browser. The audit also put at least 130 of them down as duplicates of
an existing unit test.

That duplicate count did not survive a closer read. Four agents, one file group each, opened the
unit test named for each flagged e2e test and deleted the e2e test only when every assertion in
it was already made in vitest. 13 tests went:

* home: the custom and none backdrops (`Backdrop.test.tsx`).
* transcript-deleted: Fork disabled in the row menu (`RowMenu.test.tsx`).
* panel: closing the tab picking came from (`SidePanel.test.tsx`, `panel.test.ts`).
* composer-collision: one project's banner going when the other thread stops (`Composer.test.tsx`).
* memory: an entry too long for threads (`RememberedSection.test.tsx`).
* composer-failed-notice: the Edit-with-no-draft wording and the API error first line (`failedPrompt.test.ts`).
* plugins-layout-fuzz: a refused choice after a later one (`layoutprobe.test.tsx` md-1).
* mcp-panel: empty tabs and the per-thread tab (`mcp.test.tsx`, `mcpTabs.test.ts`).
* subagent-view: back buttons and crumb, and switching thread (`SubagentPane.test.tsx`, `subagentView.test.ts`).

Each removal site has a one-line pointer to the unit test that covers it.

## Why so few

Most flagged tests overlapped with a store or pure-function test while asserting the rendered
result (a heading, aria state, a toast, a live update over the stream, a confirm dialog) that
no component test checks. They are not duplicates. They are unit tests that have not been
written yet. Moving them is the next PR:

1. Write the missing component tests, then drop the e2e tests. Start with what only e2e covers
   today: dictation (13 tests), ProjectsIndex, ProjectPage and LeftoverWorktrees, PluginsPage and
   ConsentDialog, the Diff tab and `codeView`, the git-op toast, the cold-cache timer, the Ember
   components.
2. Split the long tests that end in one browser-only check. The logic moves to vitest and a
   short e2e test keeps the geometry, focus or CSS. Start with pr-panel, thread, thread-info and
   panel, which set the wall time.

## Rule

CLAUDE.md now has "Tests: vitest first, e2e only for the browser": a test vitest can check is
never written as e2e, a mixed test is split, and daemon rules are tested in Go rather than
through the mock.

## Gotchas

* The unit harness never drives the real ProseMirror editor (`useCompletion.test` uses a faked
  handle), so composer tests only move down to the hook or store level. Caret, undo, paste and
  tag atoms stay e2e.
* `tsc -p .` does not include `e2e/`; `tsc -p tsconfig.node.json` does.
* subagent-view.spec.ts had been failing on main since a2b08083e capitalised the model alias in
  the unit tests only. It is fixed here.
* sidebar.spec.ts "multi-project card" asserts `tip-project-chip` "Fresh copy", while
  `SidebarRow.test` asserts the same text as `tip-project-meta`. Left as is; one of them is
  probably stale.
