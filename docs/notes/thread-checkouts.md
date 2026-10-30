# Thread owns its checkouts; the branch is read from HEAD

Status: plan (this file becomes the step note). Branch `cf/thread-checkouts`.

## The change

Until now a thread owned a project set, one branch and a primary (the cwd), and every
other member's checkout was derived per (project, branch) at every read
(`internal/store/thread/checkouts.go`: `derivedWorktree` over `DefaultWorktreePath`, else any
linked worktree on the branch). A checkout whose branch moved (stacked PRs, `git switch` by
the model or the user, an orchestrator whose workers commit on their own branches) then
looked like a lost checkout, and a hand-made worktree that moved was lost for good.

Now the thread records a path per member (`Thread.CheckoutPaths`, `threads.checkouts`), and
what each checkout has checked out is a live fact read from the project snapshot at that
path (HEAD, detached, main checkout, upstream ahead/behind, operation in progress). The
primary's path stays `worktree_path` (the cwd). `Thread.Branch` stays as the branch the
thread was created for: what recreate checks out again at the same path, and the "moved
from" note when a worktree-mode checkout's HEAD is elsewhere. In-place (checkout mode)
threads record each member's main checkout, whatever branch it has.

A member with no recorded path (a row from before, or a worktree that was missing when
the row was filled) is resolved the old way, by the creation rule: in worktree mode the
worktree at `DefaultWorktreePath(project, Branch)` or another linked worktree on the
branch, else the default path (missing); a plain folder its folder; in checkout mode the
main checkout. Every start records what it resolves (`ensureMembers`), so the old
derivation survives only as the resolution of an unrecorded member.

## Storage and migration

* `0049_thread_checkouts.sql`: `threads.checkouts TEXT NOT NULL DEFAULT ''`, a JSON object
  `{project_id: path}` written whole with the row (as `project_ids`). `''` is "not recorded
  yet"; `'{}'` a thread with nothing recorded.
