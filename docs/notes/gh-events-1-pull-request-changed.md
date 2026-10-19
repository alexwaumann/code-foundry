# gh events 1: pullRequestChanged (2026-10-18)

PR A of three (granular GitHub events; B is per-file worktree events, C the thread wake
target on this event, stacked on this branch). Daemon and CLI only: the GUI ignores the new
event. Poll cadence is untouched (presence tiers and intervals as in
`docs/notes/gh-poll-tiers.md`).

## What is here

| Piece | Where |
|---|---|
| `gh.PullRequestChanged`, `gh.Change`, `gh.ChangeKind` (+ constants, `ChangeKinds`), the diff | `internal/store/gh/pr_changes.go`, called at the end of `applyPoll` (`poll.go`) |
| `PullRequest` refetches a cached detail the poll saw move (what keeps the `pr.checks` command fresh after an event) | `internal/store/gh/detail_moved.go`, the check in `Store.PullRequest`, `invalidateFull` marks too |
| Proto | `GhEvent.pull_request_changed` (`GhEvent.PullRequestChanged`), `PullRequestChange`, `PullRequestChangeKind` in `gh.proto` |
| API | `internal/api/gh_changes.go`, mapped in `Gh.Watch` and the EventService gh source (so `events --json --source gh` and plugin feeds) |
| Fake | `ghtest.Store.ChangePullRequest` |
| `pr.checks.*` fact invalidation (the `when` predicates' cache only) | `plugin.Manager.InvalidatePullRequestChecks` (`facts.go`), wired in `internal/daemon/plugin_checks.go`; `checksFresh` 60 s → 10 min |
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
* **pr.checks fact.** This is the plugin store's cache of the `pr.checks.*` facts that
  `when` clauses read, nothing else: the `pr.checks` command (`commands_pr_checks.go`,
  through `GhService.GetPullRequest`) reads `gh.Service.PullRequest` directly, and its
  freshness after an event is `detail_moved.go`'s (gotcha below). The fact's own fetch
  (`pluginFacts.PullRequestChecks`) goes through `gh.Service.PullRequest` too, so it needs
  both. `checksCache.invalidate` refetches an entry still cached (used in the
  last 10 minutes), or marks a running fetch to run again (its answer may predate the
  change); a pull request no predicate asked about is left alone. AvailabilityChanged goes
  out when the result differs, as before. The daemon invalidates on `head_pushed` or
  `checks`, and on every `PullRequestDetailUpdated` (a poll staled an open detail panel's
  copy, a merge, a review request).

## Gotchas

* **`gh.Service.PullRequest` did not read the full-detail cache.** The brief assumed the
  plugin fact went through the detail panel's cache (`staleFullDetails`). `PullRequest`
  (what the `pr.checks` command reads and the fact fetches through) reads its own
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

2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cf-ghev-home`, the branch binary through a
wrapper that unsets every `CLAUDE*` variable, `daemon --dev`. This repository registered,
a thread on this worktree (`thread new --project code-foundry --worktree <this worktree>
--created-by=`, no prompt), `pr checks --thread <id>` to watch its branch. A daemon
without a GUI polls every 15 minutes, so a scratch program (not committed) held an
EventService stream open as a visible GUI client: the poll ran every 60 s. Then `events
--json --source gh`, pushing to this pull request (#210) and letting CI run.

* The first full poll (51 details, nothing cached) sent no `pullRequestChanged`.
* Every poll sent at most one event for #210, though it was in the authored dashboard and
  on the watched branch (`branches=1` in the poll log).
* The changes, in order (seq, kinds; `oldChecks` → `newChecks` abbreviated):
  ```
  16  head_pushed 80649937 → 1b8930b8                  (the note commit pushed)
  28  head_pushed 1b8930b8 → 4a3d1bae, checks {} → PENDING 1/1 pending   (rebase, force push)
  40  checks PENDING 1 pending → PENDING 1 passed 3 pending   (the CI jobs registered)
  52  #211 appeared                                     (another thread opened a pull request)
  139 checks PENDING 1 passed 3 pending → PENDING 3 passed 1 pending
  234 checks PENDING 3 passed 1 pending → SUCCESS 4 passed
  ```
  The last one in full:
  ```json
  {"gh":{"pullRequestChanged":{"repoSlug":"alexwaumann/code-foundry","number":210,
   "url":"https://github.com/alexwaumann/code-foundry/pull/210","headRef":"cf/gh-events-1-pull-request-changed",
   "pullRequest":{"repoSlug":"alexwaumann/code-foundry","number":210,"title":"gh: pullRequestChanged events (granular PR changes per poll)",
    "author":"alexwaumann","headRef":"cf/gh-events-1-pull-request-changed","headSha":"4a3d1baedec13cfa62fdfa97ce6329cccbef81b6",
    "baseRef":"main","mergeable":"MERGEABLE_MERGEABLE","mergeStateStatus":"MERGE_STATE_STATUS_CLEAN",
    "headRepoSlug":"alexwaumann/code-foundry","url":"https://github.com/alexwaumann/code-foundry/pull/210",
    "updatedAt":"2026-10-19T01:13:24Z","checks":{"state":"CHECK_ROLLUP_STATE_SUCCESS","total":4,"passed":4},
    "state":"PULL_REQUEST_STATE_OPEN","createdAt":"2026-10-19T01:07:48Z","additions":2644,"deletions":387,
    "changedFiles":25,"baseSha":"40a720b1fbc73465b25028e9bde3cb9e668d5a37"},
   "changes":[{"kind":"PULL_REQUEST_CHANGE_KIND_CHECKS",
    "oldChecks":{"state":"CHECK_ROLLUP_STATE_PENDING","total":4,"passed":3,"pending":1},
    "newChecks":{"state":"CHECK_ROLLUP_STATE_SUCCESS","total":4,"passed":4}}]}},
   "seq":"234","epoch":"880fae4a9c0e"}
  ```
* `pr checks --thread <id>` listed the run's jobs (through `gh.Service.PullRequest`, the
  plugin fact's read); `plugin list` unchanged (no plugins); no WARN or ERROR in the
  daemon log.
* GitHub had marked the pull request `CONFLICTING` after the first push (main had moved),
  and CI does not run on a conflicting pull request: no checks until the rebase.
