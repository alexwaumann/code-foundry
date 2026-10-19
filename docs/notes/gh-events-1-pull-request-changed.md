# gh events 1: pullRequestChanged (2026-10-18)

PR A of three (granular GitHub events; B is per-file worktree events, C the thread wake
target on this event, stacked on this branch). Daemon and CLI only: the GUI ignores the new
event. Poll cadence is untouched (presence tiers and intervals as in
`docs/notes/gh-poll-tiers.md`).

## What is here

| Piece | Where |
|---|---|
| `gh.PullRequestChanged`, `gh.Change`, `gh.ChangeKind` (+ constants, `ChangeKinds`), the diff | `internal/store/gh/pr_changes.go`, called at the end of `applyPoll` (`poll.go`) |
| `PullRequest` refetches a cached detail the poll saw move | `internal/store/gh/detail_moved.go`, the check in `Store.PullRequest`, `invalidateFull` marks too |
| Proto | `GhEvent.pull_request_changed` (`GhEvent.PullRequestChanged`), `PullRequestChange`, `PullRequestChangeKind` in `gh.proto` |
| API | `internal/api/gh_changes.go`, mapped in `Gh.Watch` and the EventService gh source (so `events --json --source gh` and plugin feeds) |
| Fake | `ghtest.Store.ChangePullRequest` |
| pr.checks fact invalidation | `plugin.Manager.InvalidatePullRequestChecks` (`facts.go`), wired in `internal/daemon/plugin_checks.go`; `checksFresh` 60 s → 10 min |
| Skill | `host-api.md`: the payload row, following check runs by subscribing; `manifest.md`: the fact's refetch |

## The Go type (PR C reads it)

```go
type ChangeKind string // "appeared", "merged", "closed", "reopened", "head_pushed", "checks",
                       // "review_decision", "reviews", "comments", "review_requested", "draft", "title"
type Change struct {
	Kind ChangeKind
	OldState, NewState PullRequestState              // merged, closed, reopened
	OldHeadSHA, NewHeadSHA string                    // head_pushed
	OldChecks, NewChecks CheckRollup                 // checks
	OldReviewDecision, NewReviewDecision ReviewDecision // review_decision
	OldCount, NewCount int                           // reviews, comments
	Requested []string; Viewer bool                  // review_requested
	OldDraft, NewDraft bool                          // draft
	OldTitle, NewTitle string                        // title
}
type PullRequestChanged struct {
	Slug string; Number int; URL, HeadRef string
	PullRequest PullRequest // after the change
	Changes []Change        // ChangeKinds order, never empty
}
func (e PullRequestChanged) Has(kinds ...ChangeKind) bool
```

The proto kind is `PULL_REQUEST_CHANGE_KIND_` + the upper-cased Go kind.

## Decisions

* **What is compared.** The lists a poll refreshed: the open dashboards (authored, review
  requested, reviewed), every watched branch polled without error, then recently merged.
  A pull request in several lists is compared once, as the first list holds it on each
  side (open dashboards and branches carry the check rollup in their fingerprints; the
  merged search does not). A pull request new to the refreshed lists but held by a list
  this poll did not refresh (an expired branch watch, a section that failed) is compared
  with that copy, not announced.
* **Only fields both sides have.** A placeholder (`Partial`, detail pending) has state,
  head and, when its list carries them, checks. A closed or merged pull request's summary
  has no review decision, counts or review requests, so those are compared only when both
  sides are open with the detail (`openDetail`): reopening a pull request does not report
  its comments as risen from 0. Counts report only a rise (`reviews`, `comments`);
  `review_requested` only additions.
* **appeared.** A list's baseline is its previous content: a dashboard list that was never
  fetched is nil (a new install, or dashboards turned back on; JSON keeps `[]` vs `null`
  through the cache), a branch list without a fetch time has none. A pull request new in a
  list without a baseline is recorded silently, so a fresh install, re-enabling dashboards
  or a thread opening on a branch with old pull requests announces nothing. After a
  restart the cached lists are the baseline: the first poll announces only real changes
  (`TestPollPublishesPullRequestChanged` restarts on the same cache).
