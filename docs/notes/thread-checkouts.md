# Thread owns its checkouts; the branch is read from HEAD

Status: done on branch `cf/thread-checkouts` (one PR, daemon model plus the GUI mapping it
forces). The table below was the plan, written first from a grep of every reader and
writer; each row now says what landed. A later GUI feature (a per-thread info card) reads
`ThreadCheckout`'s live fields and `Thread.checkout_paths`. Review fixes (PR #401, "merge
after fixes") are in the decisions, gotchas, tests and verification below, marked
"review".

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
| `thread/placement.go` `memberWorktree`, `makeWorktrees`/`makeWorktree` (review) | the worktree at the default path is the branch's whatever it has | the default-path worktree is the branch's only while it has it checked out; one switched away refuses (`defaultPathTaken`, beside `mainCheckoutBusy`) |
| `thread/placement.go` `ensureMembers` | makes missing derived worktrees | also records: an unrecorded member is resolved and recorded; a missing worktree-mode member is made on the created-for branch and its path recorded; (review) a recorded checkout-mode member that is gone falls back to the project's own checkout, with a timeline note |
| `thread/placement.go` `decidePlacement`/`copyPlacement` | src checkouts by derivation | unchanged rules; src checkouts are its recorded ones; `sharedCheckouts` (pure) picks what a thread placed like src shares |
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
| `daemon/linked_prs_branch.go` `threadBranches` | members by `th.Branch` | each checkout's HEAD branch at its recorded path (`thread.CheckoutsOf`); a missing worktree-mode one, or a gone cwd, contributes the created-for branch |
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
| GUI `lib/collisionHints.ts`, `compose/useCollisions.ts` (composer banner), `thread/useThreadCheckouts.ts`, the Composer's like draft | members derived by branch | the thread's recorded paths (collision = same path); an unrecorded member resolves as the daemon does; (review) a draft on an existing branch, and an unrecorded member, never take the main checkout as the branch's worktree |
| GUI `lib/alsoIn.ts` `checkoutsKey`, `stores/threadCheckouts.ts` (review) | cwd, branch, set, member worktree paths | + the recorded checkouts, so a start recording one (or Run in) refetches |
| GUI `stores/threads.ts` `sameThread` | | `checkoutPaths` compared by value, so rows keep their identity |
| GUI `lib/threadRow.ts` (sidebar line 2, header) | multi-project worktree mode shows `Thread.branch` | the cwd's HEAD; the created-for branch only where there is no checkout to read (workspace folder, folder primary) |
| GUI Work in / Run in pickers | projects store worktrees; `Checkouts` RPC | unchanged (new threads are still placed by branch; Run in lists recorded checkouts through the RPC) |
| GUI `mock/world.ts` | derives by branch | records paths at create; `checkoutsOf` reads them; threads carry `checkoutPaths` |
| e2e | | existing specs pass unchanged; the mock follows the daemon |

## Decisions

* **A JSON column, written whole with the row**, as `project_ids`: a map of project id to
  path. `''` (nil in Go) is "not recorded yet", `'{}'` a thread with nothing recorded. The
  primary's entry mirrors the cwd: every write of the cwd to a project's checkout goes
  through `movedTo` (RunIn with no process, the runner's owed move, set_cwd accepted),
  which also keeps the checkout it leaves; reads take the primary's from `worktree_path`.
* **The migration's Go half is a startup fill**, on the loop the branch backfill used
  (`untilDecided`, 2 minutes): SQL cannot list worktrees. A row is filled once its git
  members' projects have listed worktrees; past the wait an undecided member is `""`. The
  row is skipped if a start recorded something first or the cwd moved meanwhile.
* **The derivation survives only as the resolution of an unrecorded member**
  (`resolveMember`): the fill, a row not filled yet, an empty entry. So a start in the
  first second after an upgrade behaves exactly as before, and the GUI resolves the same way.
* **`Thread.Branch` is the created-for record**, empty in checkout mode as before: an
  in-place thread's checkout is the main checkout whatever it has, and is never "moved".
  `Checkout.Moved` is only for worktree-mode checkouts (listed, on another branch or
  detached). `thread get` says `created for branch:`; `thread checkouts` says `worktrees made
  for branch X` and marks `(moved from X)` and `(detached <sha>)`.
* **Like and a creator share the copied thread's checkouts** when the new thread keeps its
  mode (and in worktree mode its branch): the same paths, whatever they have checked out;
  only members it lacks, or whose checkout is gone, are made. A new branch, or
  `--new-worktree=false` from a worktree-mode thread, shares nothing.
* **Missing checkouts.** The primary: `recreate.go` as before, on the created-for branch at
  the same path. A worktree-mode member: made again on the created-for branch by the
  creation rule and recorded where it lands (logged when the path changed). (Review) A
  checkout-mode member whose recorded checkout is gone (a user's worktree an in-place
  thread ran in, then left with Run in, since deleted): it falls back to the project's own
  checkout (`resolveMember`), recorded, logged, with a timeline note, at a start and a
  fork. The set never changes, so a spawn error there (the first version) left the thread
  unable to start for good. A primary that is gone keeps the refusal: a user's checkout is
  never replaced under the cwd.
* **A worktree made for a branch, then switched away, is not that branch's** (review: the
  first version shared it). `memberWorktree` takes the default-path worktree only while it
  has the branch checked out and is not detached, else another linked worktree on the
  branch, which is shared as before. `makeWorktrees` refuses, up front beside
  `mainCheckoutBusy`, when the default path is listed with another HEAD: `ErrFailedPrecondition`
  naming the path (as git lists it), its HEAD, a thread that works in it and the way out
  ("switch it back to X, or pick another branch"). `makeWorktree` checks again under the
  per-(project, branch) lock, where a git checkout at the default path that the project
  does not list refuses too (an empty folder there is left to `git worktree add`). This
  covers a Create, a child asking for its creator's branch (`--branch`, which shares
  nothing: a new branch), and a start making a missing member again. `branchWorktree` keeps
  the old rule for `resolveMember` and the fill, which must reproduce the derivation.
