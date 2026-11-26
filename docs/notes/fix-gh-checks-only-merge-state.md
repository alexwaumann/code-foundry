# gh store: a checks-only refresh no longer freshens merge state it did not read

PR #895 made a pending-check tick refresh only the checks (`fetchChecksOnly`,
`checks.graphql`) instead of the whole detail. That refresh stored the old detail with
the new rollup, set `FetchedAt = now`, and replaced the entry as fresh. Three problems:

1. CI settling between the tick and the refresh: the refresh stored `SUCCESS` next to
   the old `mergeStateStatus` (`BLOCKED`). The next poll's fingerprint matched, so the
   entry was confirmed as current and served green checks with a blocked merge until
   the age rules ran out (`confirmedMaxAge`, 10 minutes, or the poll interval).
2. `FetchedAt = now` on every tick made comments, review threads and a merge state
   moved by the base branch look fresh for the whole CI run, postponing the age-based
   refetch the fingerprint relies on for what it does not cover.
3. The refresh replaced the entry with `base + checks` at its own, higher request
   sequence. A full fetch for the same pull request in flight on the read lane (sent
   before it) was then dropped on landing (`fetchSeq` older) or overwritten (landing
   first), whichever order they finished in.

And a fourth, from coalescing: a `refresh=true` read joining a queued background
refresh of the same pull request (or a background refresh joining a queued waited read,
which hands over its `run`) ran the background job's func with `forceFull=false`, so the
explicit refresh could get a checks-only fetch.

Reproduced in `pr_detail_checks_merge_test.go` (all four failed before the fix).

## Decision

- `fetchChecksOnly` stores through `fullCache.putChecks`, which lays the checks onto the
  entry as it is when the refresh lands, not onto the copy it started from: only
  `Checks`, `PullRequest.Checks`, `ChecksTruncated` and `LastError` change. `FetchedAt`,
  `confirmed`, `fetchSeq`, `stale` and `written` are kept; `checksAt` records the
  refresh. The refresh is dropped when the entry has moved to another head or came from
  a fetch sent after it. So a full fetch sent before the checks refresh still lands over
  it (its `fetchSeq` is newer than the entry's), and one that landed first keeps its
  non-check fields.
- When the refresh finds the rollup changed state (left `PENDING`) or its failed count
  changed (`checksMoveMerge`), it stores nothing and `runFullFetch` fetches the whole
  detail in the same job, as it does for a ref that is gone. Those are what move
  `mergeable` / `mergeStateStatus`, which only the full detail reads.
- The poll (and the hot poll) that patches pending counts in place now also confirms the
  entry (`confirmable`): it saw nothing but pending counts move, which vouches for the
  rest as an unchanged poll would. Without this, keeping `FetchedAt` would make every
  checks-refreshed entry older than the poll interval not current, and the next read
  would fetch the whole detail on every tick. With it, the entry stays current until
  `confirmedMaxAge` after the last whole fetch, so a long CI run refetches the detail
  once every 10 minutes instead of never.
- `runFullFetch` picks checks-only only while the rest of the entry would still be
  current (`s.current` of the entry with `checksStale` cleared). A read during CI almost
  always finds the entry `checksStale`, so without this the age-based refetch would
  still never happen while the checks keep ticking.
- `runFullFetch` forces the full fetch for any job someone waits for: on the read lane
  (only such jobs run there) or with `s.forUser` set on the worker (`execute` sets it
  from `!j.background`, which `enqueueLocked` clears when a waiter joins). The early
  "a fetch already landed since this was asked" check counts a checks-only landing
  (`checksAt`) only for a background job and only while the entry is then current,
  never for a forced one.

Alternatives not taken: marking the entry stale after a settled checks refresh (an extra
event and re-read round trip before the full fetch starts), or a new job field to carry
`forceFull` through coalescing (touches the generic queue for one caller; `forUser`
already says the same thing on the worker).

## Cost and behaviour

- A tick where checks are still pending stays one `checks.graphql` request (1 point),
  with no `PullRequestFull`.
- The tick on which the checks refresh itself sees CI settle or a check fail costs the
  checks request plus one `PullRequestFull` (2 requests instead of 1), and the panel
  gets the right merge state from that job instead of up to 10 minutes later. When a
  poll sees the settle first, nothing changes: it marks the entry stale and the next
  read sends one `PullRequestFull`, as before.
- A covered pull request whose CI runs longer than 10 minutes gets one `PullRequestFull`
  per 10 minutes of the run while a panel keeps reading it (about 6 more requests per
  hour per open panel), which is the age rule working as intended rather than postponed
  by every tick.
- A refresh someone asked for (`refresh=true`) is always a full fetch, also when it
  coalesced with a background refresh: at most one more `PullRequestFull` in that case.
- The panel's "Updated … ago" (`fetchedAtMs`) now says when the whole detail was fetched,
  not when the checks were last refreshed.

## Gotchas

- `settleWorker` submits a write barrier; a test that holds a read-lane request cannot
  use it (the barrier waits for the read lane), so the concurrent test waits on the
  entry instead.
- The read lane only takes a waited job while the primary worker is blocked inside a
  read; to get a full fetch on it before a checks refresh, hold a poll on the primary.
