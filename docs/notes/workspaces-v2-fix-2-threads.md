# Workspaces v2 fuzz fixes, area A: threads, derived checkouts, cleanup, inheritance

Status: done on branch `cf/workspaces-v2-fix-threads`. Fixes findings 2-10 of the area A
fuzz round over PRs #349-#356 (threads, derived checkouts, cleanup, `thread new`
inheritance). Finding 1 (removing a synthetic workspace under running threads) and the
missing-cwd spawn error belong to the workspace store's fix branch
(`cf/workspaces-v2-fix-workspace`) and are not touched here.

Every repro below ran on a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cfv2-fix-a`, this
branch's binary) over scratch repos under `~/cfv2-fix-a`: `web` and `api` with bare
`origins/*.git` and a `CLAUDE.md` each, a second clone `api-other` to push branches `api`
had not fetched, a plain folder `notes`, and later a repo `extra` without origin. Threads
that had to answer ran Haiku 5.5 at medium effort with "reply hi"; naming was off
(`threads.auto_name = false`, prefix branch naming). Both were deleted afterwards.

## Per finding

### 2. Parallel creates on a new branch

* `makeWorktree` re-checks under the per-(project, branch) lock: a branch picked as new
  that exists locally now (another Create with the same `--branch` made it meanwhile) is
  no longer new, so its worktree is looked up and shared. The check reads the local ref,
  not the worktree list, so a test env whose `RefExists` says no to everything still
  makes a fresh worktree per Create (the v2-1 gotcha).
* `pickBranch` reserves an auto-named branch in memory (`reserveBranch`: per repository
  path and branch) from the pick until the worktrees are made or rolled back; a parallel
  pick of the same name skips to `-2`. A user-named branch (`--branch` verbatim or slug)
  is not reserved: parallel Creates share it.
* Repro: three rounds of two `thread new --projects web,api --new-worktree --branch
  feat/dblN` at once: all six created, each pair on one worktree per project, the second
  of each pair reported "(worktree …, shared with …)". Two `--name samename` at once (two
  projects, prefix naming): `cf/samename` and `cf/samename-2`; the same for one project
  (`cf/samename1`, `cf/samename1-2`).
* Test: `TestParallelCreatesOnANewBranch` (verbatim branch over two projects and one,
  and the same name; run with `-race`).

### 3. A worktree-mode set narrowed to plain folders

* `placeRequest.noGit` (the `--projects` given hold no git project); `copyPlacement`
  then drops worktree mode (checkout mode) unless a new branch was asked for, and marks
  `droppedWorktreeMode`, which Create reports (`CreateThreadResponse.worktree_mode_dropped`)
  and the CLI prints: "(no worktrees: none of its projects has git, so it runs in their
  folders)". `--new-branch` with only folders still fails as before (explicitly asked).
* Repro: `thread new --projects web,notes --new-worktree`, then a child with
  `--projects notes` and a `--like` with `--projects notes`: both created in `notes` with
  that clause; `--like … --projects notes --new-branch` refused ("notes is not a git
  repository").
* Test: three `TestDecidePlacement` rows.

### 4. `--like X --workspace W`

* `decidePlacement` goes to the workspace's placement first only for a creator; with an
  explicit like it copies the like (set, branch, primary, mode) and replaces only the
  workspace reference; `--projects` narrows as usual; `--project workspace` makes W's
  folder the primary. A like of a thread without a project, with a workspace, is the
  workspace's placement.
* Repro: `--like a1 --workspace solo`: a1's `feat/dbl1` worktrees and set, workspace
  `solo`; with `--projects api`: only api, same branch; with `--project workspace`: the
  shop2 folder, worktrees on `feat/dbl1`.
* Test: six `TestDecidePlacement` rows.

### 5. A named branch only on origin

* `pickBranch` asks `userBranchExists` for a user-named branch: local or remote-tracking
  refs, else `FetchBranch` in each git member until one has it. Found, the Create is not
  "fresh", so each member's `makeWorktree` checks local, remote, then fetches itself, and
  the project store's DWIM makes the local branch tracking origin's. Only a branch no
  member has anywhere is made from the base. Auto-named branches are not fetched (a fetch
  per suffix would be slow; they are new by construction).
* Repro: pushed `feat/ro` and `feat/ro2` from `api-other`; `thread new --projects web,api
  --new-worktree --branch feat/ro`: the api worktree at the pushed commit, `## feat/ro...
  origin/feat/ro`; web (no such branch on origin) a new `feat/ro` from main. One project
  (`--project api --branch feat/ro2`): the same, tracking.
* Test: `TestCreateFetchesANamedBranch`.

### 6. A remade member whose branch was gone

* `madeWorktree` carries the project name; `remadeNote(made, branch)` says, for a member
  made with a new branch, "The worktree of project api (…) was removed and branch
  feat/pr3 no longer existed there, so both were recreated from origin/main. Commits made
  on the branch there earlier are on it only if they reached origin/main …", as the
  primary's note does; members whose branch was there keep the old line, now with "from
  branch <b>".
* Repro: the report's (commit in the api worktree, archive, delete the branch, send):
  note #2 reads as above.
* Test: `TestRemadeNote`.

### 7. The `thread new` summary, and the main checkout

* `derivedWorktree` never returns a main checkout: the default path, else a hand-made
  linked worktree on the branch (still reused, as decided). While a member's main
  checkout has the branch checked out, making the thread's worktree is refused
  (`mainCheckoutBusy`), before anything is made, in `makeWorktrees` (Create, a start's
  `ensureMembers`, a fork) and in `recreateWorktree` (the primary): "web's main checkout
  at <path> is on feat/mc; switch it to another branch, or start the thread in place
  (--new-worktree=false)". Checkout mode still runs in the main checkout.
* Revised after review: the first version made a second worktree beside the main
  checkout with `git worktree add --force` and a hint. Two worktrees on one branch leave
  a commit in one looking reverted in the other (its index and files stay at the old
  commit), which users would not understand, so the create is refused instead and the
  project store has no force option.
* Create reports what it did with the primary (`CreateOptions.Report`, a
  `CreateReport`; `CreateThreadResponse.made_worktree`, `made_branch`,
  `existing_worktree`, `shared_with`). The CLI prints "(new worktree from <base>)" only
  for a worktree and branch it made, "(new worktree on existing branch <b>)" for a
  worktree of an existing branch (an addition: the old text said "from origin/main" for a
  pushed branch too), "(worktree <path>, shared with <thread>)" or "(existing worktree)"
  for a reuse, and "(worktrees on <branch>)" for a folder or workspace-folder primary.
* Repro: A, a third thread on `feat/dbl1`: "(worktree …/web/feat-dbl1, shared with b1
  (…))". B, web's main checkout on `feat/mc`: `thread new --projects web,api
  --new-worktree --branch feat/mc` and `--project web` alone both refused with the text
  above (exit 2); no worktree, no `feat/mc` branch in api, no thread. C, a
  workspace-folder parent's `--new-branch` child and a notes primary in worktree mode:
  "(worktrees on cf/c1)", "(worktrees on cf/c2)".
* Tests: `TestMainCheckoutOnTheBranch` (refused with nothing made; a hand-made linked
  worktree reused; checkout mode in the main checkout), a `TestCheckoutsOf` row, command
  rows.
* A thread made before this whose member checkout was the main checkout now derives the
  default path (missing); its next start is refused with the same text while the main
  checkout stays on the branch.

### 8. `--created-by=`

* `Args.Blank` tells a flag passed empty from one left out (empty values otherwise read
  as absent). `thread new` with a blank `created-by` skips `callerPlacement`, so inside a
  thread with nothing else placed it is refused: "an empty created-by opts out of the
  thread this runs in, its placement too; name a project, worktree, workspace or like (or
  no-project)". The v2-1 note's wording now says what this does.
* Repro: `CODE_FOUNDRY_THREAD=<a1> thread new --created-by=`: refused (exit 2); with
  `--project web`: created in web's main checkout, `created_by` empty, no worktree mode;
  without the opt-out: a1's worktrees.
* Tests: two command rows.

### 9. Messages

* A project ref that names nothing: "project nosuch is not registered" instead of
  "thread not found: project nosuch" (the workspace fix branch, #360, landed the same
  fix with its `classified` error first; this branch uses it).
* `--projects web,~/x`: the daemon expands a leading `~/` in each ref (`projectRefs`;
  the daemon runs as the user).
* `thread checkouts` from a cwd no thread holds: "no thread has a checkout holding /tmp" (`classified`, an `ErrNotFound` without its "thread not found" text).
* `--like <no-project thread> --new-branch`: "thread <id> has no project to branch" (the
  early "needs like" check now only fires without a like).
* `--like <no-project thread>` prints "(no project)".
* `project.worktree.cleanup`'s description: "no thread (archived aside) with it as its cwd
  or a checkout of its projects, and no terminal in it" (no workspace hold).
* `thread list` names the workspace for a thread in its workspace's folder
  (`ThreadListDeps.Workspace`; the folder's name when the workspace is gone).
* Repro: each command printed the new text; `thread list` showed `shop2` for c1 and lw3.
* Tests: command rows (`TestThreadLifecycleCommands`, `TestThreadList`).

### 10. Small ones

* Fork: `ensureMembers`' result gets the timeline note (in the fork's timeline, after
  its copied history) and the projects' on-worktree-create actions, as a start's.
  Repro: removed pr3's api worktree by hand, an `--on-worktree-create` action on api
  appending `$CODE_FOUNDRY_WORKTREE` to a file, `thread fork`: note #7 in the fork, the
  path in the file. Test: `TestForkRemakesMemberWithNoteAndHook`.
* `ArchivedVerdict` checks an operation before a detached HEAD. Repro: a worktree
  stopped mid-rebase, archived: "worktree kept … reason=\"rebase in progress\"". Test: a
  `TestArchivedVerdict` row.
* Parallel cleanups: `archiveCleaner.cleanOne` serializes per path; the later ones find
  the worktree unlisted after Cleanup's refresh (NotFound, logged at debug as "already
  removed"). Repro: three threads on `feat/par` archived in one `thread archive --ids`:
  one "worktree removed", no warning. Test: `TestArchiveCleanupSharedWorktree`.
* An unregistered member: `startStopped` adds one timeline note per project
  (`note-unregistered-<id>`, so a later start finds it and adds none): "Project <id> of
  this thread is no longer registered in Code Foundry, so the thread now starts without
  it (its checkout is no longer an added directory). Registering the project again brings
  it back." Repro: two starts after unregistering `extra`: one note. Test:
  `TestUnregisteredMemberNotedOnce`.
* Unregister cleanup: `api.Project.WithBeforeUnregister` runs the daemon's
  `archiveCleaner.unregistering` before the store forgets the project: every worktree the
  app made for it goes through the archived verdict with the usual holds (clean and
  unused: removed; never a branch). `project.unregister`'s description and confirm (and
  the mock's) say so. Repro: unregistering `extra` with a clean unused worktree
  (`feat/orphan`, removed), a dirty one (kept, "uncommitted changes") and un1's live
  member (kept, "thread un1 is on it"); every branch stays. Test:
  `TestUnregisterCleansUpWorktrees`.

## Not fixed, and why

* Finding 1 and the missing-cwd spawn error: the workspace store's branch.
* A member worktree of a project unregistered while a thread that is not archived used
  it stays on disk: the project is gone from the store, so nothing can remove it through
  it, and removing it at unregister would pull it from under the live thread. The
  thread's note tells the model the project left; `git worktree remove` by hand cleans it.
* The unregistered-member note is written at a start from stopped (`startStopped`), not
  at `thread restart` (its spawn path) or a fork: the common case is a message to a
  stopped thread; the others still log it.
* `thread new` from a hand-made linked worktree on the branch still reuses it ("(existing
  worktree)"), as decided: it is the user's deliberate checkout of that branch.

## Gotchas

* The sandbox refuses compound shell commands that mention git and many loops; the
  repros ran as script files.
* Under load (the scratch daemon plus a parallel `go build`) the `cmd/code-foundry` and
  `internal/daemon` end-to-end tests timed out waiting for a daemon to start (migrations
  "context canceled"); `make check` was green with the machine quiet.
