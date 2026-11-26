# pull_request_changed carries the shown row; the GUI merges only what changed

Since #898 the GUI patches its dashboard, branch-list and detail caches from the
`pull_request_changed` event, and since #903 the daemon's local overlay
(`internal/store/gh/pr_merged_overlay.go`) shows the user's own close, reopen, draft/ready and
review decision before GitHub's search index has them. The event carried the poll's raw row,
without the overlay, and the GUI replaced the cached row (and `detail.pullRequest`) with it,
guarding only merged → open. So a Close or Ready for review clicked while a poll was in flight,
when that poll reported another change on the pull request (checks, a title), flipped the panel
back to Open or Draft with the button live again, until the next detail read (up to 60 s); and
the detail lost `mergeable`, `mergeStateStatus` and review fields to the summary's values.

## The fix

- **Daemon: the event says what clients are shown.** `gh.PullRequestChanged` gains `Shown`: the
  poll's row with the overlay's marks on it (`localShown.applyPullRequest`, set in `applyPoll` just
  before publishing, after this poll confirmed or expired marks). It is the row `GetDashboard` and
  `BranchPullRequests` return. `internal/api/gh_changes.go` sends `Shown` to every client (the GUI,
  `events --json`, plugin feeds, `GhService.Watch`); an event without it (a fake's) sends
  `PullRequest`. No proto change.
- **Daemon consumers are untouched.** `PullRequest` and `Changes` still say what the poll saw. The
  thread store's wake matching reads both (`prAlreadyMet` and `prCannotFire` read the row's state:
  `subscriptions_pr.go`); `wake_pr.go` maps `PullRequest`; `plugin_checks.go` reads `Changes`
  only; `github_notifications.go` does not subscribe to the event at all (it follows
  DashboardUpdated). Had the Go row become the overlaid one, a `--until merged` or `closed`
  subscription would fire (or be ended as unable to fire) on the first unrelated poll event after a
  local mutation, instead of when GitHub shows it, which the overlay's own design note rules out.
- **GUI: merge only the fields the event speaks for.** `toGhEventView` maps the change kinds
  (`changes`). `patchPullRequestInCaches` copies from the event's row only the fields its kinds name
  (`CHANGED_FIELDS`: merged → state and merged time, checks → checks, draft → draft and merge
  state, ...), bumps `updatedAtMs` only forward, and returns the same objects when nothing it names
  differs, so a row, a list and the entries map keep their identity for pull requests that did not
  change. The merged → open guard is gone: state is now written only on a merged, closed or
  reopened change, from the overlaid row.
- **GUI: the detail cache is not patched.** The client cannot tell whether its detail copy is older
  or newer than the poll; the daemon can (`applyPollAt` compares the copy's fetch with the poll) and
  already says so: it publishes `pull_request_detail_updated` for a copy the poll moved, before the
  `pull_request_changed`. The detail follows that alone.

## What patching buys (measured by reading, not timing)

`applyPoll` publishes `PullRequestDetailUpdated` (`staleFullDetails`), `DashboardUpdated` and
`BranchPullRequestsUpdated` before the `PullRequestChanged` loop, so the GUI starts the same
re-reads either way:

- Dashboard and branch lists: the re-reads answer from the daemon's published (overlaid) lists, the
  same rows the patch writes. The patch shows them one local round trip earlier, nothing more.
- Detail: a copy the poll moved is re-read at once and answered with the old copy marked
  refreshing (`staleFirst`), which replaced the patch until GitHub's fetch landed: new, old, new. A
  copy newer than the poll got no re-read, so the patch was what regressed it. Dropping the detail
  patch costs nothing that stuck, and removes both.

So the in-place patch is kept for the lists (small, now safe, keeps identity) and could be removed
without a visible loss; this fix does not remove it.

## Gotchas

- `Shown` can disagree with `Changes`: a `DRAFT` change (old false, new true, as the poll saw it)
  with `pullRequest.draft` false because the user marked it ready here. The plugin events reference
  says so.
- A closed or merged summary has no review fields; a kind-named copy never touches them unless a
  review kind is in the event (only reported when both sides are open with the detail).
- `TestPullRequestChangedShowsLocalOverlay` simulates the poll in flight by putting the fake
  GitHub's row back to its pre-mutation value (and renaming it, so the poll has a change to
  report) after the mutation.
