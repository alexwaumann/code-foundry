# Workspaces v2, PR 4: the Projects page's workspace cards and the panel

Status: done on branch `cf/workspaces-v2-projects-page`, after PR 2
(`workspaces-v2-2-workspaces.md`), parallel with PR 3 (composer and sidebar, branch
`cf/workspaces-v2-composer`). Design record: `workspaces-v2-handoff.md` (§3 Workspace, §6
Projects page and Panel, §8 step 4).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/workspace.proto` | `Workspace.instructions` (10: the CLAUDE.md, else AGENTS.md, a rooted workspace's under its root) and `Workspace.skills` (11) |
| `internal/store/workspace/contents.go`, `store.go` | the managed dir's contents read at every commit and every `EnsureDirs`; `Updated` only when they changed; never persisted |
| `internal/daemon/workspace_contents.go` | `EnsureDirs` for a thread's workspace when the thread ends a turn |
| `internal/command/commands_workspace_reveal.go` | `workspace.reveal`; `workspace.remove`'s confirm by kind (DynamicConfirm) |
| `internal/command/commands_view*.go` | `view.panel.workspace` removed (and its `inWorkspace` check, tests, the capabilities count) |
| `gui/frontend/src/components/projects/WorkspaceCard.tsx`, `NewWorkspaceDialog.tsx`, `CollapseToggle.tsx` | the cards, the New workspace dialog, the chevron shared with project blocks |
| `gui/frontend/src/lib/workspaceCard.ts` | pure: folder, instructions file and target, the Edit instructions prompt and steer rule, addable projects, name check, summary |
| `gui/frontend/src/stores/workspaceActions.ts` | rename, set primary, add/remove project, remove, reveal, open the instructions, Edit instructions, create; the dialog's store |
| `gui/frontend/src/api/checkouts.ts`, `lib/alsoIn.ts`, `stores/threadCheckouts.ts`, `components/overview/AlsoIn.tsx` | `ThreadService.Checkouts` mapped; the Also in rows, key and resource; the list under the Worktree tab's facts |
| `gui/frontend/src/lib/projects.ts`, `ProjectsPage.tsx`, `useCleanable.ts` | every worktree under its project; no member rows, notes or holds |
| `gui/frontend/src/surfaces/worktreeTarget.ts` | was `workspaceTarget.ts`: the worktree half only |
| removed | `surfaces/workspace.ts`, `components/workspace/WorkspaceSurface.tsx`, `stores/workspacePanel.ts`, `components/projects/WorkspaceMembers.tsx`, `e2e/workspace-panel.spec.ts`, `e2e/live-wspanel.spec.ts` |
| `gui/frontend/mock` | workspaces in the v2 shape with instructions and skills, the workspace verbs, `ThreadService.Checkouts`, v2 `thread.new --workspace/--projects`, Run in over checkouts; controls `workspace-files`, `multi-thread`, `thread/project-ids`, `worktree/dirty` |
| `gui/frontend/e2e/workspace-cards.spec.ts` | the cards (contents, rename, set primary, add/remove, remove confirm, New workspace, instructions, Edit instructions, Reveal) and Also in |

## Decisions

* **The daemon read: fields on Workspace, not a listing RPC.** `FilesystemService.ListSkills`
  takes project checkouts only, `ReadFile` reads one file and refuses anything outside the
  home directory, and the config home (where managed dirs live) need not be under it. So
  the workspace store reads its managed dir itself: `instructions` is the path of
  `CLAUDE.md`, else `AGENTS.md` (through the link, so a rooted workspace reports the real
  file under its root, which the File tab can open), `skills` the folders of
  `.claude/skills` that hold a `SKILL.md`, sorted. Read at every commit and every
  `EnsureDirs` (start, Create, every spawn of a referencing thread) and published only when
  they changed.
* **Freshness without polling.** The files are written by a thread's tools mid-turn, after
  its spawn's `EnsureDirs`; the daemon glue (`workspace_contents.go`) calls `EnsureDirs`
  for a thread's workspace when it ends a turn. A file written by anything else shows at
  the next spawn or daemon start. No watcher, no timer.
* **`workspace.reveal`** is a new verb: `worktree.reveal` resolves registered worktrees
  only. It shows the root, else the managed dir, through the same `RevealFunc` as
  `settings.reveal`.
* **Remove's confirm says what goes** (DynamicConfirm): a synthetic workspace "Its
  instructions and skills are deleted too.", a rooted one "Its root folder … and everything
  in it stay; only the workspace and its links go." The static Confirm stays the fallback.
* **New workspace sits in the Workspaces title**, not the page header: with the side panel
  open the header had no room for it (the filter and counts were squeezed).
* **The card.** Header: chevron (collapses like a project, the same persisted set), the
  name (double-click, or Rename… in the menu, edits it in place: Enter renames, Escape or a
  refused name keeps the old one; taken names and "workspace" are caught before the
  daemon), the root path when rooted, New thread (the composer, `composeInWorkspace`),
  Reveal in Finder, Remove. Body: a "Workspace folder" row (where a thread whose primary is
  the workspace runs: its root, or the folder the app keeps) and one row per project by id,
  the default primary marked "starts here", a star on the others sets it
  (`workspace.set-primary`, the folder as `workspace`); remove a project with its ×
  (nothing on disk changes, so no confirm); Add project (the composer's picker, every
  registered project not yet in it, plain folders included since v2 allows them);
  Instructions (the file's name, a click opens it as a File tab in the page's panel, or
  "none yet") with Edit instructions; Skills by name, or "none yet". Keyboard: the header
  row's Enter opens the composer as before, a project row's shows that project's main
  worktree in the page's panel.
* **Edit instructions: steer, else start.** The rule: the user's most recent thread (not
  one another thread created) that references the workspace, runs in its folder (root or
  managed dir, where Claude Code loads the files natively) and is not archived gets the
  prompt as a `thread.send` and is selected; otherwise `thread.new --workspace <id>
  --project workspace --new-worktree=false` starts one there (members in their own
  checkouts: editing instructions needs no worktrees), which the daemon focuses. No "busy"
  check: a send to a running thread queues as a steer. The prompt names the file (or where
  `CLAUDE.md` goes), says the instructions reach every thread in the workspace, and where
  skills go; the thread asks what to change before changing anything. `thread.new` is
  invoked with the composer's context (`activeView: compose`): its availability refuses
  the Projects page's context without a project, and a workspace may have none.
* **New workspace** is a shadcn dialog, also `workspace.new`'s palette presenter: a name and
  a checkbox list of the registered projects (at least one). They are sent in the page's
  order (by name); the daemon makes the first the default primary. No root folder here
  (that is PR 6's Add Project scan).
* **Worktrees show only under their projects.** `projectsModel` no longer excludes member
  worktrees ("N worktrees are in workspaces" and the collapsed "· 1 in a workspace" are
  gone); the filter matches a workspace by name only (it has no branch).
* **Also in.** Under the Worktree tab's facts, when the panel belongs to a thread (the
  selection) whose checkouts include the tab's path and number two or more: one row per
  other checkout (project, branch, a changed-files count when dirty, "made at the next
  start" for a worktree not made yet), a click or Enter opening it as its own Worktree tab
  in the same panel. One `ThreadService.Checkouts` read per visible tab
  (`checkoutsResource`, abort on release), keyed by the thread id, cwd, branch, project set
  and the members' worktree paths, so a change to any of them (a worktree made or removed
  included) is a new read and nothing polls; a single-project thread makes no read. Branch
  and dirtiness come live from the projects slice where it knows the worktree. The
  Projects page's panel (no thread) shows no list. A thread whose primary is the workspace
  folder has no Worktree tab (its cwd is no worktree), so no list either.
* **`ThreadView.projectIds` and `.branch`** are mapped, optional (PR 3 may settle their
  final shape); `sameThread` compares `projectIds` by value.
* **Removed with the surface:** the W letter, `view.panel.workspace` (daemon, mock, GUI
  presenter, ShowView routing), the workspace badge's click (the badge itself is PR 3's;
  only its handler went), the Projects page's "Show in thread's panel", and the member
  rows' New terminal here and Run in (Run in stays in the row menu and palette). The
  thread header's workspace chip is a `CommandButton` for the removed verb, so it hides;
  `HeaderActions.tsx` is PR 3's and untouched.
* **Cleanup prediction.** The broom no longer counts workspace members as holds. The
  daemon also holds a worktree that is another thread's checkout, which the GUI does not
  know without a Checkouts read per thread: the broom can show on such a worktree and the
  cleanup then keeps it and says which thread is on it.

## Gotchas

* Before this PR, 15 workspace e2e tests already failed on main (PR 2 reshaped the view and
  the mock had v1 workspaces). This PR rewrites or removes the Projects page and panel
  ones; the composer and sidebar ones (`composer-switch`, `workspaces`, `sidebar` Run in)
  are PR 3's.
* `thread.new`'s `When` refuses the Projects page's context without a project: hence the
  composer's context for Edit instructions.
* A Zustand selector over `projectIds` must return a string (or `useShallow`): the array is
  new on every thread update.
* With `CODE_FOUNDRY_HOME` outside the home directory (the isolated test app), a synthetic
  workspace's managed dir is outside it too and the File tab cannot read its CLAUDE.md
  (`ReadFile` refuses); a rooted workspace's opens. A real install's config home is under
  home.
* The worktree-isolated agent shell refuses compound commands that combine `cd` and git;
  edits were made by script files.

## Verified

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck,
  lint, vitest with the strict design guard).
* Tests: `TestWorkspaceContents` (store: none, AGENTS.md then CLAUDE.md, skills with a
  SKILL.md only, Updated only on a change, a rename keeps them, a rooted workspace's root
  file, a reopen), `TestTurnEndWorkspace` and `TestWorkspaceContentsGlue` (daemon),
  `TestWorkspaceReveal` and `TestWorkspaceRemoveConfirm` (commands), the view and
  capabilities rows without `view.panel.workspace`; vitest `lib/workspaceCard.test.ts`,
  `lib/alsoIn.test.ts`, `surfaces/worktreeTarget.test.ts` and the reshaped
  `lib/projects.test.ts`.
* `make gui-e2e` (WebKit, mock): `workspace-cards.spec.ts` (10 tests) and the updated
  `projects`, `worktree-panel`, `terminal-routing` and `sidebar` specs pass. Six tests
  still fail, all in PR 3's area and asserting v1 composer and sidebar behaviour the daemon
  no longer has: `composer-switch` "switch to a workspace", `workspaces` (three: workspace
  chips, new-worktree workspace, Also in making a workspace), `sidebar` Run in (two). Five
  of them failed on main before this PR; the third `workspaces` test fails now because the
  mock's `thread.new --projects` no longer makes a v1 workspace, as the daemon has not
  since PR 1.
* **Live app** (`make build && make gui-build`, `CODE_FOUNDRY_HOME=/tmp/cfv2-gui4`, scratch
  repos `web` and `api` and a folder `mono` with `CLAUDE.md` and `.claude/skills/demo`
  under `~/cfv2-scratch-gui4`; real Claude, Haiku 5.5 at medium effort):
  * `workspace new shop --projects web,api` and `workspace new mono --projects api --root
    ~/cfv2-scratch-gui4/mono`: `workspace list --json` had mono's root `CLAUDE.md` and
    `demo`, shop none. The Projects page showed both cards (mono rooted, its folder
    starting threads; shop with web starting them, "none yet" twice), every worktree under
    its project, New workspace in the Workspaces title.
  * `thread new --projects web,api --project web --new-worktree --branch feat/also` and two
    files changed in api's worktree: the thread's Worktree tab (`view.panel.worktree`)
    listed "Also in: api feat/also" with 2 changed files.
  * `thread new --workspace shop --project workspace --new-worktree=false` (what Edit
    instructions starts) with a prompt to write `CLAUDE.md` and a `greet` skill: when its
    turn ended, `workspace list` showed shop's `CLAUDE.md` and `greet` without another
    spawn (the turn-end refresh).
  * Screenshots in the PR body (dark and light). The panel state the isolated app shares
    with the real one (the Projects page's panel) and the scheme setting were put back;
    the scratch home, repos and `~/.claude/projects` entries were removed afterwards.
* Not exercised live: clicks inside the window (the agent cannot click into the webview),
  so rename, set primary, add/remove, remove, Reveal, the File tab and the Also in click ran
  in the mock e2e only; their commands ran live from the CLI in PR 2.
