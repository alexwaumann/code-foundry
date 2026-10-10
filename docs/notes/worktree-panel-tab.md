# Worktree tabs from the Projects page and in a thread's panel

Status: done on branch `t3code/ca3bc64a` (2026-10-10). `make check` and `make gui-e2e`
green; `make gui-build` done. Builds on the side panel (`side-panel.md`) and the
workspace surface's member tabs (`workspaces-5-panel.md`).

Alex's ask: double-clicking a repo or worktree on the Projects page opens it in the side
panel as a tab, and that same tab is available in a thread, showing the thread's
repo/worktree content in its panel. His review of the first cut: the main-pane overview
page "should be trashed, it's not needed anymore, that was the point of moving it to the
side panel", so the second commit removes it (section below).

## What landed

| Path | What |
|---|---|
| `gui/frontend/src/surfaces/worktree.ts` | The Worktree surface is now listed: hotkey T, `enabled` for a thread or terminal placed in a registered worktree, `hidden` otherwise; `openDefault` is the selection's own worktree |
| `gui/frontend/src/surfaces/workspaceTarget.ts` | `selectionWorktree` (pure: the thread's or terminal's worktree from `deriveContext`), `worktreeTab`/`worktreeOfTab` (the member helpers are aliases now) |
| `gui/frontend/src/stores/worktreePanel.ts` | `worktreeTabTitle`, `openWorktreeTab`, `showWorktreeInPanel` (the Projects page's rows), `openWorktreeSurface` (the thread's own) |
| `gui/frontend/src/stores/views.ts`, `keys/bindings.ts` | `worktreePanelCommand`, `showView("panel.worktree")`, the local presenter |
| `gui/frontend/src/components/projects/ProjectsPage.tsx` | Enter or double-click on a project row (its main worktree) or a worktree/member row shows the worktree in the page's panel; a new "Open project overview" row button (`project-open`); the worktree row's Open button is labelled "Open worktree overview" |
| `gui/frontend/src/components/projects/WorkspaceMembers.tsx` | The page-layout member row's Open button got a test id (`member-open-overview`) and the row a title |
| `internal/command/commands_view.go` | `view.panel.worktree` ("Show Worktree in Side Panel", View, no chord), `When` = a thread or terminal plus a repo and worktree path |
| `gui/frontend/mock/world.ts` | `view.panel.worktree` with the same availability |
| `gui/frontend/src/surfaces/worktree.test.tsx` | Titles, availability (thread, terminal, pages), T, the command, ShowView, `showWorktreeInPanel` |
| `gui/frontend/e2e/worktree-panel.spec.ts` | 4 tests per engine: Projects rows (double-click, Enter, dedupe, focus stays), the Open buttons, T/list/palette for a thread, the CLI's ShowView and a terminal outside any worktree |
| `gui/frontend/e2e/fixtures.ts`, `sidebar.spec.ts`, `panel.spec.ts`, `live-prs.spec.ts`, `live-nogit.spec.ts` | `selectWorktree`/`selectProject` go through the rows' Open buttons now; the empty list has four entries for a thread |

## Decisions

* **One surface, not two.** The member tab from step 5 was already "one worktree's
  overview as a tab, keyed by repo + path", so the Projects page and the thread reuse it.
  The same worktree opened from a project row, a worktree row, or T is one tab id, so a
  second activation just activates it.
* **Enter follows double-click.** `NavRow` treats Enter and double-click as one
  "activate", and the page's keyboard model is built on that, so both now open the panel
  tab. The overview page stays one click away: the project row got an Open button like
  the worktree rows already had (`FolderOpen`, "Open project overview"), and the e2e
  fixtures that used to double-click rows to reach the overview page use those buttons.
* **Projects page: shown, not focused.** `showWorktreeInPanel` opens the tab in the
  page's own panel (`view:projects`) and shows the panel without a focus request, so the
  list keeps the keyboard and Enter on the next row swaps the tab. The workspace
  "Show in thread" button is different (it focuses) because it also changes selection.
* **Titles.** The project's name for the main worktree, `name · branch` for any other,
  so a project's worktrees opened side by side stay apart (`code-foundry`,
  `code-foundry · feat/sidebar`). A path the store does not know gets the project alone.
  Member tabs keep step 5's project-only title (every member is on the same branch).
