# gh store: poll-confirmed PR details, closed-PR TTL, 25 PRs per watched branch

Status: done on `cf/gh-detail-confirm` (PR #152). `make check` is green. Run end to end
with two scratch daemons side by side (old and new binary, `CODE_FOUNDRY_HOME` under
`/tmp/cfdc`, `daemon --dev`, default 60 s poll) on Alex's account.

## What changed

* **A poll confirms the detail entries it saw unchanged.** `applyPoll` already passed
  every fingerprint to `staleFullDetails`. `fullCache.applyPoll` (was `staleMoved`) now
  also sets `fullEntry.confirmed = now` on each fresh entry whose fingerprint did not
  move; a moved one goes stale and is announced, as before.
* **`fullEntry.serves`** decides a cache hit: not stale, and either younger than its age
  limit, or confirmed within `confirmWindow` (1.5 poll intervals) and younger than
  `confirmedMaxAge` (10 min). `refresh` still always fetches.
* **Age limit**: the poll interval for open PRs; `closedDetailTTL` (10 min, or the poll
  interval if that is longer) for merged and closed ones.
* Only PRs the poll covers (dashboards, watched branches) are ever confirmed, so
  uncovered PRs keep the age rule unchanged. A fetch stores an unconfirmed entry; a row
  adopted from SQLite starts stale and unconfirmed.
* **Watched branches** list `branchFirst = 25` PRs (was 10). Every author's PRs come
  back and the store keeps the viewer's, so a reused branch name or a watched default
  branch of a busy repository could push the viewer's PR past 10.

## Decisions

* **Confirmation window is 1.5 intervals, not 1.** The next poll is scheduled one
  interval after the previous one *ended* and confirms only when its fingerprint returns,
  so consecutive confirmations are an interval plus a few seconds apart. With a strict
  1-interval window, the GUI's 60 s keep-alive read drifts into that gap every ~20 min
  and refetches. A missed poll (network pause) lets the window lapse and reads fetch
  again.
* **`confirmedMaxAge` (10 min) caps confirmation.** Not in the brief; added because some
  changes never move the fingerprint: the base branch moving (`mergeStateStatus` →
  `BEHIND`/conflicts), a review thread resolved. Before, the age rule refreshed them
  every minute; now at most every 10 minutes. Still a 10x cut for an idle open panel.
  Remove the cap (one line in `serves`) if that staleness is acceptable.
* **Open PRs with mergeability still `UNKNOWN` are not confirmed** (`confirmable`).
  GitHub computes it lazily and does not bump `updatedAt` when done, so the poll would
  keep vouching for "unknown". Merged/closed PRs report `UNKNOWN` forever and are
  confirmed.
* `closedDetailTTL` is `max(10 min, poll interval)` so a long poll interval never makes
  closed PRs refetch more often than open ones.

## Measured (2026-10-17, 13 min, both daemons at once)

Each daemon: watch `cf/gh-detail-confirm` (open #152) and `t3/claude-mark-tooltip`
(merged #147) through `GetBranchPullRequests`, and every 20 s read
`GetPullRequestDetail` for code-foundry #152 (open, covered), #147 (merged, covered),
#146 (merged, not covered), and ghostty-org/ghostty#13779 (open, not covered). Counted
from the debug log (`gh request ... query=pull_request_full`); reads were curl over the
unix socket (`/codefoundry.v1.GhService/GetPullRequestDetail`, JSON).

| `pull_request_full` fetches | Before | After |
|---|---|---|
| #152 open, covered | 13 | 4 (first read, then 3 after the poll saw CI move checks/rollup: 09:13-09:17Z) |
| #147 merged, covered | 12 | 2 (first read, then at 10 min 19 s) |
| #146 merged, not covered | 12 | 2 (first read, then at 10 min 19 s: `closedDetailTTL`) |
| ghostty#13779 open, not covered | 12 | 13 (age rule unchanged) |
| all GraphQL requests | 64 | 37 (polls 13 vs 14) |

From 04:19 to the end (04:26) #152 was read 22 times with 7 polls confirming it and was
never fetched. Each avoided fetch is one cost-1 request of 5-10 KB here (66 KB for the
busy ghostty PR) and 0.4-1.3 s of worker time.

## Gotchas

* The fingerprint covers updatedAt, state, head, and check rollup counts. CI running on
  the open PR moved the counts on most polls for its first 5 minutes, so those refetches
  are correct, not misses.
* `fullCache.adopt` now returns the `fullEntry`; `cachedFull` returns the entry too
  (`nodeID` uses `e.d`).
* CI's `go-test` on the first push failed in `cmd/code-foundry` `TestRunEvents` and
  `internal/store/thread` `TestWakeLimit`, packages this change does not touch; both pass
  locally (timing flakes, as seen before).

## Tests

* `TestFullEntryServes`: open young/aged, never confirmed (uncovered), confirmed now,
  inside and past the window, past `confirmedMaxAge`, stale; merged/closed inside and
  past `closedDetailTTL`; a 20 min poll interval.
* `TestFullCacheApplyPoll`: unchanged → confirmed; updatedAt or check counts moved →
  stale and announced; not in the poll → untouched; already stale → not confirmed, not
  re-announced; `UNKNOWN` mergeability or merge state → not confirmed; merged with
  `UNKNOWN` → confirmed; a new fetch drops the old confirmation.
* `TestFullPullRequestConfirmedByPoll`: store level, 1 min poll, ten polled minutes:
  covered open and merged PRs fetch twice (first read, then at the cap), uncovered open
  every interval, uncovered merged at `closedDetailTTL`; a moved fingerprint still
  fetches.
* `queries_test.go` pins `first: 25` for watched branches.
