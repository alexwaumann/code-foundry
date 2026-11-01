# Branch links leave out the default branch (2026-11-01)

A user saw a thread on `master` (project folder) carry a gray "+2" PR tag after every
start; it turned purple only once clicked. The two links were branch links
(`linked-prs-branch.md`): pull requests whose head was `master` itself. Work merges into
the default branch, so a pull request *from* it (master into a release branch, say) is
not the thread's work. Being old and merged, neither was on the dashboard (merged in the
last 7 days only), so the tag read them as unknown (`sidebar-pr-tag.md`) until the click
read their details.

## Decisions

* **The default branch is not a thread branch.** `threadBranches` skips a checkout whose
  head is its project's `DefaultBranch`, including the gone-worktree fallback to the
  thread's recorded branch. Claude's own pr-link records and child copies are unchanged:
  a PR Claude opened from a master thread still links.
* **Unknown default branch: the project waits.** `DefaultBranch` is empty until the
  project's first reconcile after a daemon start, and the first branch-link pass runs
  before it. A project with a slug but no default branch yet contributes nothing; the
  `ProjectUpdated` that follows the reconcile runs another pass.
* **Branch links record their head** (`thread_pull_requests.head`, migration 0052;
  `LinkedPullRequest.Head`, not on the API). Child copies carry none.
* **Old links are pruned once** (agreed with Alex: "prune once"). A branch row with no
  head was made before this change. `internal/daemon/linked_prs_branch_settle.go` runs
  with each branch-link pass: the head comes from the GitHub store's cached lists, else
  from one `gh.Store.PullRequest` read per pull request per daemon run (its cached
  detail when fresh), serially in a goroutine whose result triggers a pass. Head equals
  the project's default branch and not from a fork: `thread.Manager.SettleBranchLinks`
  drops the row and each child copy up the CreatedBy chain (at each hop only the
  `child` row that came through the thread below; a Claude row there stays and ends the
  chain). Otherwise the head is recorded and the link is never looked at again. A failed
  read leaves the row for the next start. A link whose repository has no project left
  keeps its head (nothing to compare with). Archived threads are settled too.
* **The sidebar tag is unchanged.** Feature-branch PRs merged more than 7 days ago still
  read unknown (neutral) until something reads their detail; that is
  `sidebar-pr-tag.md`'s documented gap, not this one.

## Tests

`TestBranchLinksFor` (default branch left out, also as a recorded branch; unknown
default branch links nothing; fixtures now have default branch `trunk` so `main` cases
still link), `TestSettleBranchLinksDecisions`, `TestStartBranchLinksSettlesOldLinks`
(cached head, read heads, a failed read, waiting for the default branch),
`thread.TestSettleBranchLinks` (drops up the chain, Claude row stops it, heads survive a
restart, settled links untouched).