* **appeared waits for the detail.** A new pull request whose detail fetch failed is a
  placeholder (no title, no head ref); its `appeared` waits in `Store.appearing` (worker
  only) until a poll fills it, so every `appeared` carries a full summary. Forgotten if it
  leaves first, and across a restart (rare: a detail failure on its first poll).
* **review_requested** comes from new entries in `ReviewRequests` (`Viewer` when one is
  the viewer's login) or the pull request entering the viewer's review-requested
  dashboard (`Viewer` true, which covers a team request; `Requested` may be empty then).
  With `appeared` it is the only change that can come along.
* **Leaving scope.** A pull request that left every list sends nothing (its state is not
  known). One that left the authored list but shows up merged (recently merged) or closed
  (a watched branch lists every state) sends `merged` / `closed`.
* **Checks** report any change of the rollup, state or counts, with both rollups: a run
  finishing is `oldChecks.state` PENDING → `newChecks.state` SUCCESS/FAILURE. A push brings
  `head_pushed` and, usually, `checks` (the new head's rollup).
* **Order and buffers.** Events go out after the poll's coarse events, before `Polled`,
  sorted by repository and number. Their subscriptions (Watch, EventService, the daemon's
  checks glue) buffer 512, not 64: a poll publishes them back to back, and a dropped
  EventService event only resyncs the gh snapshot, which has no changes in it.
* **pr.checks fact.** `checksCache.invalidate` refetches an entry still cached (used in the
  last 10 minutes), or marks a running fetch to run again (its answer may predate the
  change); a pull request no predicate asked about is left alone. AvailabilityChanged goes
  out when the result differs, as before. The daemon invalidates on `head_pushed` or
  `checks`, and on every `PullRequestDetailUpdated` (a poll staled an open detail panel's
  copy, a merge, a review request).

## Gotchas

* **`gh.Service.PullRequest` did not read the full-detail cache.** The brief assumed the
  plugin fact went through the detail panel's cache (`staleFullDetails`). It reads its own
  SQLite copy (`loadDetail`) with a 30 s `DetailTTL`, which the poll never invalidated: a
  refetch within 30 s of the previous one (60 s fact refresh, 60 s poll) could get the
  copy from before the change. `detail_moved.go` records, per pull request, when the poll
  saw its fingerprint move (or the store changed it); `PullRequest` refetches a copy
  fetched before that. Marks older than `DetailTTL` are dropped (a copy older than them
  is refetched by age anyway). `TestPollMovesCachedPullRequest` fails without it.
* Watched branches are the branches someone asked about in the last 10 minutes
  (`BranchPullRequests`: the GUI's pull request panel, a plugin `pr.*` fact, `pr checks
  --thread`), not every thread's branch. The viewer's own open pull requests are in the
  authored dashboard anyway (the dashboards run once any project is tracked).
* `make gen` regenerates the TS too; nothing in the GUI switches exhaustively over
  `GhEvent`, so it needed no change.

## Tests

* `TestDiffPullRequest`: every kind, updatedAt/size alone, counts falling, withdrawn
  requests, the viewer and a team, placeholders on either side, a rollup-less placeholder.
* `TestPRChanges`: unchanged, appeared, a list's first poll, known elsewhere (compared /
  not appeared), dedupe across lists, leaving scope, leaving for merged, closed on a
  branch, the appearance waiting for its detail (four cases), entering the review list,
  sorting, a placeholder's repository and head from its branch.
* `TestPollPublishesPullRequestChanged` (fake GitHub, real store): no events on the first
  polls, checks (one event for a pull request authored and on a watched branch), a push,
  a review, a new pull request, the viewer asked to review, merged, closed out of scope,
  then a restart on the same cache announcing nothing and the next change after it.
* `TestPollMovesCachedPullRequest`; `TestPullRequestChangeToProto` (every kind sets only
  its values; proto and Go kinds match); `TestPullRequestChangedJSON` (the protojson);
  `TestGhWatchPullRequestChanged`; `TestEventsPullRequestChanged`;
  `TestRunEventsPullRequestChanged` (the CLI's `--json` line);
  `TestInvalidatePullRequestChecks` (unknown pull request, invalidated mid-fetch, same
  checks, different checks); `TestPluginChecksFollowGhEvents` (the daemon glue).

## End to end
