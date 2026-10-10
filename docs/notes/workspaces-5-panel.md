# Workspaces step 5: the side panel's workspace surface

Status: done on branch `cf/workspaces-panel` (stacked on `cf/workspaces-sidebar`). This
is the last step of `workspaces-handoff.md` (section 3, "Right panel workspace surface").
`make check`, `make gui-e2e` and `make gui-build` green; exercised against a scratch
daemon with a real haiku thread (below). Earlier steps: `workspaces-1-store.md` …
`workspaces-4-sidebar.md`; the panel and its registry: `side-panel.md`.

## What landed

| Path | What |
|---|---|
| `internal/command/commands_view.go` | `view.panel.workspace` ("Show Workspace in Side Panel", View, no chord), emits `ShowView{"panel.workspace"}`; `When` = a thread and `ActiveWorkspaceID` |
| `gui/frontend/src/surfaces/workspace.ts` | The Workspace surface spec: hotkey W, `enabled` for a workspace thread (or its terminal), `hidden` otherwise |
| `gui/frontend/src/surfaces/worktree.ts` | The Worktree surface spec (member tabs): no hotkey, always `hidden` in the empty list |
| `gui/frontend/src/surfaces/workspaceTarget.ts` | Pure: `selectionWorkspaceThread` (availability), `workspaceTab` / `memberTab` and their parsers, `liveWorkspaceThread` (Projects page) |
| `gui/frontend/src/surfaces/types.ts`, `registry.ts`, `components/panel/SidePanel.tsx` | `SurfaceSpec.hotkey` is optional (no chip, no letter) |
| `gui/frontend/src/components/workspace/WorkspaceSurface.tsx` | Header (name, member count, branch) and the member list as a keyboard listbox |
| `gui/frontend/src/components/projects/WorkspaceMembers.tsx` | `layout="panel"` (two-line rows), `threadId` (current/queued marker, Run in), `onOpen` (open as a tab) |
| `gui/frontend/src/lib/projects.ts` | `threadAt`: a member's marker for a thread (pure) |
| `gui/frontend/src/components/overview/WorktreeOverview.tsx` | `WorktreePanelView` (the member tab body) and an `inPanel` mode of the overview body; container-query narrowing |
| `gui/frontend/src/stores/workspacePanel.ts` | `openWorkspaceSurface`, `showWorkspaceInThread`, `openMemberTab` |
| `gui/frontend/src/stores/views.ts`, `keys/bindings.ts` | `workspacePanelCommand`, `showView("panel.workspace")`, the local presenter |
| `gui/frontend/src/components/sidebar/SidebarRow.tsx` | The workspace badge opens the surface |
| `gui/frontend/src/components/terminal/TerminalPane.tsx` | A Layers header button (`CommandButton` for `view.panel.workspace`) |
| `gui/frontend/src/components/projects/ProjectsPage.tsx` | "Show in <thread>'s side panel" on a workspace row with a live thread |
| `gui/frontend/mock` | `view.panel.workspace`; `POST /__mock/workspace-mixed?name=…` (members with an open PR failing CI, 2 ahead, dirty) |
| `gui/frontend/e2e/workspace-panel.spec.ts`, `e2e/live-wspanel.spec.ts` | mock e2e (6 tests per engine); opt-in live e2e |

## Decisions

* **Two surfaces, both one file each.** `workspace` is the member list; `worktree` is
  a member's worktree overview as a tab. A member tab is its own surface kind (not a
  param of the workspace tab) so each member is its own tab, closable and keyed by
  `repo` + `path` like PR tabs are by `slug` + `number`. The worktree surface is never
  listed in the empty panel and has no hotkey; `SurfaceSpec.hotkey` became optional for
  it (the registry skips it in the letter map, the empty list draws no chip).
* **Availability = a workspace thread**: the selection's `deriveContext` has an
  `activeSessionId` and an `activeWorkspaceId`, i.e. a session or a thread's terminal
  owned by a workspace. Everything else is `hidden` (not dimmed): a project thread,
  a worktree, a page, a workspace composer (no thread yet). The Go command's `When` is
  the same rule (`hasSession && ActiveWorkspaceID != ""`); from the CLI it needs
  `--context-session` and `--context-workspace`, and the GUI window acts on its own
  selection (a window with no workspace thread selected ignores the ShowView).
