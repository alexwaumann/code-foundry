# Workspaces step 3: the composer

Status: done on branch `cf/workspaces-composer`. `make check`, `make gui-e2e` (254/254)
and `make gui-build` green. Exercised against a scratch daemon with a real haiku thread
(below). Design record: `workspaces-handoff.md` (section 3, "Composer"); daemon side:
`workspaces-1-store.md`, `workspaces-2-launch.md`. Steps 4–5 (sidebar, projects page,
"Run in…" in the GUI, panel surface) are not started.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/events.proto` | `EVENT_SOURCE_WORKSPACE = 11`, `Event.workspace` (a `WorkspaceEvent`) |
| `internal/api/events.go` | `workspaceSource` (reuses `WorkspaceService`'s mapping); `EventsDeps.Workspace`; wired in `internal/daemon/daemon.go` |
| `internal/store/session/workspace.go` | `NewWorkspace.Repos` entries may be `<repo>:<base>` |
| `gui/frontend/src/api/workspace.ts` | `WorkspaceView`, `WorkspaceEventView` |
| `gui/frontend/src/stores/workspaces.ts` | the `workspaces` slice (by id, ordered by name), `useWorkspaceOrder`, `useWorkspace` |
| `gui/frontend/src/lib/compose.ts` | `ComposeTarget`, `draftKey`, `draftMembers`, `threadPlace`, `threadArgs` (pure, table-tested) |
| `gui/frontend/src/stores/compose.ts` | drafts keyed by project or workspace; `alsoIn`, `primary`; `setPrimary`, `addAlsoIn`, `removeAlsoIn`, `composeInWorkspace`, `sendDraft(target, …)` |
| `gui/frontend/src/components/compose/MemberChips.tsx` | member chips and the "Also in" picker |
| `gui/frontend/src/components/compose/{Composer,ProjectPicker}.tsx` | workspace targets, workspace rows above projects |
| `gui/frontend/mock` | workspaces in the events stream, `session.new --workspace / --repos`, `POST /__mock/workspace`, `GET /__mock/workspaces` |
| `gui/frontend/e2e/workspaces.spec.ts` | mock e2e; `e2e/live-workspace.spec.ts` (opt-in, real daemon) |

## Decisions

* **Event stream order**: the workspace snapshot is sent right after repo and before
  terminal (members name repositories; sessions name workspaces). The proto comment and
  the mock follow that order.
* **No new command.** `session.new` already carried everything (`workspace`, `repo`,
  `worktree`, `repos`, `new-worktree`, `base`, `prompt`, `attachments`, `permission`,
  `model`, `effort`). The one extension is an arg value: `repos` accepts `<repo>:<base>`
  per entry, like `workspace new --repos`, so the composer can branch the primary project
  from the base the user picked while the other projects use their own defaults (a single
  `base` for every member would fail as soon as one repo lacks the ref, e.g.
  `origin/release/x`, or a local-only repo's `main`). The thread's `base_ref` is its own
  member's base.
* **What the composer sends** (`lib/compose.ts` `threadArgs`):
  * a project alone: exactly as before (`repo`, `worktree` or `new-worktree` + `base`).
    e2e asserts the identical args with workspaces present;
  * a workspace, "Workspace worktrees": `workspace`, `repo` (the primary) and `worktree`
    (its member path). `repo` is always explicit because the daemon fills a missing
    `repo` from the context's active repo;
  * a project with "Also in", or a workspace in "New worktree" mode: `new-worktree`,
    `repos` in member order, `repo` the primary; `base` only as `<primary>:<base>` and
    only when the user picked one (else each project's default).
* **Picker**: a "Workspaces" group above "Projects" (heading "New thread in…" stays when
  there are no workspaces). Rows: name, then `branch · member project names`. cmd+1..9
  still pick projects by position (workspaces have no number), so muscle memory and the
  existing tests are unchanged. The active thread's workspace is highlighted first, else
  the active project.
* **Draft keys**: a project's draft is keyed by its repo id (unchanged), a workspace's by
  `ws:<id>`. The compose selection gains `workspaceId`; its `repoId` is then the first
  member at open time, used only for the command context. A workspace composer has no
  sidebar row selected (workspaces are not in the tree until step 4).
* **Member chips** sit between the heading and the card: name, branch (the member
  worktree's checked-out branch, or `cf/…` when the thread gets new worktrees), and a
  `primary` tag on the member the thread runs in (its cwd). Clicking another chip makes
  it primary (`aria-pressed`). Changing the primary resets the base choice, because the
  base picker lists the primary repo's refs. Chips are simple buttons outside the TipTap
  editor; they are composer Tab stops before the prompt, so Tab from the prompt still goes
  model → … → send, and Shift+Tab reaches the chips.
* **Projects**: only an "Also in…" pill until another project is added (no chips for a
  single project). Added projects get a remove ×; the project itself cannot be removed.
  With any "Also in" project the worktree picker offers only "New worktree" (the stored
  existing-worktree choice comes back when the last one is removed).
* **Workspaces**: members are fixed in the composer (no add/remove; editing members is
  the step-5 surface). Worktree picker: "Workspace worktrees" (default; the base slot shows
  the primary member's branch read-only) or "New worktree" (a new workspace with the same
  projects, cf/<slug> in each after the single slug wait).
* **Copy**: "project" and "workspace" throughout ("Also in…", "Add project", "Filter
  projects…", "Workspace worktrees", "A cf/… branch in every project (a new workspace)",
  "Creating worktrees…", "This workspace no longer exists.").
* `SessionView.workspaceId` is mapped now (the owner); nothing renders it yet (step 4).

## Gotchas

* `ComposerPicker`'s filter used to survive a close: reopening "Also in" right after
  picking showed the list still filtered by the last query. The filter is now controlled
  and cleared on every opening (base picker too).
* The mock's `sessionSummary` (`GET /__mock/sessions`) now includes `repoId`,
  `worktreePath` and `workspaceId`.
* There is no input tool for native windows in this environment, and synthetic
  keystrokes would have gone to whatever app was frontmost on Alex's desktop, so the
  native Wails window was launched and checked but not driven (see below).

## Live check (scratch daemon, 2026-10-09)

`CODE_FOUNDRY_HOME=/tmp/cf-ws3-14297/home`, two local-only scratch repos `web` and `api`
(one commit each), `workspace new demo --repos web,api`.

1. **Native GUI**: `CODE_FOUNDRY_HOME=… "gui/bin/Code Foundry"` (from `make gui-build`)
   started, found the scratch daemon, and opened `EventService/Watch` plus the List calls
   from origin `wails://localhost` (daemon log); a screen capture showed the window with
   `api`/`web` and their `cf/demo` worktrees. It was not driven (see the gotcha above).
