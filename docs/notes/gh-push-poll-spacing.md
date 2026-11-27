# gh store: space the polls that pushes ask for

## The problem

After a push or a PR create, the gitops bridge (`internal/daemon/gitops_gh.go`,
`NotifyBranchChanged`) did two things:

- `BranchPullRequests` watched the branch. A newly watched branch whose cache was stale
  also called `pollSoonLocked`, which set `pollAgain` and polled within `pollDebounce`
  (0.5 s).
- `Refresh(ctx, "")` set `pollAgain` and `pollNext = now`.

Nothing spaced these polls, and the presence tiers did not apply to them
(`gh-poll-tiers.md`). So many threads pushing while no GUI was looking turned the 15 min
tier into back-to-back full polls, one per push. The before count is ten full polls
for ten pushes in ten seconds while idle. It comes from `TestPushBurstPolls` in the test
harness, before the fix, which drove the bridge's old two calls.

## Decision

**A new store method, `BranchPushed(ctx, slug, head)`, used only by the bridge.** It
watches the branch the same way as before, but it never takes the `pollDebounce` path.
It asks for the poll at the push spacing:

- **Quiet stretch.** If no poll ended within `pushPollGap`, the poll runs at once
  (`pollNext = now`). A single push shows its commits or its new PR as fast as before.
- **Inside the gap.** The poll moves to `lastPoll + pushPollGap`. Every push in the gap
  shares that one trailing poll, so none is lost, and a PR created by the second push
  appears 3 s later, not at the tier's next poll. A sooner poll that was already
  scheduled is left alone.
- **During a running poll.** The poll may have planned before the push, so a push during
  it sets `pushAgain`. `schedulePollLocked` then puts the next poll `pushPollGap` after
  this one ends, instead of at once as `pollAgain` does. `planPoll` clears `pushAgain`
  (the plan covers the pushes so far), and a failed poll clears it like `pollAgain`
  (a failing poll is not retried early).

**The spacing lives in the store, not the bridge.**

- The store already owns the schedule: `pollNext`, `lastPoll` (when the last poll of
  any kind ended), and the running-poll flag pattern (`pollAgain`).
- The trailing poll is just a `pollNext`, with no timer goroutine. A bridge-side
  debounce would need its own timer. It could not see that a regular poll had just run.
  It would also have to cover the `pollSoon` inside `BranchPullRequests` separately.
- It is tested on the store's fake clock beside the rest of the scheduler.

**`pushPollGap = hotSkipMax` (3 s).**

- It is the store's existing window for "two polls this close are duplicates": the hot
  poll is skipped when a full poll is due within it.
- At the default `MinGap` (1 s), it leaves two request slots between pushed polls for
  on-demand reads and the hot poll.
- Writes stay serial and 1 s apart either way; writes are on the same worker and
  unaffected.

**What a user gives up.** The poll was already held to `MinGap` after the previous
request, so a push inside a burst waits at most 2 s longer than before
(`pushPollGap - MinGap`). The worst case is a push that lands just after a poll ended,
or while one runs: it waits for that poll's end plus 3 s.

**`Refresh` is unchanged and no longer used for pushes.**

- With a slug, it is a job the caller waits on.
- Without a slug, it is an unspaced `pollAgain` + `pollNext = now`, plus
  `authNext = now`.

Checking every caller turned up no other production caller of `gh.Store.Refresh`. The
GUI has no manual GitHub refresh RPC; the detail panel's refresh is
`FullPullRequest(refresh)`, which goes through the queue and is unaffected. So the
bridge's narrow interface drops `Refresh` and `BranchPullRequests` for `BranchPushed`.
`Refresh("")` stays the unspaced path for anything a person waits on.

**Auth check.**

- `BranchPushed` leaves `authNext` alone. A push does not change gh's login, and while
  gh is not authenticated, the auth check already retries on its own backoff (capped at
  2 min).
- Before this change, every push also forced an auth check while unauthenticated.
- `Refresh("")` still sets `authNext = now`, unchanged.

## Measured (test harness, not a live daemon)

These counts come from `TestPushBurstPolls` (`internal/store/gh/push_poll_test.go`).
The test runs a store that is not running, on a fake clock, with no GUI (the 15 min
tier). The test plays the worker (`next()`/`execute()`). Requests take no fake time. The
count is `Poll` requests.

Each cell gives the number of polls, then their offsets in seconds.

| Asks | Before | After |
|---|---|---|
| 1 push at 0 | 1 (0) | 1 (0) |
| 2 pushes at 0, 1 | 2 (0, 1) | 2 (0, 3) |
| 10 pushes, 10 branches, 1 a second | **10** (0 … 9) | **4** (0, 3, 6, 9) |
| 10 pushes, one branch, 1 a second | 10 (0 … 9) | 4 (0, 3, 6, 9) |
| 3 pushes without a branch at 0, 1, 2 | 3 (0, 1, 2) | 2 (0, 3) |
| 3 pushes at 0, 3, 6 | 3 (0, 3, 6) | 3 (0, 3, 6) |
| 1 push, a second during its poll | 2 (0, 0) | 2 (0, 3) |
| `Refresh("")` × 10, 1 a second | 10 (0 … 9) | 10 (0 … 9), unchanged |

"Before" is the same harness driving the old bridge calls: `BranchPullRequests` then
`Refresh("")`, or only `Refresh("")` without a branch.

Not run end to end against GitHub: that would need real pushes. The bridge's call is
covered by `TestGitOpsGitHubBridgeNotifyBranchChanged`.

## Tests

- `TestPushBurstPolls`: the table above, as poll offsets on the fake clock.
- `TestPushPollSchedule`: the schedule `BranchPushed` leaves, against `Refresh("")`.
  The cases are: quiet, never polled, inside the gap, at the gap, a sooner or a due poll
  kept, and refresh inside the gap. Each case checks `authNext`, `pollAgain`,
  `pushAgain`, and that a newly watched branch does not take the `pollDebounce` path.
- `TestSchedulePollAfterPush`: `schedulePollLocked` with each combination of
  `pollAgain` and `pushAgain`.
- `TestBranchPushedInvalidSlug`: the error comes back and the poll is still asked for.
- `go test -race` on `internal/store/gh`, `internal/daemon` and `internal/store/gitops`.

## Gotchas

- `BranchPullRequests` asks for its own poll for a newly watched, stale branch.
  Spacing only `Refresh("")` would have left half of the burst unspaced: in a fleet,
  each thread pushes its own branch, which is usually newly watched. `BranchPushed`
  replaces both calls.
- `lastPoll` is set at the end of `poll()`, slightly after `schedulePollLocked` runs in
  `applyPoll`. The trailing poll after a running one is anchored on the schedule's `now`.
  The difference is a few ms.
- The harness's `testClock` runs with real time plus an offset, because `admit` waits on
  real timers between a poll's requests. Poll offsets are compared rounded to the
  second.
