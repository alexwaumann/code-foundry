# Sidebar thread card: linked PRs, workspace rows, run-in on the row

Status: branch `cf/sidebar-thread-card`, one PR, GUI only (no daemon, proto or command
change). The design was settled with Alex from screenshots before the build; this PR
follows it and does not redesign. It builds on PR #401 (docs/notes/thread-checkouts.md:
the row's branch is read from HEAD) and the linked-PR tag (docs/notes/sidebar-pr-tag.md).

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/lib/threadRow.ts` | `ThreadRowModel.place` (`"fresh" \| "folder" \| null`) and the pure `threadPlace` |
| `gui/frontend/src/components/sidebar/linkedPrTag.ts` | `linkedPrCardRows`: the counted PRs (closed left out), capped at `LINKED_PR_TIP_CAP`, plus how many more |
| `gui/frontend/src/components/sidebar/TipLinkedPrs.tsx` | the card's linked-PR section (new file) |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | `ThreadTipBody`: workspace row, the place chip on the project row, no "worktree" chip on the branch, `TipSet` removed, `TipLinkedPrs` last; `ThreadLine` prints the run-in project |
| `gui/frontend/src/components/thread/useThreadPlace.ts` | `inFolder` (a thread in its workspace's folder) |
| `gui/frontend/src/components/thread/Chip.tsx` | comment only |

## Behaviour

* **Linked PRs on the card.** After the model row: a 1px hairline (`bg-cf-border`, the
  card's full width, 6px above and below), then one row per linked pull request in the
  Linked PRs surface's order (newest linked first, `useLinkKeys`). Each row: the state
  icon (`prStateLook`) and `#142` in the state's colour (`prStateText`), then the title,
  truncated; the bare `#number` while the title is unknown. No heading label. Closed ones
  are left out, as the tag does; at most five rows, then a muted `+N more`. No counted PR:
  no section and no hairline. The tag's own tooltip (`linkedPrTip`) is unchanged.
* **A multi-project thread's card** (`threadRowModel(...).set !== null`): row 1 is the
  workspace (Layers icon, its name, else "N projects" as `setLabel` says); row 2 the
  run-in project; row 3 the branch (from HEAD); row 4 the model. The member list
  (`TipSet`) is gone.
* **The project row's chip says where the thread runs**, in the composer's Work in words
  (`FRESH_COPY` / `PROJECT_FOLDER` from `lib/compose`): "Fresh copy" in a worktree Code
  Foundry made for it (worktree mode, `createdWorktree`), "Project folder" in the
  project's main checkout or a project without git, no chip in a worktree the user picked.
  This replaces the old "worktree" chip on the branch row, for single-project threads too.
  A single project without git keeps its "no git" chip (the cases that existed stay).
* **A thread in its workspace's folder** (no project id): row 1 the workspace, row 2
  "Workspace folder" (`WORKSPACE_FOLDER`, Layers icon, the composer's Runs in word) with no
  chip, rather than the workspace's name a second time.
* **Row line 2** prints the run-in project `@ branch` for every thread, exactly like a
  single-project row; the workspace's name or "N projects" never shows there. A thread in
  its workspace's folder keeps the workspace's name, since that is the place.
  `data-set` stays on `row-project` as a marker.

## Decisions

* Section A without a label (agreed): the hairline is enough to separate it.
* Project and branch on separate rows (agreed), as the single-project card has them.
* Chip words reuse the composer's "Fresh copy" / "Project folder", so the card says what
  the Work in pill said when the thread was made; no chip for a hand-picked worktree.
* **The fresh rule is `createdWorktree` only**, not "any non-main worktree": the brief
  listed both, but a non-main worktree is exactly the hand-picked case that gets no chip,
  and only worktree mode says Code Foundry made it. A made worktree that is missing until
  its next start still reads "Fresh copy". The main checkout wins over worktree mode (a
  set's no-git or main-checkout primary reads "Project folder").
* "2 projects" for an unnamed set (the label the row used before).
* The member list was dropped from the card; the Workspace surface lists members.
* `place` lives in `threadRowModel` with table tests, not in the component.
* The Threads tab (`lineage/ThreadsSurface` `Place`) still prints the set label: the brief
  scoped line 2 to the sidebar row. A follow-up if the two should agree.

## Gotchas

* The card body mounts only while open, so `TipLinkedPrs` subscribing to the gh resources
  (`useLinkedPrFacts`) costs nothing while closed; nothing new is fetched.
* `useThreadPlace` computes `project` without the workspaces lookup, so for a
  workspace-folder thread it is the raw `w-<id>`: line 2 prints `set` there (`inFolder`).
* In jsdom the card opens with fake timers: `pointerMove` on the row, advance 600 ms
  (the provider's 500 ms delay). Radix duplicates the content in a visually hidden copy,
  so tests take the first `thread-tooltip`.
* In the mock, PRs on no dashboard (#147, #131) read unknown until the Linked PRs list
  reads their details; the screenshots open the list first.

## Tests

* Unit: `threadRow.test.ts` (`threadPlace` table: main checkout, worktree mode, a missing
  made worktree, a picked worktree, no git, workspace folder; `threadRowModel.place`),
  `linkedPrTag.test.ts` (`linkedPrCardRows`: closed left out, order kept, unknown counts,
  cap and more), `SidebarRow.test.tsx` (card rows and order for one project, a workspace
  thread, an unnamed set, the folder; chip fresh/folder/none/no git; the PR section's
  rows, colours, cap and its absence; line 2 of multi-project and folder threads).
* e2e (WebKit, mock): `linkedprs.spec.ts` (the card's PRs for s-1, closed #131 leaving
  after the list reads it), `sidebar.spec.ts` (a new multi-project card test; line 2 and
  the Run in move name the run-in project; the tooltip test's chips), `project-sets.spec.ts`
  and `composer-fixes.spec.ts` (line 2 and the folder card), `workspace-cards.spec.ts`,
  `lineage.spec.ts`: 
  `E2E_MOCK_PORT=7820 E2E_VITE_PORT=9320 pnpm e2e e2e/linkedprs.spec.ts e2e/sidebar.spec.ts e2e/project-sets.spec.ts e2e/composer-fixes.spec.ts e2e/workspace-cards.spec.ts e2e/lineage.spec.ts`.
* `make check` green.
* Screenshots from the mock daemon (WebKit, deviceScaleFactor 2, dark and light) in the PR.

## Follow-up: the workspace row's project count

A named workspace's row on the card now ends with "N projects" on the right, muted
(`TipRow`'s new `meta` slot: a muted text where a chip would go, never both). An unnamed set
already says "N projects" as its label, so it gets no meta. The count is the thread's
project list (`projectCount`), including a thread in its workspace's folder. The label
comes from `projectsLabel` in lib/threadRow, which `setLabel` now shares ("1 project" for a
one-member workspace). Test ids: `tip-workspace-meta`.