* **Availability in a thread = placed in a worktree.** `selectionWorktree` reads
  `deriveContext`'s `activeRepoId` + `activeWorktreePath` for a session or a terminal
  (a plain terminal inside a worktree counts). Hidden, not disabled, elsewhere: the
  worktree and repo pages (the overview is the content already), the top-level pages,
  the composer, and a thread whose cwd is in no registered worktree. The Go `When` is
  the same rule (`hasSession || hasTerminal`, and `hasWorktree`); from the CLI it needs
  `--context-session`/`--context-terminal` with `--context-repo` and
  `--context-worktree`.
* **Hotkey T.** F, D, P, L and W were taken. The panel's letter map is case-insensitive
  and only fires outside text fields.
* **No header button.** The thread header already truncates titles with the panel open
  (`workspaces-5-panel.md` gotchas); the empty list, T and the palette cover it.

## Screenshots (WebKit, mock daemon, 1400x900)

`/tmp/cf-shots/worktree-tab-projects.png` (two tabs in the Projects page's panel after
double-clicking the feat/sidebar row and the code-foundry project row),
`/tmp/cf-shots/worktree-tab-thread-list.png` (a thread's empty panel listing Worktree
with T) and `/tmp/cf-shots/worktree-tab-thread.png` (the thread's own worktree after T).

## The overview page is gone (second commit)

* **Removed:** the `repo` and `worktree` selection kinds (`stores/ui.ts`), the
  `WorktreeOverview` page and `Dashboard.tsx` (its threads/terminals section too: the
  sidebar is the thread list), the Projects page's "Open overview" buttons from the first
  commit and the member rows' Open button, `openProject`/`openWorktree`. The content pane
  shows a terminal, a session, the composer, the Pull Requests or Projects page, or the
  start page.
* **Where the former entry points go** (`stores/worktreePanel.ts`):
  `ui.focus.repo` (the daemon's FocusRepo intent, emitted by `worktree.create` and the
  Add Project flows through `selectAddedProject`) → `showWorktreeOnProjectsPage`: the
  Projects page with the worktree's tab in its panel (an empty path means the main one).
  The thread row menu's Show worktree → `showWorktreeInThread`: the thread's own panel
  with its worktree tab, focused. The composer's Escape with an empty draft → the Projects
  page (it used to go to the repo overview).
* **Actions without a selection.** The Projects page's row actions (new terminal, remove
  worktree, unregister) and the panel's Initialize Git button build their context with
  `worktreeContext`/`repoContext` (`stores/context.ts`, `activeView: "projects"`) instead
  of deriving it from a selection. The panel's no-git body is a plain button calling
  `repo.git.init` with that context, because a `CommandButton` reads the selection's
  context, and the Projects page has none.
* **Consequence to know:** the palette on the Projects page has no repo or worktree
  context, so `git.fetch/pull/push`, `pr.create`, `worktree.create`,
  `repo.github.publish` and `repo.git.init` are offered there only through a thread or
  terminal in that worktree (or the CLI, or the Publish / Initialize Git buttons in the
  tab). The e2e tests that used the overview page for those commands now select a
  thread (`s-1`, `s-4`, `s-6`) or start a terminal from the project row.
* **Persisted state.** The ui store does not persist the selection, so no stored
  `repo`/`worktree` selection can come back; panel entries under `repo:`/`worktree:`
  keys stay in localStorage unused (a few bytes, as `side-panel.md` already accepts).
* **Worktree tab for a project without git:** the header shows the name with the No git
  badge, the body the "Not a git repository" section with Initialize Git (`data-git` on
  `worktree-surface`).
* **e2e fixtures** `selectWorktree`/`selectProject` now double-click the row and wait for
  the tab (`worktree-surface` with `data-path`/`data-repo`); `overview-title` →
  `worktree-surface-title`, `overview-page` → `worktree-surface`. The PR row in the
  Projects page's worktree tab opens the PR as a second tab of the same panel
  (`pr-panel.spec.ts`).

## Gotchas

* `view.panel.worktree`'s palette presenter runs locally like the other panel
  commands, so the mock records no invocation; the e2e asserts the tab and focus instead.
* `panel.spec.ts` counted exactly three empty-list entries for a thread; it is four now.
* The vitest for a terminal selection needs an open panel entry under `terminal:<id>`
  (and `worktree:<repo>:<path>` for the page check), or `SidePanel` renders nothing.
