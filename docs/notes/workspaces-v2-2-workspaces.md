# Workspaces v2, PR 2: workspace store and managed dirs (daemon)

Status: done on branch `cf/workspaces-v2-workspaces`, stacked on PR 1
(`workspaces-v2-1-threads.md`). Design record: `workspaces-v2-handoff.md` (§3 Workspace,
§4 the managed dir, the instructions and the primary, §5 the workspaces part, §8 step 2).
The GUI moves onto it in PRs 3 and 4; the skills in PR 5.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/workspace.proto` | `Workspace{id, name, created_at, members (project ids, 6), root_path (7), default_primary (8), managed_dir (9)}`, v1 `branch`/member fields reserved; `WorkspaceService` List, Create, AddProject, RemoveProject, Rename, SetDefaultPrimary, Remove, Watch; `Members` and its messages gone |
| `proto/codefoundry/v1/thread_lifecycle.proto` | `CreateThreadRequest.new_workspace` (11) and `NewWorkspace` removed, reserved; `workspace_id` documented as the reference; `ThreadCheckoutsResponse.workspace_dir` (5) |
| `internal/db/migrations/0048_workspaces_v2.sql` | `workspaces` drops `branch`, gains `root_path` and `default_primary` (the first member added, else `workspace`); `workspace_members` made again without `worktree_path` |
| `internal/store/workspace` | the reshaped store: `workspace.go` (types, `Store`), `store.go` (Manager), `dirs.go` (managed dirs and root links), `db.go`, `resolve.go`; `workspacetest.Fake` rewritten |
| `internal/paths` | `Paths.Workspaces()` (`<home>/workspaces`) |
| `internal/store/thread/workspace.go` | `ThreadPrompt` stays; the v1 launch (members, env flag, prompt line, new workspace, member picking) is gone; `workspaceSpawn` (managed dir, instructions), `WorkspaceSource{Snapshot, EnsureDirs}` |
| `internal/store/thread/placement.go` | `workspacePlacement`: `--workspace` gives the set and the default primary; `workspace` as the primary runs in the workspace's folder |
| `internal/store/thread/runin.go` | the workspace's folder is a RunIn target; a thread with no other checkout is refused |
| `internal/command/commands_workspace.go` | `workspace new/list/add-project/remove-project/rename/set-primary/remove`; `workspace members` removed |
| `internal/command/commands_thread_*` | `thread new --workspace` with `--projects`/`--new-worktree`/`--project workspace`; `thread run-in` offered for any thread; `thread checkouts` prints the managed dir |
| `internal/daemon` | the workspace store opens with its managed-dir root; the cleanup holds and branch links no longer know v1 members |
| `gui/frontend/src/api/workspace.ts`, `mock/world.ts`, `mock/settings.ts` | the view maps the new message (members without worktrees, root, default primary, managed dir); the mock sends the new shape |

## Decisions

* **Workspace = `{id, name, root_path, members, default_primary, managed_dir, created_at}`.**
  Members are project ids, always sorted (stored in any order, sorted on load). Names are
  unique case-insensitively (checked in the store; the column's case-sensitive UNIQUE
  stays, migrating it could refuse old data), at most 100 bytes, and `workspace` is
  refused as a name (it is the primary keyword). Refs to a workspace are its id or its
  name in any case.
* **Default primary.** `workspace` for a rooted workspace (or one without projects), else
  the first project given (not the first by id). Removing that project moves the default
  to `workspace`.
* **Managed dir** `<config home>/workspaces/<id>`, 0700, made at Create and for every
  workspace at store start. A rooted workspace's holds symlinks `CLAUDE.md`, `AGENTS.md`,
  `.claude` to the root's, for the ones that exist; `EnsureDirs` (start, Create, every
  spawn of a thread that references it) adds missing links, removes dangling ones and
  repoints a link whose target moved. A real file where a link would go is left alone
  (logged). The root must be an existing folder under home (symlinks resolved).
* **Remove**: a synthetic workspace's managed dir goes with everything in it; a rooted one
  loses its links and then its dir when empty. A managed dir that is not directly under
  the store's root is never touched. Threads that reference a removed workspace keep
  their set and run without it (logged at spawn). No live-thread guard: nothing on disk a
  thread needs goes.
* **Spawn** (`workspaceSpawn`): for a thread with a `workspace_id` whose cwd is neither the
  managed dir nor the root: `--add-dir <managed dir>` after the attachments and pages
  dirs, before the other members' checkouts; and `CLAUDE.md`, else `AGENTS.md`, read
  through the managed dir (so a rooted workspace's root file), cut to 32 KiB on a rune
  boundary (logged), appended as `Workspace <name> instructions` + a blank line + the
  text, after `ThreadPrompt` and before the app memory. In the managed dir or the root,
  Claude loads the files itself and nothing is added. The env flag
  (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`) and the "This thread belongs to
  workspace" line are gone.