2. **Composer, real frontend + real daemon**: the Vite dev server pointed at the scratch
   daemon (`VITE_DAEMON_URL`/`VITE_DAEMON_TOKEN`, the phase2-integration recipe) and
   `e2e/live-workspace.spec.ts` in WebKit: cmd+N → the `demo` row → chips `web cf/demo`
   (primary) and `api cf/demo` → made `api` primary → Haiku 5.5, Medium → "say hi and
   stop" → Enter. Result:
   * session row `s-abb5f92529b1`: `repo_id` = api, `workspace_id` = `w-aff24b9d79d3`,
     `worktree_path` = the api member (`session list` WORKSPACE column and the SQLite row);
   * daemon argv: `claude … --model haiku --effort medium --permission-mode auto --add-dir
     …/attachments --add-dir …/_local/web/cf-demo --append-system-prompt This thread
     belongs to workspace demo. … -- say hi and stop`, cwd `…/_local/api/cf-demo`;
   * transcript: "Hi! Stopping here as requested."; the thread was named in the background
     and closed by the spec.
3. **Per-member base (CLI)**: `session new --new-worktree --repos web:main,api --repo web
   --model haiku` made workspace `greeting-response-task` with `cf/greeting-response-task`
   in both repos, the thread in the web member "from main".
4. Daemon log: no warnings or errors. Threads closed, daemon and Vite stopped, the scratch
   home and the scratch `~/.claude/projects` dirs removed.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  698 vitest tests (no flake on this run).
* `make gui-e2e`: 254 passed (WebKit + Chromium), including the existing compose spec
  unchanged and `workspaces.spec.ts`: pick a workspace and send (chips, primary change by
  keyboard, args, session owner); a workspace in new-worktree mode; pick a project, add
  and remove "Also in", primary-dependent base, send (args with `repo:base`, the mock's
  new workspace and thread owner, the picker listing it); a single-project thread with
  workspaces around (identical args, no owner); a workspace removed under its composer.
* Go tests: `TestEventsSnapshotOrderThenLive` (workspace snapshot after repo, live
  updated/removed), `TestEventsSourceFilter` (workspace only), `TestCreateNewWorkspace`
  rows for per-member bases and a bad member base.
* `make gui-build` green.

## Daemon restart

The installed daemon must be restarted for the GUI to receive workspaces (new event
source) and for `--repos repo:base`. An older daemon simply sends no workspace events:
the picker shows projects only and everything else works.
