# Projects polish 2: always-visible actions, overflow menus, thread counts, freshness

PR 2 of three for the Projects page (sketch variant A, `/tmp/cf-projects-sketch`,
`?always=1`). The "in main" tag, the broom and "Clean up merged worktrees" are PR 3.

## What changed

- **Rows drop the path.** `WorktreeState`'s `showPath` now defaults to false (the row's
  `title` keeps the full path); the folder without git always prints its tildified path,
  since it has no branch to name it.
- **Live thread count** at the start of the state group: `MessageSquare` + the number of
  threads whose `worktreePath` equals the row's path and whose state is not disconnected
  (`liveThreadCount` / `isLiveThread` in `lib/projects.ts`; `liveWorkspaceThread` uses the
  same predicate). Hidden at 0, "1 live thread" / "N live threads" tooltip. Each row
  subscribes to its count only. Member rows get it through `WorktreeState`, and so does the
  side panel's workspace surface.
- **Actions always visible**, muted at rest (rows `opacity-55`, headers `opacity-70`),
  full on row hover, focus-within, aria-selected, the card's hover for headers, and while
  its menu is open (`has-[[data-state=open]]`). Row action columns have a fixed width
  (`w-18`: three slots for worktree rows, the main one included; `w-12` for members) so the
  state columns end at one x.
- **Overflow menus** (`components/projects/OverflowMenu.tsx`, shadcn `DropdownMenu`,
  non-modal). Worktree: Show in side panel, then (not main) separator + Remove worktree….
  Project: New worktree… (git), Publish to GitHub… / Initialize git (per gate), separator,
  Remove project. Workspace: Remove workspace. Member: Remove from workspace. Destructive
  items keep the daemon's confirm prompts. Testids of the moved actions are unchanged
  (`worktree-remove`, `project-unregister`, `workspace-remove`, `member-remove`), now on
  menu items; the triggers are `*-more`, the menus `*-more-menu`.
- **Publish / Initialize git gates**: `projectNextStep` (table-tested) is "publish" for
  `isRemoteless`, "init" for `git === false`, else null. Publish opens the existing
  publish dialog; Initialize git invokes `repo.git.init` with the project's context.
- **Freshness + Refresh** on git project headers: `Freshness` with the main worktree's
  `status.refreshedAtMs` / `status.error`, stale after 10 minutes. Refresh runs `git.fetch`
  on the main worktree when the project has a remote (the gitops toasts report it, failures
  included), then `repo.refresh {repo}` quietly; the icon spins and the button is disabled
  meanwhile. No single daemon command does both.
- **New worktree…** opens the palette on `repo.worktree.new` in that project's context
  (it asks for the branch). `openPalette` takes an optional context for this; the palette
  waits for that context's command list before entering the prompts.

## Decisions and gotchas

- **Daemon: RefreshedAt was "last change", not "last check".** The repo store skipped the
  snapshot rebuild for an unchanged status, so a quiet repository's `refreshed_at` aged
  forever and the header would read "updated 40m ago · stale" while git status was being
  polled every 30 s (and Refresh would not move it). An unchanged status now republishes the
  worktree (snapshot + `WorktreeUpdated`) once the published time is a minute old
  (`republishAfter` in `internal/store/repo/store.go`, test in `republish_test.go`). Cost:
  at most one event per worktree per minute.
- Menu keys are stopped at the menu content: React portals bubble synthetic events to the
  row and the list, whose arrow keys would otherwise move the list's cursor (and clicks
  would set it). On close the focus goes back to the page's list.
- **A picked item runs only after the menu has closed** (from `onCloseAutoFocus`). Run
  from `onSelect`, the palette opened under the pointer while the menu was still animating
  out; Radix's `onItemLeave` then focused the closing menu, the palette's focus scope pulled
  the focus back with `select: true`, and the next keystroke replaced what had been typed
  (WebKit, about one run in three: "exp/x" became "x").
- Radix keeps a closing menu in the DOM for its exit animation: e2e waits for
  `*-more-menu` to be gone before opening the next one (strict-mode duplicates otherwise).
- `RowAction` stops double-clicks, so quick clicks on an action no longer open the row's
  panel tab; it gained `disabled`.
- The mock had `worktree.create` (an old name, still used by `app.spec.ts`); it now also
  has `repo.worktree.new` with the daemon's args, and `repo.refresh` takes `repo`.
- The no-git row shows three slots like the others (its overflow has Show in side panel).

e2e: `gui/frontend/e2e/projects.spec.ts` (actions without hover and their opacity, equal
action column widths, no path on rows, thread counts incl. a workspace member, menus per
row kind, menu keeps the list cursor and focus, Publish/Init gates, freshness, Refresh's
fetch-then-refresh order and failure toast, New worktree via the palette).
