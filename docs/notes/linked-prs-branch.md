# Linked PRs include the worktree branch's pull requests (2026-10-20)

PR 2 of 2 (PR 1: `linked-prs-children.md`, #260). A thread's `LinkedPullRequests` now also
hold every pull request whose head is a branch the thread works on, in the thread's
project repository, with `source = 'branch'` (reserved by PR 1). Daemon only: no
migration, no API, CLI or GUI change; the proto change is a comment.

## Decisions

From the brief (agreed with Alex):

* **Which branches.** A project thread: the branch its worktree has checked out now
  (`project.Worktree.Branch`), or the thread's own `Branch` when the worktree is gone. A
  workspace thread: every member worktree's branch, not only the cwd's. The repository
  is the project's `GitHubSlug`, matched case-insensitively; no slug, no links.
  Archived threads are skipped.
* **No new polling and no new watches.** The pull requests come from what the GitHub
  store already caches: the dashboards (authored, review requested, reviewed, merged in
  the last 7 days) and every branch list in its cache (the worktree panel's
  `BranchPullRequests` asks put them there). Nothing calls `BranchPullRequests`, which
  would start a watch. Every state counts (open, merged, closed).
* **Same rules as every link.** Through `linkPullRequests`: deduplicated by URL, a URL
  the thread already has keeps its row and source (so Claude's own `claude` row stays),
  first-seen order, never removed, one `Updated` per changed thread, copied up the
  `CreatedBy` chain as `child` (PR 1). `LinkedAt` is the pull request's `CreatedAt`, now
  when the cache does not know it.

Decided while building:

* **Push, not a lookup option.** `thread.Manager.LinkBranchPullRequests(id, links)` (new,
  `prlink_branch.go`) tags the links `branch` and hands them to `linkPullRequests`. The
  daemon does the rest (`internal/daemon/linked_prs_branch.go`). A
  `thread.Options.BranchPullRequests` lookup would have needed the thread store to know
  when to look (gh, project and workspace events) and how to find a thread's branches
  (project and workspace snapshots); the daemon already composes those stores and
  subscribes to their events, so with a push the thread store learns one method and
  nothing about the others. Same boundary as `wake_pr.go`.
* **One read of the cache per pass.** `gh.Store.CachedPullRequests()` (new, beside
  `CachedPullRequest`) returns the dashboards and branch lists, one copy per pull
  request (`cachedByRef`, which wake subscriptions already use). The daemon indexes
  them by (repository, head branch) once, then walks the threads; a thread's branches
  are map lookups. Nothing per thread hits GitHub.
* **A pass that finds nothing new calls nothing.** The daemon compares with each
  thread's snapshot links before calling the thread store, so the common pass takes no
  thread store lock and publishes nothing.
* **When a pass runs.** Once at start (from the cache the GitHub store loaded), and
  200 ms (`branchLinkDelay`) after the first of a burst of events that may change the
  answer: `gh.DashboardUpdated`, `gh.BranchPullRequestsUpdated`, `thread.Updated` (a
  new thread, a moved cwd), `project.ProjectUpdated` and `project.WorktreeUpdated` (a
  branch switch), `workspace.Updated` (a member added). The brief only required the gh
  events; the others were cheap given the no-op pass, and without them a new thread on
  a branch whose pull request is already cached would wait for the next dashboard
  change, which only comes when GitHub's data changes. `project.WorktreeFilesChanged`,
  thread item events and `gh.Polled` do not trigger a pass.
* **Oldest thread first.** The pass pushes threads in `CreatedAt` order. The first e2e
  run pushed in id order and a grandchild on the same branch went first: its copy
  reached the child (`child` via the grandchild) before the child's own link, so the
  child's row said `child`. A creator always predates what it created, so creation
  order gives every thread on the branch its own `branch` row and the creator's copies
  are no-ops.
* **Fork pull requests are left out.** A pull request from a fork has the base
  repository as `Repo` and a head branch in another repository (`IsCrossRepository`);
  `main` on someone's fork is not the thread's `main`. Placeholders (`Partial`) have no
  head branch yet and are skipped until their detail arrives (a `DashboardUpdated`
  follows it).
* **A detached worktree has no branch**: it contributes nothing, and does not fall back
  to the thread's `Branch` (the fallback is for a worktree that is gone). A workspace
  member whose worktree is gone uses the workspace's branch, as `workspace.Join` does.
  A workspace thread whose workspace is gone is treated as a project thread.
* **The slug stored** is the lower-case project slug (the GitHub store's key); the URL is
  GitHub's. Dedup is by URL, as everywhere.
* **The proto comment** on `Thread.linked_pull_requests` now names all three sources;
  `LinkedPullRequest`'s comment no longer says "Claude linked" and says what `linked_at`
  is for each source. `make gen` regenerated the comment in the Go and TS outputs.

## What changed

* `internal/store/thread/prlink_branch.go` (new): `LinkBranchPullRequests`.
* `internal/store/thread/prlink.go`, `thread.go`: comments (`LinkBranch` no longer
  reserved).
* `internal/store/gh/pr_watch.go`: `CachedPullRequests`; `ghtest` fake has it too.
* `internal/daemon/linked_prs_branch.go` (new): `prsByHead`, `threadBranches`,
  `branchLinksFor`, `linkBranchPullRequests`, `wakesBranchLinks`, `startBranchLinks`;
  wired in `stores.go` after the project activity glue, stopped with the other glue.
* `proto/codefoundry/v1/thread_lifecycle.proto` (comments) and its generated code.
* `docs/ARCHITECTURE.md`: the linked pull requests bullet.

## Tests

* `internal/daemon/linked_prs_branch_test.go`:
  * `TestBranchLinksFor` (table): project thread on the worktree's current branch, not
    the one it was made for; the main checkout's branch; worktree gone falls back to
    `Thread.Branch`; gone with no branch recorded; detached worktree; every pull request
    of the branch oldest first in any state; workspace thread on every member's branch;
    a member that switched branches; a member whose worktree is gone (workspace branch);
    workspace gone; slug case (`O/Web` against `O/WEB`); same branch in another
    repository; no GitHub slug; no project; oldest thread first whatever its id;
    archived thread skipped; already linked URLs not offered again (a thread with
    nothing new left out); fork pull requests, placeholders and links without a URL
    left out, no creation time gives now.
  * `TestStartBranchLinks` (`ghtest` store, a fake linker publishing `thread.Updated`
    like the real one): the startup pass links the cached dashboard; a cached branch
    list links its pull request; a repeat of both calls nothing; a new thread on another
    branch is linked without a gh event; a worktree switching branches is linked on the
    project event.
  * `TestWakesBranchLinks`: which events trigger a pass.
* `internal/store/thread/prlink_branch_test.go` (real `Manager`):
  `TestLinkBranchPullRequests` (table: links tagged `branch` whatever the caller set; a
  repeat adds nothing and publishes nothing; a URL Claude linked keeps `claude`; reaches
  the creator and its creator as `child` via the direct child; a later Claude record
  keeps the `branch` row; `Updated` counts per thread; all re-checked after a restart)
  and `TestLinkBranchPullRequestsEdges` (unknown thread, no links, no time gives now, the
  caller's slice not written).
* `internal/store/gh/pr_watch_test.go`: `TestWatchPullRequests` checks
  `CachedPullRequests` returns the dashboard's and the watched branch's pull requests
  once each.

## Verified

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, frontend
  typecheck, lint, 4906 vitest tests).
* End to end, 2026-10-20: `make build`, the binary copied to `/tmp/cf-lpb/bin`, run
  through a wrapper that unsets every `CLAUDE*` and `CODE_FOUNDRY_*` variable and sets
  `CODE_FOUNDRY_HOME=/tmp/cf-lpb/home`; `daemon --dev`. Every PR branch merged this week
  is checked out in some other worktree, so the scratch worktree started detached and
  switched with `--ignore-other-worktrees` (read only; no commit was made there).
  Threads had no prompt, so no Claude session was needed.

```
$ git -C ~/projects/code-foundry worktree add --detach ~/cf-lpb-scratch/wt 3c24cba8
$ cf project add ~/projects/code-foundry
registered code-foundry (b1080fe9fff5)
# daemon log: gh poll ... searches=4 details=50 (the dashboards, merged #260 among them)
$ cf thread new --no-project --name "lpb parent" --created-by= --model 'claude-haiku-5-5[1m]' --effort medium
created thread lpb parent (s-df25aa91d849) in /Users/alex (no project)
$ cf thread new --project b1080fe9fff5 --worktree ~/cf-lpb-scratch/wt --name "lpb child" --created-by s-df25aa91d849 ...
created thread lpb child (s-c6084166d9df) in /Users/alex/cf-lpb-scratch/wt
```

  1. Detached worktree: no rows in `thread_pull_requests`.
  2. `git -C ~/cf-lpb-scratch/wt checkout --ignore-other-worktrees cf/linked-prs-children`:
     within 2 s the log had `linked pull requests from thread branches links=1` and the
     table (sqlite3, `thread_pull_requests` joined to `threads` for names):
     `lpb child|260|branch||2026-10-20T06:49:25Z` and
     `lpb parent|260|child|lpb child|2026-10-20T06:49:25Z` (#260's creation time; it
     merged at 06:50:02Z). `thread get --id <id> --json` listed
     `{slug: alexwaumann/code-foundry, number: 260, url: …/pull/260, linkedAt:
     2026-10-20T06:49:25Z}` for both; `thread list` showed the child as
     `code-foundry@cf/linked-prs-children ↳ lpb parent`.
  3. `lpb grandchild` (created by the child) and `lpb archived` (no creator) made on the
     same worktree: each had #260 `branch` within 2 s of `thread new`, from the thread
     event alone. The child's row stayed `branch`.
  4. `thread archive` on `lpb archived`, then the worktree switched to
     `cf/sidebar-footer-edge` (#258): the grandchild got #258 `branch`, the archived
     thread nothing. The child got #258 as `child` via the grandchild: the id-order bug
     fixed above (oldest thread first), with a test.
  5. The rebuilt binary: daemon stopped (SIGTERM) and started again. 7 rows before and
     after, no `linked pull requests` line: the startup pass found nothing new.
  6. Worktree switched to `cf/dirty-worktree-confirm` (#257): `links=2`; child and
     grandchild #257 `branch`, parent #257 `child` via the child (2026-10-19T22:20:33Z),
     before any poll after the restart (the dashboard came from the cache).
  7. No WARN or ERROR lines in either daemon log. Threads removed, daemon stopped, the
     scratch worktree removed with `git worktree remove`, `/tmp/cf-lpb` deleted. No
     Claude transcript was written.

Not verified live: a workspace thread (covered by `TestBranchLinksFor`), and a branch
list that only the worktree panel put in the cache (no GUI ran; covered by
`TestStartBranchLinks` against the fake).

## Gotchas

* With no GUI the GitHub poll runs every 15 minutes (`tier=none`); registering a project
  brings one poll forward, which is what loaded the dashboards here.
* Dedup is by exact URL. Claude's pr-link URL and GitHub's are both GitHub's canonical
  form; a hand-written URL in another case would be a second link.

## Daemon restart

Needed: the glue runs in the daemon. The startup pass then links every live thread's
branch pull requests from the cache at once. The GUI is unchanged.
