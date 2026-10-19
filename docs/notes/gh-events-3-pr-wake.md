# gh events 3: thread wakes on pull requests (2026-10-18)

PR C of three (A: `gh-events-1-pull-request-changed.md`, the per-PR `PullRequestChanged`
event this reads; B: per-file worktree events). A thread can now be woken when a pull
request's checks finish, it gets a review or comment, a review is requested, it is
pushed, merged or closed. Same machinery as the thread and action run wakes
(`agents-4-wake.md`): a `[code-foundry wake]` message through Send, the item marked
`origin: WAKE` with `wake_title` and `wake_json`, the loop guard and the 60/hour cap.
Daemon, proto, CLI and the orchestrate skill; the GUI draws the header as it does for
any wake it has no note for.

## What is here

| Piece | Where |
|---|---|
| Target kind, conditions, matching, `PullRequestChanged` | `internal/store/thread/subscriptions_pr.go` |
| Wake header and JSON | `internal/store/thread/subscriptions_pr_wake.go` |
| Subscribe, unsubscribe, list, rehydrate, watch set | edits in `subscriptions.go`, `manager.go` (`Options.PullRequest`, `Options.WatchPullRequests`) |
| Keeping the pull request polled | `internal/store/gh/pr_watch.go` (`WatchPullRequests`, `CachedPullRequest`), folded into `planPoll` |
| Daemon glue | `internal/daemon/wake_pr.go` (lookup, watch, event forwarding), wired in `stores.go` |
| Proto | `thread_subscriptions.proto`: `THREAD_SUBSCRIPTION_TARGET_PULL_REQUEST`, conditions 7 to 16, `target_pull_request` on subscribe and unsubscribe |
| CLI | `thread.subscribe --pr`, `thread.unsubscribe --pr`, the new `--until` values, `pr` rows in `thread.subscriptions` |
| Skill | `code-foundry-orchestrate/SKILL.md` (Wait; conventions), `reference/patterns.md` §4 |
| Fakes | `ghtest.Store.WatchPullRequests`/`Watched`/`CachedPullRequest`; `threadtest` and `commandtest` take the new target |

## Conditions

`--until` (the existing flag; the brief called it `--for`, which is `thread wait`'s):

| Condition | Fires when the poll's event for the pull request … | At once when the cache says |
|---|---|---|
| `checks_done` (default) | has a rollup with checks and none pending that the rollup before did not | open, checks all completed |
| `checks_failed` | has a FAILURE/ERROR rollup the one before was not | open, FAILURE/ERROR |
| `checks_passed` | has a SUCCESS rollup the one before was not | open, SUCCESS |
| `review` | has `reviews` (count rose) or `review_decision` | – |
| `comment` | has `comments` | – |
| `review_requested` | has `review_requested` | – |
| `head_pushed` | has `head_pushed` | – |
| `merged` | has `merged` (or `appeared` already merged) | merged |
| `closed` | has `closed` (or `appeared` already closed) | closed |
| `changed` | has anything; the wake lists every change | – |

Thread conditions on a pull request target and pull request conditions on a thread or
run are InvalidArgument (store and CLI).

## Decisions

* **One wake per subscription per poll.** A poll publishes one `PullRequestChanged` per
  pull request with every change; each subscription fires at most once for it and the
  wake's `changes` are the ones that matched (`review` with a review and a new decision:
  one wake with both; `changed`: all of them).
* **The checks edge.** "Before" is the event's `checks` change's old rollup, or the
  current one when the rollup did not change. A `head_pushed` or `appeared` in the same
  event has no before (new head, or first seen): a push whose checks all passed between
  two polls (no rollup change, since both heads are SUCCESS 4/4) still fires
  `checks_done`/`checks_passed`. `checks_done` needs pending 0 (and the state not PENDING
  or EXPECTED): GitHub's rollup turns FAILURE at the first failure while other jobs run,
  which fires `checks_failed` but not `checks_done`; the rest finishing fires
  `checks_done` (and not `checks_failed` again). Checks conditions fire only on an open
  pull request.
* **Fire at once** from the GitHub store's cached lists only (`CachedPullRequest`: the
  dashboards and watched branches, no request). A pull request the cache does not hold
  is armed silently; its first event that meets the condition fires. Merged/closed and the
  checks conditions only: the others are events, not states.
* **Terminal.** `merged` and `closed` go once they fired, even with `--repeat`. A merged
  pull request ends every subscription to it (fired or not, logged): nothing more will
  happen to it and it would stay in the poll forever. A closed one keeps the others (it
  may reopen). Subscribing to an already merged pull request with anything but `merged`
  is FailedPrecondition.
* **Keeping it polled: watched branches without expiry.** The thread store tells the
  daemon its set of pull request targets whenever it changes (`Options.WatchPullRequests`,
  called on subscribe, every removal, and at startup after rehydration); the daemon passes
  it to `gh.Store.WatchPullRequests`, which replaces its interest set. `planPoll` adds
  each pull request's head branch to the watched branches (the branch block the poll
  already has, `pullRequests(headRefName:, states: [OPEN, MERGED, CLOSED])`), not subject
  to `BranchWatch`'s 10 minutes, and the branch's list keeps that pull request whoever
  wrote it (`keepFingerprints`: a branch list otherwise keeps only the viewer's own,
  same-repository pull requests). The head branch comes from the cached lists, then the
  detail cache, then one `PullRequest` request in the worker before the poll (at most
  once per 10 minutes per pull request while it fails). Cost: one more branch block in the
  batched poll per watched pull request whose branch is not watched already (about 11 ms
  of GitHub server time per pull request on the branch); no cadence or tier change. A new
  pull request in the set brings the next poll forward, as a newly watched branch does.
  Chosen over a per-PR `pullRequest(number:)` fingerprint: the branch lists are already
  compared by PR A's diff and cached across restarts (the baseline), so nothing new is
  needed in the decoder, the diff or the cache. A branch list's first poll records
  silently (PR A), so a pull request only on a newly watched branch announces changes
  from its second poll on; the viewer's own pull requests are in the authored dashboard
  anyway.