* **`thread new --workspace <id|name>`** (`workspacePlacement`): the reference; its members
  are the set unless `--projects` gives one; the primary is `--project` (a member, or
  `workspace`), else the worktree's project, else the default primary when it is
  `workspace` or in the set, else the first project given; a workspace without projects
  runs in its folder. `--workspace` places the thread itself: a creator's set is not
  copied then. Mode: `--new-worktree` (the CLI; the GUI applies
  `threads.default_worktree` itself). A thread whose primary is the workspace has an
  empty `project_id`, its set as `project_ids`, and its cwd at the root or managed dir;
  every member is an `--add-dir`; a thread made inside it inherits that folder as its
  primary.
* **A no-project cwd.** The managed dir lives under the config home, which need not be
  under the user's home; the workspace path does not go through `noProjectCwd`, the
  workspace store vouches for the folder.
* **RunIn**: the workspace's folder is a target (`thread run-in workspace`, or its path);
  refused for a thread with one checkout and no workspace folder. The command is offered
  for every thread (When cannot count checkouts).
* **`workspace.set-primary`** is an addition to the handoff's verb list: SetDefaultPrimary
  is a user action (the Projects page cards mark the default), and every user action is
  a command.
* **No `--cwd` resolution for workspace verbs.** A workspace is named by id or name, else
  the context's active workspace (`--context-workspace`, the GUI's).

## Gotchas

* SQLite refuses `DROP COLUMN` on a UNIQUE column: `workspace_members` is made again.
* The GUI view keeps `branch` and member `worktreePath` (both `""` now) so PR 1's GUI
  compiles unchanged; PRs 3 and 4 drop them. GUI workspace flows that relied on member
  worktrees (the composer's workspace draft, the Workspace panel surface) show nothing
  useful until then.
* A rooted workspace's links are re-checked at spawn only: a thread whose process is up
  keeps what it started with (verified: a send to a live thread does not touch them).

## Verified

* `make check` green.
* Tests: `TestSyntheticWorkspace`, `TestRootedWorkspaceLinks`, `TestManagedDirsAtStart`
  (workspace store, real SQLite and files), `TestWorkspacesV2Migration`,
  `TestWorkspaceThreadSpawn` (set and default primary from the workspace, the managed dir
  then the other member as add-dirs, AGENTS.md then CLAUDE.md appended and cut, no env
  flag or v1 line, nothing added in the workspace's own folder, Checkouts from inside the
  managed dir, `--projects` narrowing), `TestRootedWorkspaceThread`, the workspace rows of
  `TestDecidePlacement`, `TestWorkspaceCommands`, `TestWorkspaceUnaryAndErrorCodes`, the
  CLI e2e rows.
* **Scratch daemon** (`CODE_FOUNDRY_HOME=/tmp/cfv2e2e/home`, scratch repos `web` and `api`
  and a folder `mono` with `CLAUDE.md` and `.claude/skills/demo` under `~/cfv2-scratch`;
  real Claude, Haiku 5.5 at medium effort, one-line prompts):
  * `workspace new shop --projects web,api` (synthetic: an empty managed dir) and
    `workspace new mono --projects web --root ~/cfv2-scratch/mono` (links `CLAUDE.md` and
    `.claude`, no `AGENTS.md` link); `workspace new SHOP` refused, "a workspace named
    "shop" exists".
  * A `CLAUDE.md` with a codename written into shop's managed dir; `thread new --workspace
    shop`: cwd web, set both, add-dirs skills, attachments, pages, the managed dir, api;
    the system prompt had `Workspace shop instructions` and the text; Claude answered the
    codename. No `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, no v1 line.
  * `thread new --workspace mono`: cwd the root, no managed dir add-dir, no block; Claude
    answered mono's codename from its own CLAUDE.md. `--project web`: the block appended,
    the codename answered. `thread checkouts` printed `WORKSPACE mono <managed dir>`, and
    from inside the root found the root thread ("runs in its workspace's folder").
  * `workspace rename Store`, `set-primary workspace`, `remove-project api`, `add-project
    api`; `thread new --workspace store` then ran in the managed dir with web and api as
    add-dirs and no block.
  * `thread run-in web` moved the root thread to web.
  * A new rooted workspace over the root (now `AGENTS.md` only) linked `AGENTS.md` and
    `.claude`; after `CLAUDE.md` was added to the root, the next thread's spawn added the
    link and Claude answered the new codename. A thread made inside it with no placement
    copied the workspace, the set and the api primary.
  * `workspace remove` of the synthetic one deleted its folder; of the rooted ones only
    their links (the root kept `CLAUDE.md`, `AGENTS.md`, `.claude`). Daemon log: no
    warnings or errors besides the gh poller's.