* **The GUI agrees with that rule** where it can: a draft on an existing branch and an
  unrecorded member never take the main checkout (the daemon refuses it); a worktree
  switched away is not on the branch, so it is no draft's checkout. The GUI does not
  compute default paths, so the refusal itself shows only after the Create; the mock does
  not model it.
* **`ListedCheckouts`** (review, optional item): the branch-link pass reads checkouts from
  the snapshot alone, without the path rule, a stat or the CLAUDE.md lookup per checkout.
* **`thread new --like` help** names checkouts (review). `thread new`'s own description
  ("Inside a thread it copies that thread's projects, branch and mode") stays: the guide is
  at its 25,500-byte soft cap and the like line was the one asked for.
* **Collision is the same path**; the hint names the checkout's HEAD (the created-for branch
  while it is missing). The pure part is `holderOf`.
* **Live facts come from the project snapshot** at the recorded path (`Listed`, branch,
  head, detached, main, `project.Status` with upstream ahead/behind and the operation): the
  status the project store already keeps fresh with FSEvents and its live tier. No git
  command was added.
* **Proto: paths on `Thread`, live facts on `ThreadCheckout`.** `Thread.checkout_paths` is
  identity only; putting branch and status on `Thread` would republish every thread on each
  git status change. The GUI joins the paths with the projects stream it already has.
  `ThreadCheckout` gains `head`, `detached`, `is_main`, `status` (`GitStatus`, only when the
  project lists the path), `created_branch`, `moved`; `derived` is renamed `worktree_mode`
  at the same number (daemon and GUI ship together).
* **GUI beyond `src/api`**, because the requirements force it and nothing new is shown: the
  composer's collision banner and the thread's checkouts read the recorded paths
  (`lib/collisionHints`, `useCollisions`, `useThreadCheckouts`, the like draft), a
  multi-project row's line 2 is the cwd's HEAD (`lib/threadRow`; the created-for branch only
  for a workspace-folder or plain-folder cwd), and `sameThread` compares the paths by value.
  The composer's "On <branch>" for a like draft still names the created-for branch.
* **Archive cleanup** is unchanged in rule: worktree-mode checkouts (`WorktreeMode` never
  includes a main checkout) through `ArchivedVerdict`, now at the recorded paths. A moved
  worktree is removed like any other clean one; its branch stays, and the next start makes
  it again on the created-for branch.

## Gotchas

* `project.Snapshot.Worktree` compares paths exactly: recorded paths must be the cleaned
  ones `CreateWorktree` returns. With a home under `/tmp`, `DefaultWorktreePath` spells a
  resolved, missing member `/tmp/...` while git lists `/private/tmp/...` (cosmetic, as
  before; a made one is recorded as git lists it).
* A missing member made again may reuse another linked worktree that has the created-for
  branch now (the creation rule), as the derivation did; no note says so yet (follow-up).
* `ThreadCheckout`'s live fields (head, moved, status) are as fresh as the read: the Also in
  list refetches when its key changes (cwd, branch, set, recorded checkouts, member
  worktree paths), not on a HEAD change inside a member; it shows branches from the
  projects stream. The info card should join `checkout_paths` with that stream.
* During the review run, Run in on a live thread to a scratch project's main checkout was
  refused by Claude (`set_cwd`: `needs_trust`): the app pre-trusts the worktrees it makes,
  not a project's own folder. Pre-existing, outside this change; a stopped thread moves
  without asking Claude.