* **Tab params.** Workspace tab `workspace?workspace=<id>`, titled with the workspace
  name; member tab `worktree?path=…&repo=…`, titled with the project name (every member
  is on the same branch, so the project is the distinguishing part).
* **The current member** is the thread's cwd (exact, or inside the member), marked
  "here" (emerald chip, `data-current`); a queued Run in target is marked "queued"
  (amber) until the move lands. The surface finds its thread from the selection (a
  panel always shows the current selection's panel), not from tab params, so a tab
  restored from storage still follows its thread.
* **Member rows (panel layout).** Two lines, 48px: project, marker and the hover
  actions (open as tab, Run in on non-current members, new terminal, remove), then the
  shared `WorktreeState` without the path (branch, dirty count, ↑/↓, the branch's PR
  number with its CI icon). Same component as the Projects page, so no new polling: git
  state comes from the repos slice, PR/CI from `branchPullRequestsResource` (which keeps
  the daemon polling the branch while shown). Nothing needed a new RPC or poller.
* **Run in reuses `session.run-in`** (`runSessionIn`, as the row menu and palette
  picker do) with the thread's context. **Remove** is `workspace.remove-repo` with the
  daemon's confirm prompt; a member a live thread runs in is refused by the daemon (toast
  names the thread). **Add** is step 4's "Add project" picker.
* **`view.panel.workspace`** opens (or activates) the workspace tab in the current
  selection's panel, shows the panel and focuses it (from the palette: the palette's
  return target becomes the panel), like `view.panel.toggle`. No default chord: the other
  panel commands besides the toggle have none either, and W opens it while the panel has
  focus. Its GUI presenter runs locally (no round trip); the CLI reaches windows through
  `ShowView`.
* **Entry points.** The PR surface has no header affordance of its own (it is opened by
  clicking PR rows), so the workspace's mirror that: clicking the sidebar's workspace
  badge opens the surface in that thread's panel (the click then selects the row as
  before), and the thread header has a Layers button for the command, listed only on
  workspace threads. The Projects page's workspace row gets a panel button only while a
  thread of that workspace is connected (`liveWorkspaceThread`: the most recently active,
  else the newest); it selects that thread and opens the surface there. Without one the
  row is exactly as step 4 built it.
* **Member tab = the worktree overview's body** (`WorktreePanelView`): a compact header
  (project@branch, path), then sync line, GitHub activity, files and log. Left out: the
  threads/terminals section, because its "New thread"/"New terminal" buttons act on the
  selection, which is the thread, not that worktree. In the panel the body does not grab
  focus on mount and is not the content pane's focus root.
* **280px.** The surface root and the member tab are CSS containers. Overview rows narrow
  by container query below 420px: the log drops its author column, PR rows drop state,
  author, head → base and the review badge, check rows drop the conclusion, and section
  headers and the default-branch CI line wrap. The page (no container) is unchanged.
* **Long lists** virtualize through `RowList` (over 60 members), as on the Projects page.

## Deviations from the handoff / brief

* **No new daemon data.** Everything the brief listed (branch, dirty, ahead/behind, PR,
  CI) was already in the repos slice and the branch-PR resource.
* **Hidden, not disabled, for non-workspace selections** (the brief said "absent"); the
  PR surface uses disabled because its availability flips with a branch.
* **Projects page**: the brief allowed opening the surface "for a thread only when one is
  active in that workspace"; "active" is read as connected (not disconnected).
* **Member tabs omit the overview's threads/terminals section** (above).

## Gotchas

* The overview body's `NavProvider` and listbox work inside the panel unchanged: its
  own keys (j/k, Enter, e/E) are handled before the aside's panel keys. A bare W in the
  member tab opens the workspace tab (it is the panel's letter), like P anywhere.
* `ahead` is relative to the upstream. A workspace branch created from `origin/main`
  has none (`--no-track`, `workspaces-2-launch.md`), so a fresh member shows no ↑ even
  after a commit; the live run pushed `cf/demo` with `-u` before committing.
* In the live spec the wait for `IDLE|NEEDS_ATTENTION` matches the thread's pre-turn
  idle, so the surface checks ran while haiku's turn was in flight (the turn finished:
  "Hi! Stopping here as requested."). The surface does not depend on it.