* SQL cannot run the derivation (it needs the project store's worktree lists), so the fill
  is the precedent of `branch` (migration 0027 + `backfillBranches`): at daemon start every
  row with projects and `''` is filled from the derivation once its projects have listed
  their worktrees (bounded wait, then whatever is decided). A member whose worktree is
  missing then gets `""` and is made at its next start on the created-for branch at the
  default path (the path the derivation gave), exactly the recreate it had before. Until a
  row is filled it resolves as before, so a start in the first second behaves as today.

## Every site

| Site | Before | Now |
|---|---|---|
| `thread/checkouts.go` `CheckoutsOf` | derived per (project, branch) | recorded path; unrecorded members resolved by the creation rule; `Checkout` gains HEAD, detached, main, git status, created-for branch, moved; `Derived` becomes `WorktreeMode` |
| `thread/thread.go` `Thread` | set + branch + primary | + `CheckoutPaths map[string]string` (nil: not recorded); `Branch` documented as created-for |
| `thread/db.go` save/load | | the `checkouts` column (`''` round-trips to nil) |
| `thread/placement.go` `placeThread`/`placeWorktrees` | the branch decides the paths | records every member's path at Create: the made or reused worktree, the folder, the main checkout, the `--worktree` primary; with like or a creator, the copied thread's recorded paths for the members it shares (same checkouts), made only for members it lacks |
| `thread/placement.go` `ensureMembers` | makes missing derived worktrees | also records: an unrecorded member is resolved and recorded; a missing worktree-mode member is made on the created-for branch and its path recorded |
| `thread/placement.go` `decidePlacement`/`copyPlacement` | src checkouts by derivation | unchanged rules; src checkouts are its recorded ones |
| `thread/recreate.go` (primary) | on `Branch` at the same path | unchanged: created-for branch, same path (Claude's transcript is keyed by cwd) |
| `thread/recreate.go` `backfillBranches` | fills `Branch` | unchanged; the checkouts fill runs beside it on the same loop |
| `thread/runin.go` + `runner.go`/`stream.go` set_cwd | cwd moves; the old primary is derived again | cwd moves to the target's recorded path; the old primary's path stays recorded (a user worktree is no longer forgotten) |
| `thread/manager.go` Create, Fork | | Create stores the paths; Fork copies them |
| `thread/manager.go` spawn (`requireCheckouts`, `memberDirs`) | derived paths | recorded paths (`ensureMembers` ran first) |
| `thread/lifecycle.go` `startStopped` | ensureWorktree, ensureMembers | same calls; ensureMembers records |
| `thread/checkouts.go` `CheckoutHints`, `otherHolder` (collision) | same path, paths derived | same path, recorded: two threads on one branch in different worktrees no longer collide; one worktree moved to another branch still does |
| `thread/manager.go` `CreateReport.SharedWith` | `otherHolder` | same, over recorded paths |
| `thread/checkouts.go` `threadAt`, `Checkouts` (thread checkouts by cwd) | derived | recorded |
| `thread/conversation.go` `fileRefRoots` | derived | recorded |
| `thread/threadtest` fake | branch-derived checkouts | records paths; `Checkout` fields as the store |
| `daemon/linked_prs_branch.go` `threadBranches` | members by `th.Branch` | each checkout's HEAD branch at its recorded path; a missing worktree-mode one contributes the created-for branch |
| `daemon/cleanup_archived.go` archive cleanup + `checkoutThreads` holds | `Derived` | `WorktreeMode` (only worktree-mode members are cleaned; never the main checkout, the verdict refuses it anyway); holds over recorded paths |
| `daemon/pluginfacts.go` `thread.branch` | cwd's HEAD, else `Branch` | unchanged (already HEAD) |
| `store/project` | status, FSEvents tiers | unchanged: the checkout facts are its snapshot at the recorded path, no second poller |
| `store/gh` | branch lists, dashboards | unchanged: the daemon glue above picks the branches |
| `api/thread_lifecycle.go` `threadToProto` | | `Thread.checkout_paths` |
| `api/thread_checkouts.go` | | `ThreadCheckout` live fields |
| `proto` `Thread.branch` | "branch of a worktree-mode thread" | the created-for branch, a record |
| `proto` `ThreadCheckout` | path, branch, derived | + head, detached, is_main, status (GitStatus: upstream, ahead/behind, operation), created_branch, moved; `derived` renamed `worktree_mode` (same number) |
| `command` `thread checkouts` | branch column, "worktrees on branch X" | "worktrees made for branch X"; the branch column from HEAD, `(detached <sha>)`, `(moved from X)` |
| `command` `thread get` | `branch: X` | `created for branch: X` |
| `command` `thread new` summary, `thread list` place | `Branch`, cwd's HEAD | unchanged (the summary names what it made; the list already reads HEAD) |
| `command` `thread archive` confirmation (`commands_thread_bulk.go`) | worktree mode + branch | unchanged (whether the thread has app worktrees to clean, which is mode) |
| skills: orchestrate `SKILL.md`, `reference/patterns.md` §2c | "worktrees on branch", inherits branch | header line updated; a child shares your checkouts (not "your branch"); within caps |
| `plugin/reference/host-api.md` `threadList.branch` | made-for branch | unchanged (already says so) |
| `docs/ARCHITECTURE.md` §6 | "derived, never stored" | recorded per member, branch from HEAD |
| GUI `src/api/threads.ts`, `src/api/checkouts.ts` | | map `checkoutPaths` and the new checkout fields |
| GUI `lib/collisionHints.ts`, `compose/useCollisions.ts` (composer banner) | members derived by branch | the thread's recorded paths (collision = same path) |
| GUI `lib/threadRow.ts` (sidebar line 2, header) | multi-project worktree mode shows `Thread.branch` | the cwd's HEAD; the created-for branch only where there is no checkout to read (workspace folder, folder primary) |
| GUI Work in / Run in pickers | projects store worktrees; `Checkouts` RPC | unchanged (new threads are still placed by branch; Run in lists recorded checkouts through the RPC) |
| GUI `mock/world.ts` | derives by branch | records paths at create; `checkoutsOf` reads them; threads carry `checkoutPaths` |
| e2e | | existing specs pass unchanged; the mock follows the daemon |

## Tests

Table tests: `CheckoutsOf` (recorded, unrecorded, moved, detached, main, missing, folder,
unregistered), the fill derivation (`fillPaths`), the migration (`internal/db`), collisions
(same branch different paths, same path different branch), placement recording, RunIn
keeping the old primary's path, ensureMembers recording.