* The daemon's branch-link fixture had projects without `Git`; the shared rule reads it.
* `TestCheckoutsSurviveABranchMove` needs `RefExists` to know `feat/x`: a branch thought new
  skips the lookup of an existing worktree (the old note's `fresh` gotcha).
* `make gui-e2e`'s "a project named workspace" spec failed once under 4 workers (an
  invocation poll) and passed 3 of 3 alone; `HtmlPreview.test.tsx`'s color-scheme case
  failed once in a `make check` and passed 3 of 3 alone; both unrelated.

## Follow-ups (from the review, not built)

* After an archive cleanup removes a moved worktree (on Y), the next start makes it again
  on the created-for branch X, not on Y where the commits were. At least the remade note
  should name the branch it had; better, remember the last HEAD at cleanup and check that
  out again.
* A timeline note when a member made again takes over another linked worktree on the
  branch.

## Tests

`TestCheckoutsOf` (recorded, unrecorded, moved, detached, a recorded path over the
branch's worktree, recorded empty, in place on a switched main checkout, unregistered with
and without a record), `TestFillPaths`, `TestMovedTo`, `TestHolderOf` (collision),
`TestSharedCheckouts`, `TestThreadCheckoutsMigration`; integration:
`TestCheckoutsSurviveABranchMove` (a hand-made worktree switched away keeps being the
member, no collision with the worktree that took the branch, one with a thread at the moved
path, the next start passes it and makes nothing, a like child shares it),
`TestStartRecordsCheckouts`, `TestRunInKeepsTheCheckoutItLeaves`,
`TestFillCheckoutsAtStartup`; `TestBranchLinksFor` (a moved checkout's HEAD, a recorded
worktree in checkout mode); `TestThreadCheckouts` (CLI), the GUI's `threadCheckouts`,
`threadRowModel` and reducer tests. Review: `TestMovedDefaultWorktreeIsNotTheBranchs` (a
moved default-path worktree refuses a Create, a child asking for its creator's branch and
a start remaking a missing member; another worktree on the branch is shared, nothing
made), `TestGoneUserCheckoutFallsBackToTheProjects`, `TestListedCheckouts`, the migration
test's round trip, `draftCheckouts` rows (the main checkout on the branch, a worktree
switched away), `checkoutsKey` with the recorded checkouts.

## Verified

* `make check` green.
* `gui-e2e` specs on the mock: workspace-cards, project-sets, composer-collision, sidebar,
  lineage (57 passed, the one flake above).
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/...`, two scratch repos `web` and `api` under
  home, Sonnet 5.5 at medium effort, one-word prompts), CLI only:
  * `thread new --projects web,api --project web --new-worktree --branch feat/e2e`: both
    worktrees recorded in `threads.checkouts`.
  * `git switch -c other` in the api worktree and `git switch -c feat/e2e-stacked` in the
    web one (the cwd): `thread checkouts` lists the same two paths, `feat/e2e-stacked (moved
    from feat/e2e)` and `other (moved from feat/e2e)`; `thread get` says `created for branch:
    feat/e2e`; `thread list` shows `web@feat/e2e-stacked`.
  * In place: `thread new --project api --new-worktree=false`, then `git switch -c hotfix`
    in the project's main checkout: the same checkout, `hotfix`, no "moved"; `thread list`
    `api@hotfix`.
  * Collision by path: a thread started in a hand-made worktree that has `feat/e2e` now got
    no warning; one in the moved api worktree got `api @ other is also open in e2e
    worktrees`.
  * Archive removed both moved worktrees (branches `other` and `feat/e2e-stacked` kept); a
    message made them again on `feat/e2e` at the same paths (recreate for the cwd,
    ensureMembers for api) and the conversation resumed.
  * The fill: daemon stopped, every row's `checkouts` set to `''`, the web worktree switched
    away again and the api worktree removed; at the next start every row was recorded
    ("checkouts of thread recorded from its derivation"), api as `""`, shown missing at its
    default path; the next message made it again and recorded it.
  * Daemon log: no warnings or errors. Scratch repos, home and transcripts removed after.
* Review fixes, a second scratch daemon the same way:
  * `thread new --project api --new-worktree --branch feat/r`, then `git switch -c other` in
    its worktree. `thread new --project api --new-worktree --branch feat/r` and, with the
    first thread as the creator, `thread new --new-worktree --branch feat/r` were both
    refused: "api's worktree for feat/r at …/api/feat-r has other checked out now; thread
    owner (s-…) works in it; switch it back to feat/r, or pick another branch".
  * An in-place thread with `--projects web,api` in a user worktree `web-mine`, stopped,
    `thread run-in --project api`, `web-mine` removed: the next message started the thread,
    web recorded as its own checkout, the log line and the timeline note written.
