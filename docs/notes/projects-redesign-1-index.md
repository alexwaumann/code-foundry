# Projects redesign 1: full-width index that drills into a project page

PR 2 of the Projects redesign (direction D, agreed 2026-10-31). PR 1 applies the icon set
outside `components/projects`; PR 3 adds "Worktrees without threads"; PR 4 replaces the
workspace page's body.

## What changed

- **Two full-width pages in the content pane**, no second column: the index
  (`ProjectsIndex.tsx`) and a project's page (`ProjectPage.tsx`, with `CheckoutsTable.tsx`
  and `ProjectDetails.tsx`). `ProjectsPage.tsx` only routes by the selection. A workspace's
  page (`WorkspacePage.tsx`) has the new header over the existing `WorkspaceCard` until PR 4.
- **Index rows** by last activity (`sortByActivity`): the latest status change, activity or
  creation of any thread whose set has the project (archived ones included, so a project
  last worked on a week ago reads "1w"); projects without threads last, by name. Status
  sentence + dot (`projectStatusSentence`: "4 threads working · 6 checkouts", "idle · main
  only", no checkouts part without git), caption (`indexCaption`), pills only when non-zero
  ("2 PRs": branches with an open pull request, drafts included, from
  `branchPullRequestsResource`; "N worktrees to tidy": `useCleanableCount`, refined in PR 3),
  Publish / Initialize git links, age, hover actions (New thread, Terminal, the project
  menu), chevron. Workspaces section with the same row shape (members, "1 thread working on
  <branch>", "no instructions · 2 skills"). Empty state with the Add Project dialog's three
  tabs; no-match card naming the query.
- **Project page**: crumb › kind icon + name + picker (shadcn DropdownMenu: projects in the
  index's order, workspaces, Add project…; items mount only while open) · meta (slug, "local
  only · no remote", "origin · not GitHub", the folder's path) · "Refresh failed" pill ·
  Refresh (git), Terminal, New thread, the project menu. Kind notes (no remote: Publish; no
  git: Initialize git). Checkouts table (`sortCheckouts`: a working thread first, then main,
  then by activity) with Threads / Changes / Sync / Pull request cells (`threadsCell`,
  `changesCell`, `syncCell`; PR pill tinted by state with `PrStateIcon` + `ChecksBadge`).
  Click or Enter on a row opens its Changes tab (`openChangesTab`) as before. Row hover
  actions: New thread here, Terminal here, Show changes, the project's actions (`Play`, only
  when the project has some), the row menu (… Open pull request #N, Open in Finder, Copy
  path, Remove worktree… except on main). A folder without git has a Threads block instead
  of the table. Details: Path (Open in Finder, Copy), Default branch + "refreshed …" (red
  after a failed read), Remote, Worktrees (shared folder · count), Actions ("Edit" lists them
  for the editor, "Add an action" with none). No "Show in sidebar".
- **No New worktree** in any menu (`menus.ts projectMenu`); `project.worktree.new` stays for
  the CLI and agents. The per-row "in main" tag and broom went with the old rows; the
  project menu's Clean up merged worktrees (N) and the index pill keep the count.
- `LeftoverWorktreesSlot` in `ProjectPage.tsx` marks where PR 3's section mounts (a hidden
  div with `data-testid="leftover-worktrees-slot"`).
- Icons per the handoff table; the sidebar entry and the index header are `Folders`. In the
  workspace card (inside `components/projects`): `MapPin` sets where threads start,
  `Unlink` removes a member, `FinderMark` "Open in Finder".

## Selection model and panel keys

- The pages are `{ kind: "view", name: "projects" }` (index), plus `projectId` or
  `workspaceId` on the same view (`projectPage`, `workspacePage`, `PROJECTS_INDEX`,
  `isProjectsView` in `stores/ui.ts`). A view with an id rather than new kinds: every
  existing `kind === "view" && name === "projects"` check (App routing, contexts, the
  bottom panel's owner) keeps meaning "the Projects view". `sameSelection` compares the ids;
  `gone` drops a removed project's or workspace's page from history.
- Panel keys (`stores/panel.ts keyOf`): `view:projects`, `view:projects:project:<id>`,
  `view:projects:workspace:<id>`. Each page keeps its own tabs; a removed project's entry is
  left alone, like a deleted thread's.
- The bottom panel stays one for the whole view (`bottomKeyOf` maps every Projects page to
  `view:projects`): worktree shells are owned by that key (`ownerKeyOf`), and a per-page key
  would hide them on every other page. `revealShell` keeps the page shown instead of
  jumping to the index.
- `projectsLast` (persisted in the UI store, `projectsLocation`): the last Projects page
  shown, set by every select. The sidebar row (`openProjects`) goes there, or to the index
  from a project or workspace page, or to the index when the page's project is gone. Scroll
  position per page is in memory by panel key (`stores/projectsPage.ts`, `usePageScroll`);
  pages are keyed by it so a switch remounts.
- `showProjectOnProjectsPage` (ui.focus.project, a project just added) opens the project's
  page (cursor on the worktree's row when a path is given); `showWorkspaceCard` opens the
  workspace's page. A page whose project or workspace is removed while shown selects the
  index.
- `collapsedProjects` is gone from the UI store (no collapsible projects); `merge` ignores
  it in saved state, no version bump. `collapsedWorkspaces` stays for the card until PR 4.

## Decisions and gotchas

- **Narrow** is measured, not a breakpoint: the page's scroll box width below
  `PROJECT_NARROW_BELOW` (840 px) drops the Sync column and the meta, shows Terminal as an
  icon, tightens the columns and lays the row actions over the row's end (on the row's own
  hover colour) instead of keeping a column for them. 840 rather than the sketch's ~1000:
  a 1280 px window (the e2e size) has ~976 px of content without the side panel and should
  stay wide; 1440 with the panel open is ~700.
- **Worktrees row**: the proto has no "made by Code Foundry" flag on a worktree (only
  `merged_clean` carries it), so the row says the shared folder and the count, not "3 made
  by Code Foundry". **Branches row** (local-only, "experiment/shaders and 1 more, no
  worktree") needs a refs read; left out.
- The refresh-failed pill uses the main worktree's `status.error` and `refreshedAtMs`; the
  mock gained `POST /__mock/worktree/refresh-error?path=…&error=…&ago=<ms>`.
- `NavRow`'s row is the hover group; the inner span lays it out (a `display: contents`
  span has no box, so Playwright could not see its test ids).
- A prop named `title` on a component trips the tooltip guard (`lib/tooltips.test.ts`):
  `SectionHeader` takes `label`.
- `react-hooks/set-state-in-effect`: the workspace header's Rename… reaches the card's
  in-place editor through a counter prop compared during render, not an effect.
- `useNow(30s)` lags up to 30 s: "14m ago" can read "13m" right after the clock ticks; the
  e2e seeds 14.5 min.

e2e: `projects.spec.ts` (rewritten: index rows, sort, pills, links, hover actions, filter,
keyboard, empty, project page, picker, kinds, refresh + failure, narrow, panel per page,
remembered location, history, scroll memory, cleanup counts), `workspace-cards.spec.ts`
(each test on its workspace's page). Unit: `lib/projects.test.ts` (activity, sort, sentences,
cells, details), `stores/ui.history.test.ts` (pages in history, `openProjects`),
`stores/panel.test.ts` and `stores/bottomPanel.test.ts` (keys).
