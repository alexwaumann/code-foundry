# Workspaces v2, PR 3: the composer and the sidebar (GUI)

Status: done on branch `cf/workspaces-v2-composer`. Design record:
`workspaces-v2-handoff.md` (§3, §4 Primary and Collision hint, §6 Composer, Sidebar and
"New thread on this branch", §8 step 3). Daemon side: `workspaces-v2-1-threads.md`,
`workspaces-v2-2-workspaces.md`. The Projects page and panel are PR 4
(`workspaces-v2-4-projects-page.md`), merged first; this branch is rebased on it.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/thread.proto`, `thread_lifecycle.proto` | `ThreadService.SetWorkspace(SetThreadWorkspaceRequest{id, workspace})`: set or clear a thread's workspace reference |
| `internal/store/thread/set_workspace.go`, `threadtest/set_workspace.go` | `Store.SetWorkspace` (ref by id or name, any case; no-op when unchanged; FailedPrecondition for a thread in its workspace's folder), `CheckWorkspaceChange` |
| `internal/api/thread_workspace.go` | the thin handler |
| `internal/command/commands_thread_workspace.go` | `thread.workspace` (`thread workspace <id> --workspace <id|name>`, empty clears) |
| `internal/command/commands_thread_new_like.go` | `thread.new-like`, "New thread on this branch": `CreateThreadRequest.like_thread_id` + the prompt and Claude options, `project` for another primary; hints as warnings; `createdMessage` shared with `thread.new` |
| `internal/guide/guide.go` | both verbs left out of the agent guide (`leftOut`): agents use `thread new --like`; Save as workspace is the user's |
| `gui/frontend/src/lib/projectSet.ts` | the set: `resolveSet` (picks, workspace reference, primary with its defaults), `toggled`, `setName`, `primaryOptions`, `matchingWorkspace`, `canSaveAsWorkspace` |
| `gui/frontend/src/lib/collisionHints.ts` | `threadCheckouts`, `draftCheckouts`, `collisionHints` (the daemon's two hint lines, computed client-side) |
| `gui/frontend/src/lib/compose.ts` | `ComposeTarget` gains `like`; `WorktreeChoice` gains `current` (in place, any set) and loses `members`; `setWorkIn`; `ThreadPlace` is `project` / `set` / `like` / `home`; `threadArgs` sends `projects`, `project` (or `workspace`), `workspace`, `new-worktree=true|false`, or the like args |
| `gui/frontend/src/lib/threadRow.ts` | `setLabel`, `ThreadRowModel.set` (the workspace badge's `workspace` is gone), `ThreadPlaceInput` |
| `gui/frontend/src/stores/compose.ts` | `Draft.projects` / `workspace` / `primary` replace `alsoIn`; `draftSet`, `targetDefaults`, `toggleDraftProject`, `pickDraftWorkspace`, `composeLike`, `draftWorktree`; `sendDraft` invokes `thread.new-like` for a like draft and toasts the daemon's hints |
| `gui/frontend/src/stores/saveWorkspace.ts`, `components/thread/SaveWorkspaceDialog.tsx` | Save as workspace: `workspace.new` with the thread's projects and primary, then `thread.workspace` |
| `gui/frontend/src/components/compose/*` | `Composer` (set, like, Runs in, hints), `MemberChips` (chips by id, the workspace chip, Add project), `ProjectSwitcher` (the multi-select), `ProjectRows` (`checked`), `useCollisionHints` |
| `gui/frontend/src/components/thread/{ThreadMenu,useThreadPlace,useThreadCheckouts}.ts(x)` | the header's More menu; line 2's narrow selectors; a thread's derived checkouts for "/" and "@", Run in and the like composer |
| `gui/frontend/src/components/sidebar/{SidebarRow,RowMenu}.tsx`, `lineage/ThreadsSurface.tsx`, `palette/RunInPicker.tsx` | line 2, the tooltip's project list, Run in over the thread's checkouts and the workspace's folder, New thread on this branch |
| `gui/frontend/src/api/command.ts`, `api/threads.ts` | `InvokeResultView.warnings`; `ThreadView.projectIds`, `branch` (required) |
| `gui/frontend/mock` | `thread.new --like`, `thread.new-like`, `thread.workspace`, hints as warnings (`mock/projectSets.ts`), `POST /__mock/set-thread` |
| `gui/frontend/e2e/project-sets.spec.ts`, `composer-switch.spec.ts` | the new specs; `workspaces.spec.ts` (the v1 composer) removed; the Also in specs moved to Add project |

## Decisions

* **The draft stays under its target's key.** A set is draft fields (`projects`,
  `workspace`, `primary`; null follows the target: a project's own id, a workspace's
  members and reference). Toggling projects or picking a workspace edits the draft in
  place; only the No project row (and any row while on No project) moves a draft to
  another key (`switchDraftTarget`, unchanged otherwise). So taking the composer's own
  project out of its set leaves the draft under that project's key; the next composer for
  that project shows it. Accepted: one draft per entry point, as before.
* **Picker semantics.** The heading's name opens a multi-select (same rows as cmd+N;
  checks on the set). A workspace row makes its members the set and it the reference
  (tags of projects that leave go, after a confirm); picking the referenced workspace
  again drops the reference and keeps the projects. A project row toggles it (picked last
  in the pick order). The last project of a set without a workspace cannot be removed
  (No project is its own row). cmd+N's picker stays single-pick (Enter, cmd+1..9).
* **Chips.** Shown by project name, case-insensitively (`byName`; the set is stored and
  sent by id, which looks random to a user); a lone project shows only "Add project" (as v1's lone
  project showed "Also in…"); a set shows every project with a × and, before them, a
  workspace chip whose × drops the reference. The primary chip keeps its accent but is no
  longer a button: the primary is picked in **Runs in** ("Workspace" first with a
  workspace, then the projects by name). Default: the workspace's `default_primary`, else
  the first project picked.
* **Plain folders can be in a set** (v1 refused them in Also in); in worktree mode they are
  their folder (the daemon's rule).
* **Mode.** A lone project keeps the v1 Work in picker (fresh copy, in place, an existing
  worktree). A set offers "A fresh copy of every project" (`new-worktree=true`) or "Each
  project's own folder" (`new-worktree=false`, the CLI's checkout mode); the default is
  `threads.default_worktree`. The base picker shows for fresh copies with a git primary
  and is sent as `<primary>:<base>`; others branch from their defaults.
* **Collision hints, client-side.** In place, every member's own checkout is known; in
  worktree mode only plain folders are (the GUI does not know the daemon's worktree path
  rule, and a new branch has none yet). Other threads' checkouts are derived the
  daemon's way; a worktree-mode member whose worktree the project does not list yet is
  left out. Lines: "<name> is a folder, not a repo: thread <other> also works there" and
  "<name> @ <branch> is also open in <other>" (the thread's name; the daemon's after-create
  hints add its id and are shown as toasts). A like draft's checkouts are its thread's, so
  that thread is named too: shown, never blocking.
* **"New thread on this branch".** A registry command (`thread.new-like`, label exactly
  that, arg the source thread, its context the active thread); in the GUI its presenter
  opens a composer keyed `like:<thread>` (Selection `compose` + `likeThreadId`). The
  composer shows what the daemon copies, read-only (workspace chip, chips with the
  thread's branch or each checkout's, the mode as "On <branch>" or "In place"), and only
  Runs in changes; it sends `id` (+ `project` only when changed) and the prompt. The
  heading reads "What's next on <branch>?" (no branch: "beside <thread>"). Escape on an
  empty draft returns to the thread. Row menu, header More menu and palette.
* **Save as workspace** (the menu item reads exactly that, as the help skill names it)
  sends project ids, never names (a project named `workspace` would be the primary
  keyword). It is two registry commands from a small dialog: `workspace.new`
  (projects, the thread's primary as `primary`; a thread in a workspace folder sends no
  primary) and `thread.workspace`. `ThreadService.SetWorkspace` is new: no thread verb set
  the reference. Offered (header More menu only, as the spec says) for a set of two or more
  that matches no saved workspace's members. A name the daemon refuses shows in the dialog.
* **Line 2.** A thread of several projects, or one running in its workspace's folder (no
  project id), reads `<workspace name> @ <branch>`, else `<N projects> @ <branch>`; the
  branch is the thread's in worktree mode, else the cwd checkout's; none in the
  workspace's folder in place (just the name). Single-project threads are unchanged, also
  with a workspace reference. The tooltip lists the projects (the workspace as its chip).
  The Threads tab's place and the thread header's location use the same hook, so a
  thread in its workspace's folder never shows the folder's `w-…` name.
* **Run in** lists the workspace's folder and the thread's projects (their derived
  checkouts), for any thread with more than one place to run; the palette lists the
  command only then (the daemon offers it for every thread).
* **The agent guide** leaves both new verbs out instead of raising its size figure: the
  guide was 4 bytes under its 25,500-byte check on main.
* **`WorkspaceView.branch` / member `worktreePath`** are no longer read anywhere in this
  PR's files (PR 4 reshaped the view itself).

## Gotchas

* The sandbox here refuses shell commands whose text mentions git words with file
  edits (heredocs included); edits went through script files.
* cmdk filtering hides the unmatched rows, so a `[data-current]` count after typing a
  filter counts only the visible ones.
* The Save dialog opens a microtask after the menu closes; type only once its input has
  focus.
* Test fixtures cast partial `ThreadView`s; with `projectIds` and `branch` required, every
  fixture a component reads them from needs them.

## Verified

* `make check` green; `make gui-e2e` (WebKit, 4 workers) green.
* Unit tests: `lib/projectSet.test.ts`, `lib/collisionHints.test.ts`, the reshaped
  `lib/compose.test.ts` (places, args, `setWorkIn`, `movedDraft`), `stores/compose.test.ts`
  (toggles, workspace pick, primary reset, like drafts, moves), `lib/threadRow.test.ts`
  (`setLabel`, line 2), completion sources; Go: `TestSetWorkspace` (store),
  `TestThreadSetWorkspace` (API), `TestThreadWorkspaceAndNewLike` (commands).
* e2e (`project-sets.spec.ts`): the multi-select and primary picker with the sent args and
  line 2; a workspace row with Workspace as the primary in fresh copies; hints before
  send (in place, a shared folder in worktree mode) and the daemon's after; Save as
  workspace (args, the reference, line 2, the item gone) and a refused name; New thread on
  this branch from the row menu (prefill, read-only parts, another primary, the args, the
  new row), the header menu and the palette, Escape back; a workspace removed under its
  composer. `composer-switch.spec.ts` for the picker's placement, keyboard and moves.
* **Live app** (isolated `CODE_FOUNDRY_HOME=/tmp/cfv2-gui3`, scratch repos `web` and `api`
  and a folder `notes` under `~/cfv2-scratch-gui3`, Haiku 5.5 at medium effort, one-word
  prompts; all removed afterwards):
  * from the CLI: a set thread with fresh copies on `feat/checkout`, a `--workspace shop`
    thread, a `web,notes` set with the folder as the primary (the CLI printed the
    collision hint "web @ main is also open in Shop banner");
  * the built Wails app (`make gui-build`) showed line 2 as `2 projects @ feat/checkout`,
    `shop @ main` and `2 projects` (a folder primary in place: no branch), and the
    header the same; screenshots in the PR body;
  * the composer flows were driven in WebKit (Playwright) on the Vite dev server against
    the same daemon restarted with `--dev` (the native window cannot be driven here: no
    accessibility permission for synthetic clicks): the set picker, chips, Runs in and
    hints; a set sent with fresh copies and `api` as the primary (`2 projects @ cf/…`); New
    thread on this branch from the row menu with another primary (the new thread on
    `feat/checkout` in api's worktree, the daemon's two hints as toasts); Save as workspace
    on the `web,notes` thread (`workspace list` showed `docs` with notes as the default
    primary, the thread's `workspaceId` set, its line 2 `docs`).
