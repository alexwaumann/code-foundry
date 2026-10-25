# Workspaces v2, PR 1: thread model and derived checkouts (daemon)

Status: done on branch `cf/workspaces-v2-threads`. Design record:
`workspaces-v2-handoff.md` (§3 Thread and Checkouts, §4 Spawn, §5 the threads part of
the migration, §8 step 1). PR 2 (workspace store and managed dirs) follows on
`cf/workspaces-v2-workspaces`.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/thread_lifecycle.proto` | `Thread.project_ids` (68); `CreateThreadRequest.project_ids` (25), `like_thread_id` (26), `new_branch` (27), `checkout_mode` (28); `CreateThreadResponse.hints` (3); `ThreadCheckoutsRequest/Response`, `ThreadCheckout`; `workspace_id`, `created_worktree`, `branch` re-documented |
| `proto/codefoundry/v1/thread.proto` | `ThreadService.Checkouts`; RunIn re-documented (any thread's checkouts) |
| `internal/db/migrations/0047_thread_project_ids.sql` | `threads.project_ids` (JSON array); every thread's set is its project; v1 workspace threads get the members, the workspace's branch and `created_worktree = 1` |
| `internal/store/thread/checkouts.go` | `Checkout`, `CheckoutsOf` (pure derivation), `Manager.Checkouts`, `CheckoutHints`, `memberDirs`, `requireCheckouts` |
| `internal/store/thread/placement.go` | `decidePlacement` (the inheritance matrix, pure), `placeThread`, parallel `makeWorktrees` with rollback, `ensureMembers` (a start, a fork) |
| `internal/store/thread/manager.go` | Create through placement; spawn requires every member's checkout; `--add-dir` for each; `Options.Archived`; `ProjectSource` gains `RemoveWorktree` and `DefaultWorktreePath` |
| `internal/store/thread/runin.go` | RunIn over the thread's checkouts (not only workspace members) |
| `internal/store/project/worktree_path.go`, `cleanup_archived.go`, `cleanup.go` | `Git.DefaultWorktreePath`; `ArchivedVerdict`; `CleanupOptions.Verdict` |
| `internal/daemon/cleanup_archived.go` | the archive cleanup (`archiveCleaner`), `checkoutThreads` (the cleanup holds now count every checkout) |
| `internal/daemon/linked_prs_branch.go` | branch links for every member of a thread's set |
| `internal/command/commands_thread_checkouts.go` | `thread.checkouts` |
| `internal/command/commands_thread_lifecycle.go` | `thread new --projects` (the set), `--like`, `--new-branch`, `--new-worktree=false` (checkout mode); hints as warnings |
| `gui/frontend/mock/world.ts` | `MockThread.projectIds`; every thread message carries `projectIds` |

## Decisions

* **Persistence: a JSON column, not a table.** `threads.project_ids` holds the set as a
  JSON array. The thread store reads and writes a row whole (`saveThread` upserts every
  column), the set is small and only ever used whole, and labels, `spawn_env` and
  `spawn_add_dirs` are stored the same way; a `thread_projects` table would need a join
  on load and a second write kept in step with the row for no query that needs it
  (filtering happens over the snapshot in memory). Load normalizes: sorted, deduplicated,
  `project_id` added (`CleanProjectIDs`), so a hand-edited or old row cannot break the
  invariant.
* **Derivation order.** The primary's checkout is the row's `worktree_path`. A worktree-mode
  git member's is the worktree listed at `DefaultWorktreePath(project, branch)`, else any
  other listed worktree on the branch (one made before the path rule, or by hand), the
  main checkout last; when none is listed, the default path, `missing`. A plain folder is
  its folder in any mode. Checkout mode: the main worktree.
* **`DefaultWorktreePath` reads the slug of the last reconcile.** `CreateWorktree` reads
  `origin` afresh; the two only differ before a project's first reconcile, and the lookup
  of an existing worktree on the branch comes first anyway.
* **Reuse.** A worktree for (project, branch) that exists is reused (Create, start,
  fork); one only for a branch known to be new is never looked up. Making one is
  serialized per (project, branch) inside the store, so two threads starting together
  share the result instead of racing `git worktree add`.
* **Unregistered members are skipped, missing checkouts are errors.** A spawn fails,
  naming the project, when a registered member's checkout is missing after the start
  made what it could; a member whose project is no longer registered is logged and
  left out (nothing can be derived, and failing would make the thread unstartable).
* **v1 workspace threads in PR 1.** Their members' paths come from the workspace store's
  member rows (`Checkout.FromWorkspace`), a missing one is skipped as before, and the
  prompt line and the CLAUDE.md env flag stay. `thread new --workspace` sets the set to the
  members, the branch to the workspace's and worktree mode. PR 2 replaces all of this.
* **Recreate.** A workspace reference no longer stops a start from making a removed
  primary worktree again (`recreatable`); the other members' are made again by
  `ensureMembers`, with a timeline note, and the on-worktree-create actions run for each.
* **Inheritance (`placement.go`).** The source is the creator (`created_by`, which the CLI
  defaults to `$CODE_FOUNDRY_THREAD`; `--created-by=` opts out of both). A creator without
  a project passes nothing on (Ember). `--project` alone keeps the set and picks the
  primary; `--projects` narrows (or replaces) the set and keeps branch and mode;
  `--new-worktree` or `--new-branch` branch off; `--new-worktree=false` is checkout mode
  (`CreateThreadRequest.checkout_mode`, an addition: the request had no way to say "not
  worktree mode" against an inherited one). A `--project` or `--worktree` outside the
  creator's set places the thread there as before, so an orchestrator in one project can
  still start a worker in another; with `--like` the same is an error. A copied primary
  in checkout mode keeps the source's cwd (a user's own worktree). The orchestrate
  skill's `thread new --project <id> --new-worktree --created-by --request-id` is the
  "branches off" row: same as before for a single-project parent.
* **Caller placement now goes through like.** `thread new` with no placement inside a
  thread (its CLI or a page it shows; `callerPlacement`, landed on main the same day)
  used to copy the caller's project, worktree and workspace; it now sends
  `like_thread_id` = the caller, so the set, branch and mode come along too.
* **`--projects` changes meaning.** It is the set in any mode; with `--new-worktree` it no
  longer makes a v1 workspace (`new_workspace` stays in the proto and the store until
  PR 2 removes it, for the GUI's raw API use). The GUI composer still sends
  `new-worktree` + `projects` and now gets a multi-project thread without a workspace
  record; PR 3 reshapes the composer.
* **Rollback.** A Create whose member fails removes the worktrees it made (forced, with
  the branches it made), as the v1 workspace Create did.
* **Collision hints** are computed by the store after Create (`CheckoutHints`, the API
  puts them in `CreateThreadResponse.hints`), one line per member another thread that is
  not archived has at the same path; the command returns them as `Result.Warnings`, which
  the CLI prints as `warning: …` lines on stderr.
* **`thread checkouts` resolution.** `--id`, else `$CODE_FOUNDRY_THREAD` (the arg's
  `DefaultToThreadEnv`, so an explicit `--id` wins over the env, as every such arg in the
  registry), else the palette's active thread, else the thread one of whose checkouts
  holds `--cwd` (deepest checkout; among threads sharing it its primary's thread, then a
  live one, then the most recent). The output starts with one line naming the thread and
  its mode (an addition), then `PROJECT PATH BRANCH INSTRUCTIONS`, `(current)` and
  `(missing)` after the branch as `workspace members` did, `(folder)` for a plain folder,
  then `WORKSPACE <name>  -` (the managed dir arrives with PR 2).
* **`workspace members`** stays as it was with "Deprecated: thread checkouts …" in its
  description, because the v1 prompt line still names it; PR 2 removes both.
* **Cleanup on archive** runs in the daemon (the store knows neither terminals nor the
  project cleanup rule): the thread store calls `Options.Archived` for each thread an
  archive just archived, the daemon starts `project.Cleanup` per derived worktree with
  `Verdict: project.ArchivedVerdict` (made by the app, on a branch, status clean, no
  operation; no base rule, no FreshFor) and the existing `cleanupHold`, fed by
  `checkoutThreads` (every checkout of every thread that is not archived, besides cwds).
  A v1 workspace member is held ("member of workspace …"). Never `--force`, never the
  branch. The user's cleanup and the abandoned sweep use the same holds now, so a member
  checkout of a live thread is never removed by them either.
* **`thread list --project`** matches a thread with the project anywhere in its set.
* **RunIn** works for any thread with projects; the target must be one of its checkouts
  (by project id or name, or the path). The command's availability in the GUI is still
  "workspace thread" until PR 2.

## Gotchas

* The sandbox here refuses compound shell commands that mention git; the e2e steps were
  run as a script file.
* `fresh` (a branch known new) must skip the "existing worktree on the branch" lookup:
  a test env whose `RefExists` says no to everything reused a worktree from an earlier
  Create on the same generated branch.

## Verified

* `make check` green.
* Tests: `TestDecidePlacement` (the inheritance and like matrix, 23 rows),
  `TestCheckoutsOf` and `TestCleanProjectIDs` (pure), `TestMultiProjectWorktreeThread`
  (two worktrees made, the other member an `--add-dir`, Checkouts by id and by a cwd deep
  in a member, a child inheriting set, branch and mode and sharing the worktrees, hints,
  a member removed by hand made again at the next start), `TestMultiProjectCreateRollsBack`,
  `TestRunInCheckouts`, `TestArchivedVerdict`, `TestArchiveCleanup` (held by another
  thread's checkout or cwd, a terminal, a v1 member, dirty; archived threads hold
  nothing), `TestThreadProjectIDsMigration`, `TestThreadCheckouts`, `TestThreadNewHints`,
  and the updated `thread.new` command rows.
* **Scratch daemon** (`CODE_FOUNDRY_HOME=/tmp/cfv2e2e/home`, two scratch repos `web` and
  `api` with a `CLAUDE.md` each and a plain folder `notes`, under `~/cfv2-scratch`; real
  Claude, Haiku 5.5 at medium effort, one-word prompts):
  * `thread new --projects web,api,notes --project web --new-worktree --branch feat/e2e`:
    `feat/e2e` worktrees in web and api (made 27 ms apart), `project_ids` all three, cwd
    the web worktree; the spawn's `--add-dir`s: skills, attachments, pages, the api
    worktree, the notes folder.
  * `thread checkouts <id>` and, from inside the api worktree with no id, `thread
    checkouts`: the table with both CLAUDE.md paths, `(folder)` for notes, `(current)` on
    api in the second.
  * `thread new --like <id>`: the same set, branch and cwd, and three warnings on stderr
    (web and api "@ feat/e2e is also open in e2e-one", notes "is a folder, not a repo").
  * `CODE_FOUNDRY_THREAD=<id> thread new --project api`: inherited set and branch, cwd the
    api worktree, `created_by` the parent; `CODE_FOUNDRY_THREAD=<id> thread new
    --new-branch`: a new branch (`cf/<id>`, the scratch machine's naming model failed) in
    new web and api worktrees, the folder shared.
  * Archiving the parent cascaded to its two hidden children: the new-branch child's two
    worktrees were removed at once ("its branch stays"); the parent's `feat/e2e` ones were
    kept, "thread e2e-two is on it". Archiving the last live thread on `feat/e2e` removed
    both; `git branch` still lists `feat/e2e` and `cf/<id>` in both repos; notes untouched.
  * A message to the archived parent unarchived it, made the web worktree again
    (`recreate.go`'s note) and the api one (`ensureMembers`' note), and resumed the
    conversation. With an untracked file in the api worktree, archiving it again removed
    the web worktree and kept api ("uncommitted changes").
  * Daemon log: no warnings or errors besides the naming model's.
