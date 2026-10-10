# Workspaces step 4: flat thread sidebar, Projects page, "Run in…"

> **Superseded (2026-10-10):** `repo.register` (`code-foundry repo register --path`) was removed. Add a folder with `code-foundry repo add <folder>` on the CLI, or the Add Project dialog (`repo.add`) in the app; see `add-project-remove-register.md`. Mentions below are historical.

Status: done on branch `cf/workspaces-sidebar` (stacked on `cf/workspaces-composer`).
`make check`, `make gui-e2e` and `make gui-build` green. Exercised against a scratch
daemon with real haiku threads (below). Design record: `workspaces-handoff.md` (section 3:
"Run in…", "Sidebar becomes a flat thread list", "Projects page"); earlier steps:
`workspaces-1-store.md`, `workspaces-2-launch.md`, `workspaces-3-composer.md`. Step 5
(right panel workspace surface) is not started.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/command.proto` | `UiContext.active_workspace_id` (6); CLI `--context-workspace` |
| `proto/codefoundry/v1/session.proto` | `Session.pinned` (24), `SessionService.Pin` |
| `internal/db/migrations/0009_session_pinned.sql` | `sessions.pinned` |
| `internal/store/session` | `Session.Pinned`, `Store.Pin` (`Manager`, `sessiontest.Fake`), persisted |
| `internal/command/commands_session_pin.go` | `session.pin` (toggle, or `--pinned true/false`) |
| `internal/command/commands_session_runin.go` | `session.run-in` availability: `hasWorkspaceThread` |
| `internal/command/commands_view.go` | `view.projects` (cmd+shift+j) |
| `internal/command/commands_repo.go`, `commands_workspace.go` | "project" copy (titles, category, confirms) |
| `gui/frontend/src/lib/tree.ts` | the flat row builder (`buildRows`, `leafOrder`, `sessionOrder`); placement helpers kept |
| `gui/frontend/src/lib/threadRow.ts` | `threadRowModel` (project, branch, workspace badge, queued move), `terminalPlace` |
| `gui/frontend/src/lib/projects.ts` | `projectsModel`, `addableRepos`, `repoRef`, `pageItems` |
| `gui/frontend/src/components/sidebar/{Sidebar,SidebarRow,RowMenu,selection}.tsx` | the list, two-line rows, the row context menu |
| `gui/frontend/src/components/projects/{ProjectsPage,WorkspaceMembers,WorktreeState}.tsx` | the page, the reusable member list, one worktree's state line |
| `gui/frontend/src/components/palette/RunInPicker.tsx` | the palette's "Run in…" member picker (`palette.page = "runin"`) |
| `gui/frontend/src/components/ui/context-menu.tsx` | shadcn-style wrapper of Radix ContextMenu |
| `gui/frontend/src/stores/{sessionActions,projectActions}.ts` | pin, run in, close, fork; worktree/project/workspace actions, all registry commands |
| `gui/frontend/mock` | `session.pin`, `session.run-in`, `workspace.add-repo / remove-repo / remove`, `view.projects`, `repo.worktree.remove` (daemon name), `POST /__mock/workspace-thread` |
| `gui/frontend/e2e/sidebar.spec.ts`, `e2e/live-sidebar.spec.ts` | mock e2e; opt-in live e2e |

## Decisions

* **Flat list, sections.** Rows are threads, newest first (creation time, descending).
  Sections, each only when non-empty: **Pinned** (pinned threads, whatever their status),
  **Needs attention** (unpinned threads that need the user: needs-attention and not
  disconnected, the same rule as the attention badge), **Threads** (the rest; its header
  only shows below another section), **Terminals**. Headers are not rows the cursor can
  land on: ↑/↓, Home/End skip them; cmd+1..9 and cmd+shift+a count threads and terminals
  in display order (so cmd+1 is the top row now, not the first thread under the first
  repo). A thread moves between sections when its pin or attention changes; selection
  follows it by key.
* **Row.** Two lines (`rowHeight + 15`): status icon, thread name, model, workspace badge
  (Layers + workspace name, violet) and a pin glyph; below, `project · branch` of the
  worktree it runs in (the cwd, so a workspace thread shows the member it is in). The
  structure key per thread is id + attached terminal + pin + attention, so name, model
  and busy/idle changes re-render only that row; project, branch, badge and move come from
  narrow selectors over `threadRowModel`, each returning a string.
* **Terminals.** Terminals no thread owns (not a session's terminal by `terminal_id` or
  `labels.session`) get rows in their own **Terminals** section at the bottom of the same
  list: a terminal glyph, the title, and where it runs (`project · branch` of the worktree
  it is placed in by `labels.worktree` or the longest cwd prefix, else its cwd). The old
  "Other terminals" group is gone; nothing else changed for terminals (selection, attach,
  kill/remove from the row menu, cmd+N).
* **No repo or worktree rows anywhere in the sidebar**, so workspace worktrees cannot
  appear under their repo. The worktree overview is still reachable: the Projects page
  (Enter / double-click a worktree or member; a project row opens its repo overview), the
  row menu's "Show worktree", and the FocusRepo intent (`repo.worktree.new`). Composer and
  page selections have no sidebar row.
* **"New terminal" in the band** acts on the selected thread's worktree: `terminal.new`'s
  cwd is context-bound and a thread selection's context is its worktree (unchanged code,
  new e2e). The welcome panel and empty states are unchanged. (Superseded: the band's
  New terminal button was removed; terminal.new stays in the palette. See
  sidebar-title-band.md.)
* **Pinning is implemented** (it did not exist). `session.pin` toggles (`Get` then `Pin`),
  or sets with `--pinned`; the row menu passes the explicit value. `SessionService.Pin`
  works in any state and persists (`sessions.pinned`, migration 0009). No keybinding
  (palette and row menu).
* **Run in… entry points.** The row context menu ("Run in…" submenu, workspace threads
  only: the other members, the current one disabled as "runs here", a queued one marked
  "queued") and the palette ("Run Thread In…", presented by `RunInPicker`, a palette
  page listing the members). Both invoke `session.run-in` with `repo = <member repo id>`
  and the thread's own context.
* **Availability.** `UiContext.active_workspace_id` carries the owner workspace: the
  GUI sets it for a thread selection (and a thread's terminal, and a workspace composer).
  `session.run-in`'s `When` is `hasSession && (ActiveWorkspaceID != "" || ActiveView ==
  "")`: unavailable in the GUI for a project thread, and still available from the CLI
  (no view), where `--id` names the thread and the daemon refuses a project thread as
  before. The palette therefore lists it only on workspace threads (fixes step 2's
  "shows for every thread").
* **Queued move.** While `pending_worktree_path` is set and differs from the cwd, the
  row's second line reads "moving to <member project>…" (amber) instead of `project ·
  branch`; when the daemon types `/cd` it clears the pending path in the same update that
  changes `worktree_path`, so the row switches straight to the new member.
* **Projects page** (`view.projects`, "Projects" entry under "Pull Requests", cmd+shift+j;
  `viewNames` gains "projects"). Per project: name, GitHub slug, actions (new thread →
  composer, new terminal in the main worktree, remove project = `repo.unregister`); its
  own worktrees (workspace members excluded, a "N worktrees are in workspaces (below)"
  line instead) with branch, path, changed files, ahead/behind, and the viewer's pull
  request on the branch (`branchPullRequestsResource`, i.e. `GetBranchPullRequests`,
  only for a GitHub repo and a non-default branch; state, number, checks; click opens it
  in the side panel); row actions open, new thread here, new terminal here, remove
  worktree (not the main one). Per workspace: name, branch, new thread (workspace
  composer), remove workspace, then `WorkspaceMembers`. "Add project" in the header runs
  `repo.register` (the palette prompts for the path). Keyboard: the page is one listbox
  (`useNav`), Enter opens; row actions are mouse buttons and their commands are in the
  palette on the opened overview.
* **`WorkspaceMembers`** (`components/projects/WorkspaceMembers.tsx`, props
  `workspaceId`, `showAdd`) is the reusable member list for step 5's panel surface: per
  member the project and `WorktreeState`, actions open / new terminal / remove
  (`workspace.remove-repo`, the daemon's confirm), and "Add project" (a picker of the
  registered projects that are not members; `workspace.add-repo`). Rows are `NavRow`s:
  inside a `NavProvider` they join the page's keyboard list, outside one they are plain.
* **Commands name repos by name** when unique (`repoRef`), else by id, so the daemon's
  confirm reads "Remove project api from its workspace?". Workspaces are removed by name
  for the same reason (names are unique).
* **"Project" copy.** Daemon command titles, the palette category and confirm prompts for
  `repo.*` and `workspace.add-repo / remove-repo` say project ("Add Project", "Remove
  Project", "Refresh Project Status", "Add Project to Workspace", "Remove Project from
  Workspace"); GUI copy too (sidebar band "Threads", since replaced by the app name per
  sidebar-title-band.md; welcome counts, picker and composer
  messages, overview, help). Command names, args and identifiers keep `repo`. GitHub's
  "repository" stays where it means the GitHub repository (Pull Requests page, reviewers).
* **Context menus** did not exist before. One Radix `ContextMenu` wraps the list
  (`modal={false}`); the right-clicked row is resolved from the event target, headers and
  empty space open nothing. Every item is a registry command with that row's context,
  except Rename (the inline editor, which commits `session.rename`) and Show worktree (a
  selection).
* **The tree's persisted collapse state is dropped** (`code-foundry.ui` version 3).

## Deviations from the handoff / brief

* **Pinning added** with a proto field, an RPC and migration 0009 (the brief allowed
  deferring it; it was small: the session store already persists every field the same
  way).
* **The daemon's command copy changed** (titles, the "Repository" palette category,
  confirm prompts), not only the GUI's. The CLI e2e matching `^Repository` now matches
  `^Project`.
* **`view.projects` is bound to cmd+shift+j** (P is the palette, D the Pull Requests
  page). The settings e2e that recorded cmd+shift+j as a user override now uses
  cmd+shift+y.
* **No `force` from the GUI.** Removing a dirty member, worktree or workspace from the
  Projects page is refused by the daemon (toast with git's reason); `--force` stays a CLI
  flag (`workspace remove-repo … --force`). Deferred: a "remove anyway" second confirm.
* **Thread order is creation time, newest first**; the handoff did not say. Ordering by
  last activity would reshuffle the list on every turn.

## Gotchas

* **Concurrent Playwright runs share `test-results/`.** The live run failed only in
  teardown ("ENOENT … .playwright-artifacts-0") while `make gui-e2e` was running in the
  same checkout; `--output <dir>` for the second run fixes it.
* **"Finished" after a move.** As step 2 noted, the `/cd` output counts as new work, so an
  unwatched thread that was Run in shows needs-attention afterwards: live, the moved thread
  went Needs attention → Threads (busy) → Needs attention.
* **Rename from the context menu**: Radix returns focus to the trigger on close, which
  would blur (and commit) the inline editor; the menu prevents that close focus while
  that row is renaming.
* **The mock's worktree removal was named `worktree.remove`**; the GUI now invokes the
  daemon's `repo.worktree.remove`, and the mock uses that name.
* A right-click on a thread does not select it (macOS sidebars do the same); it moves the
  keyboard cursor there.

## Live check (scratch daemon, 2026-10-09)

`CODE_FOUNDRY_HOME=/tmp/cf-ws4-12663/home`, two local-only scratch repos `web` and `api`
(one commit each) registered, `workspace new demo --repos web,api` (`cf/demo` in both),
daemon `--dev` from `make build`, Vite on 127.0.0.1:9347 pointed at it
(`VITE_DAEMON_URL`/`VITE_DAEMON_TOKEN`), `e2e/live-sidebar.spec.ts` in WebKit
(`LIVE_DAEMON=1 LIVE_WORKSPACE=demo LIVE_APP_URL=… pnpm exec playwright test -c
playwright.live.config.ts e2e/live-sidebar.spec.ts --output …`). The spec starts two
haiku threads with "say hi and stop" from the CLI: one in the workspace (`--workspace
demo --repo web`), one project thread in `api`'s main worktree.

1. **Flat list**: both threads listed (both under Needs attention once their unwatched
   turns finished), the workspace one with the `demo` badge and `web · cf/demo`, the
   project one with no badge and `api · main`; no repo or worktree rows. The daemon argv
   for the workspace thread had `--add-dir …/_local/api/cf-demo` and the appended prompt
   line; the project thread had neither.
2. **Projects page**: projects `api` and `web`, each with its main worktree and "1
   worktree is in workspaces (below)"; workspace `demo` on `cf/demo` with members `web`
   and `api` (`cf/demo` each).
3. **Run in… absent** in the project thread's row menu.
4. **Run in…** on the workspace thread → `api`: the row showed "moving to api…"; the
   daemon logged `typing /cd` then `thread moved to another workspace member` 0.4 s later;
   the row switched to `api · cf/demo` (badge kept) and `session list` showed the thread
   in `…/_local/api/cf-demo`, workspace unchanged.
5. Daemon log: no warnings or errors. Threads closed and removed, Vite and the daemon
   stopped, the scratch home and the four `~/.claude/projects/-private-tmp-cf-ws4-12663-*`
   directories removed. Trust entries for the scratch paths stay in `~/.claude.json`.

The first live run passed its steps but failed in teardown (the shared `test-results/`
gotcha above); its two threads were removed and the run repeated cleanly.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  714 vitest tests.
* `make gui-e2e`: 268 passed (WebKit + Chromium, 134 each), including the new
  `sidebar.spec.ts` (7 tests) and the existing specs, which now reach repos and worktrees
  through the Projects page (`selectWorktree` / `selectProject` in `e2e/fixtures.ts`). A
  first run had one WebKit failure in teardown only, caused by the concurrent live run
  sharing `test-results/` (gotcha above); the rerun alone was clean.
* `make gui-build` green.
* Go: `TestSessionCommands` rows for `session.pin` (toggle on, toggle off, explicit,
  unavailable) and `session.run-in` availability (GUI project thread unavailable, GUI
  workspace thread available, CLI unchanged); `TestViewCommandsEmitShowView` row for
  `view.projects`; `TestPinPersistsAcrossRestart` (store); Pin over the API in
  `TestSessionUnaryAndErrorCodes`; the CLI e2e's `commands --context-repo` row.
* Vitest: `lib/tree.test.ts` (sections and order, empty sections, owned terminals, leaf
  and attention order), `lib/threadRow.test.ts` (project/branch/badge/move table,
  helpers), `lib/projects.test.ts` (member worktrees only under their workspace, page
  order, addable projects, `repoRef`), `keys/bindings.test.ts` (the Run in presenter only
  for workspace threads; cmd+shift+a in sidebar order), context (`activeWorkspaceId` for a
  thread, its terminal, a workspace composer), ui persistence v3.

## Daemon restart

The installed daemon must be restarted (migration 0009, `SessionService.Pin`,
`UiContext.active_workspace_id`, `view.projects`, the new command copy). With an older
daemon the GUI still works: Pin fails with an unknown-command toast, `view.projects`'s
chord does nothing (the sidebar entry still opens the page), and the old `session.run-in`
availability lists it in the palette for every thread (the row menu shows it only on
workspace threads either way).