* **Persistence**: no migration (`target_kind` and `condition` are TEXT in a STRICT table;
  `pull_request` and the condition names are values). Rehydrated pull request
  subscriptions are kept when the subscriber is live, re-armed and re-watched; nothing
  fires for what happened while the daemon was stopped (the GitHub store's first poll
  after a restart compares with the cache, PR A, and a subscription only sees events from
  then on). Archiving or removing the subscriber deletes them (the existing cleanup).
* **The thread store does not import the GitHub store**: it has its own
  `PullRequestInfo`, `PullRequestChange` and `PullRequestEvent` (strings for GitHub's
  enums; PR state lower case like a thread's `state`), and the daemon maps
  `gh.PullRequestChanged` into them (`wake_pr.go`), as it does for action runs.
* **Target ids**: `owner/name#N`, slug lower case; `ParsePullRequestTarget` also takes
  `https://github.com/owner/name/pull/N` (with or without scheme, with `/files`,
  `#discussion…` and so on after it). Unsubscribe takes either form.
* **Listing**: `target_name` is `owner/name#N Title` (the CLI prints `pr <target_name>`);
  `target_status` is `open · checks pending (2/4) · review required`, `open · draft ·
  checks failed (1/4)`, `merged`, `closed`, or `not polled yet` when the cache has not
  seen it.
* **The header**: `Pull request owner/name#N "Title": checks done (4 passed, 0 failed).`;
  `checks passed (4/4)`; `checks failed (1 failed, 3 passed, 0 pending)`; `a review was
  submitted (APPROVED by octocat)` (the latest review; `; review decision X` when the
  decision differs) or `the review decision changed to X`; `a new comment (3 in all)` /
  `N new comments (M in all)`; `a review was requested from a, b` (or `you`); `new commits
  were pushed (head 1b8930b → 4a3d1ba)`; `merged`; `closed without merging`; `changed
  (head_pushed, checks)`.
* **The JSON**: `{kind: "pull_request", subscription_id, condition, fired_at,
  pull_request: {slug, number, url, title, state, head_sha, head_ref, draft,
  review_decision, checks: {state, total, passed, failed, pending, skipped}, reviews,
  comments, review_requests, latest_reviews: [{author, state, submitted_at}], merged_at},
  changes: [{kind, …}]}`; each change carries only its kind's fields under the
  `PullRequestChange` proto's names in snake case (`old_checks`/`new_checks`,
  `old_count`/`new_count`, `requested`/`viewer_requested`, …). `changes` is `[]` for a
  wake fired at subscribe time. Counts and states only.
* **CLI**: `--until` lost its `settled` default so each target gets its own
  (UNSPECIFIED goes to the daemon: settled, finished, checks_done). The command text was
  trimmed: the guide has a 29,000-byte cap and had 19 bytes left; the pull request detail
  is in the skill.
* **GUI**: nothing new; `lib/wake.ts` already falls back to the header for a payload that
  is neither a thread nor a run (its test now uses a `pull_request` payload).
* **Not built**: a review/comment body in the wake (counts only, decided); waking on a
  pull request the poll never sees (outside every list and with an unknown head branch
  that cannot be fetched).

## Tests

* gh: `TestKeepFingerprints`; `TestWatchPullRequests` (fake GitHub: another author's pull
  request in no dashboard, head looked up once, kept in its branch list, its checks change
  published, the unknown one not retried within BranchWatch, re-watch keeps the head,
  unwatch drops the branch, validation).
* thread: `TestParsePullRequestTarget`, `TestSubscribeTargetPullRequest`,
  `TestMatchPullRequest` (15 events × 10 conditions: every condition, coalescing, the
  checks edges, a push, first-seen), `TestPRAlreadyMet`, `TestPRWakeMessage` (every
  header, the JSON keys and per-kind change fields), `TestPRStatusWords`,
  `TestPullRequestSubscriptions` (unknown then armed, watch set, checks_done once,
  review repeat with one wake per poll, another PR ignored, fire at once once and
  repeat, merged ends everything, merged refusals), `TestPullRequestSubscriptionsClosed`,
  `TestPullRequestSubscriptionsRefuse`, `TestPullRequestSubscriptionsRehydrate`
  (re-watched at startup, nothing fires, the next change does, archive deletes).
* daemon: `TestWakePullRequests` (a `ghtest` `ChangePullRequest` reaches the thread store
  mapped, every kind), `TestPullRequestForWake`, `TestWatchPullRequestsForWake`.
* api: `TestThreadSubscriptionsPullRequest` (every condition both ways, codes,
  unsubscribe). command: the `--pr` cases, refusals, table row, `--json` shapes.
* The wake into a subscriber's items is covered in the thread store's harness (real
  Manager, fake claude); the daemon package has no Manager harness, so the daemon tests
  stop at the event handed over, and the end to end below covers the whole path.

## End to end

(below)