* The session header got one more button; with the panel open at 1200px the header
  title truncates earlier ("dri…" / "s…"), as it already did with long names.

## Live check (scratch daemon, 2026-10-09)

`CODE_FOUNDRY_HOME=/tmp/cf-ws5-8985/home`, three local scratch repos `web`, `api`, `lib`
(one commit each, each with a bare `origin` pushed), registered; `workspace new demo
--repos web,api`; in `web`'s member `git push -u origin cf/demo` and one more commit
("ahead commit", ahead 1); in `api`'s member an untracked file. Daemon `--dev` from
`make build`, Vite on 127.0.0.1:9357 pointed at it, `e2e/live-wspanel.spec.ts` in WebKit
(`LIVE_DAEMON=1 LIVE_WORKSPACE=demo LIVE_ADD_REPO=lib LIVE_APP_URL=… pnpm exec
playwright test -c playwright.live.config.ts e2e/live-wspanel.spec.ts --output …`).
The spec started one haiku thread ("say hi and stop") in `web`'s member.

1. **Badge → surface**: the panel opened for `session:<thread>` with tab `demo`: header
   `demo`, `cf/demo`, 2 members; `web` with ↑1, no dirty, marked "here"; `api` dirty
   (1), no ↑, not marked. The daemon argv had `--add-dir …/_local/api/cf-demo` and the
   workspace prompt line.
2. **Member tab**: `web` opened as a second tab: `web@cf/demo`, "Upstream
   origin/cf/demo: ↑1", files `A ahead.txt`, log "ahead commit".
3. **Add/remove**: "Add project" → `lib` added (daemon created
   `…/_local/lib/cf-demo`; `workspace members` listed three); remove `lib` → the
   daemon's "Remove project lib from its workspace?" → OK → two members again in the
   surface and in `workspace members`.
4. No warnings or errors in the daemon log. Thread closed, Vite and the daemon stopped,
   the scratch directory and its two `~/.claude/projects/-private-tmp-cf-ws5-8985-*`
   directories removed. Screenshots: `/tmp/cf-shots/live-wspanel-{surface,member-tab,added}.png`
   (mock ones: `/tmp/cf-shots/ws5-*.png`).

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck,
  lint, 746 vitest tests (52 files).
* `make gui-e2e`: 280 passed (WebKit + Chromium, 140 each), including the new
  `workspace-panel.spec.ts` (6 tests per engine) and every existing spec unchanged.
* `make gui-build` green.
* Go: `TestViewCommandsEmitShowView` row for `view.panel.workspace`;
  `TestViewPanelWorkspaceAvailability` (workspace thread, its terminal, project thread,
  workspace composer, nothing, CLI with and without context); the registered-command
  list in `TestAllRegistersEveryDomain`.
* Vitest: `surfaces/workspaceTarget.test.ts` (availability table over selection kinds,
  tab ids and params, `liveWorkspaceThread`), `lib/projects.test.ts` (`threadAt`),
  `surfaces/workspace.test.tsx` (listed with W for a workspace thread, absent for a project
  thread and following ownership, W opens it with the current member marked and Run in
  only on others, a member opens as a worktree tab, `workspacePanelCommand` incl. the
  settings and project-thread no-ops and the palette return target),
  `components/panel/keys.test.ts` (registry with the optional hotkey).
* Playwright (`e2e/workspace-panel.spec.ts`, WebKit + Chromium): badge opens it with the
  mixed member state and the current member; palette, header button, W and the CLI's
  ShowView on a workspace thread, none of them on a project thread; member tab shows the
  worktree overview (button and Enter); remove confirms and applies, removing the
  thread's member is refused, add and Run in go through their commands (the marker
  follows the move); 280px without horizontal overflow for the surface and a member
  tab; the Projects page button only with a live thread.

## Daemon restart

The installed daemon must be restarted for `view.panel.workspace` (palette entry, header
button, CLI verb). With an older daemon the surface still works from the workspace badge,
W in the panel and the Projects page; the header button and palette entry are absent.
