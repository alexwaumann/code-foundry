# gh store: viewer-scoped, batched, change-driven polling

Status: done on branch `t3code/review-gh-git-diff-services`. `make check` is green and
`make gui-e2e` passes (124 tests, WebKit and Chromium). The change was run end to end with
scratch daemons (`CODE_FOUNDRY_HOME=$(mktemp -d)`) on Alex's account. A second daemon
with `CODE_FOUNDRY_GH_SEARCH_AS=mitchellh` covered a busy account. `live-prs.spec.ts`
ran in WebKit against the scratch daemon.

The store no longer polls every open PR of every tracked repository. It polls what
concerns the viewer, in **one GraphQL request per poll interval**. Details are fetched
only for what changed.

## What is polled

Every `github.poll_interval_seconds` (default 60s), one document built per cycle
(`poll_query.go`, cost 1):

| Part | Alias | Fields |
|---|---|---|
| viewer | `viewer` | `ViewerFields` (also the branch filter's login and the stats' author id) |
| open PRs the viewer authored | `s_authored` | `search(... author:@me, first: 50)` → `PullRequestFingerprint` |
| open PRs requesting the viewer's review (directly or via a team) | `s_review` | `review-requested:@me`, 50 |
| open PRs the viewer reviewed and did not author | `s_reviewed` | `reviewed-by:@me -author:@me`, 50 (PRs also in `s_review` are dropped) |
| PRs merged in the last 7 days involving the viewer | `s_merged` | `ISSUE_ADVANCED`, `(author OR reviewed-by OR assignee)`, 50 → `PullRequestIdentity` (no checks) |
| each tracked repository | `r<i>` | `DefaultBranchFingerprint`: head oid, headline, committed date, rollup state and per-state counts |
| each watched branch | `r<i>.b<j>` | `pullRequests(headRefName:, first: 10, any state)` → fingerprint; kept: the viewer's, not from a fork |
| monthly stats, when due (15 min) | `mergedThis`, `mergedLast`, `mergedRecent`, `contributions`, `r<i>.history` | merged counts (`first: 0`), one two-month merged list (100) for per-repo merged counts, `contributionsCollection`, and default-branch `history(author: {id})` per tracked repo |

A **fingerprint** is `id number updatedAt state headRefOid isCrossRepository author
repository` plus `statusCheckRollup { state contexts { checkRun/statusContext counts by
state } }`. `PullRequest.statusCheckRollup` exists directly, so no
`commits(last: 1)` connection is needed.

After the fingerprint:

1. **Details**, by node id (`pull_request_details.graphql`, `nodes(ids:)`), only for PRs
   that are new, or whose `updatedAt`, state, or head moved, or whose rollup **state**
   changed (merge state depends on it). They are also fetched for an open PR stored with
   the summary only, and up to 3 polls in a row while GitHub still reports mergeability
   as `UNKNOWN` (it computes it lazily and does not bump `updatedAt`). Changes to check
   **counts** alone are copied from the fingerprint and fetch nothing. Open PRs get
   `PullRequestDetail`:
   * summary fields, plus additions/deletions/changed files
   * head repository, review decision, mergeable, merge state status
   * comment and review counts, latest reviews (10), review requests (10)

   Closed and merged PRs get `PullRequestSummary`. Each request takes 10 open PRs (plus
   30 closed). A 502/504 halves the batch size and retries at once, and the smaller size
   sticks.
2. **Failing checks** of a default branch, only when its head or failure count changed
   and it has failures. One aliased request covers every such repository
   (`DefaultBranchChecks`, `object(oid:)` with `contexts(first: 100)`). More pages come
   through `checks.graphql`, only when the failures are not all on page one. With 0
   failures the list is cleared without a request.
3. **REST** `search/commits` × 2 when the stats are due. This is unchanged and has its
   own 30/min budget.

**Partial results.** A GraphQL response with both data and errors now returns its data
with a `*PartialError` (`runner.go`), and `At(alias)` places each error. A deleted or
inaccessible tracked repository sets that repository's `DefaultBranchStatus.last_error`
and nothing else. Before, one bad alias would have failed the whole poll.

**Scheduling.** There is one poll job on the single worker. MinGap is 1s, the rate-limit,
auth, and network pauses work as before, and on-demand jobs still go first.
* `Track` of a repository without cached CI, and `BranchPullRequests` of a branch not
  polled recently, bring the next poll to within 0.5s. A burst of them shares one poll.
* A request that arrives while a poll is running gets another poll right after it,
  because the running poll may have planned without it.
* With nothing tracked or watched, the poll fetches only the viewer, every 10 minutes.
* The stats need the author's node id. The very first poll learns it, and the next poll
  follows at once.
* On restart, a cache younger than the interval waits out the interval. The first poll
  after a restart fetches no details for unchanged PRs: the diff baseline is the cached
  state.

## Events

Data events go out **only when data changed**: compared as JSON, ignoring `FetchedAt`.

| Event | When |
|---|---|
| `dashboard_updated` | lists, totals, stats, dashboard errors, or the tracked set changed |
| `repo_activity_updated` | a repository's default-branch CI or stats (or their errors, or its tracked flag) changed |
| `branch_pull_requests_updated` | a watched branch's PRs or error changed, or its first poll |
| `viewer_updated` | viewer fields, authentication, or error changed |
| **`polled`** (new) | after **every** poll: `fetched_at` of the last success, `last_error` of this poll |

The GUI's "updated Ns ago" (Pull Requests page, overview's GitHub activity for tracked
repos) reads `polled` from a tiny Zustand store (`usePollStore`, `useFreshness`). A
poll that changed nothing therefore costs every client one small event and **no
re-reads**. A poll's data events are published before its `polled` event. The
EventService gh snapshot sends viewer, polled, dashboard, then each repository's
activity.

## Measured cost (2026-10-08, this machine, `alexwaumann`)

Both runs used a scratch daemon with this repository and a `git init` stub whose origin
is `ghostty-org/ghostty`, registered with `repos.fetch_interval_seconds = 0`. One branch
was watched (`GetBranchPullRequests` re-called within 10 minutes). Numbers come from the
debug log: `gh request` per request, and the new `gh poll` line per cycle with
`requests`, `cost`, `details`, `dur`.

| | Before (old code, 22.3 min) | After (12.5 min steady, before the laptop slept) |
|---|---|---|
| Requests/hour | **~420** (153 GraphQL + 4 REST in 22.3 min) | **~68** (60 polls + 8 REST stats searches) |
| GraphQL points/hour | **~410** (every query cost 1) | **~60** (1 per poll; details only on change) |
| Worker busy (sum of request time)/hour | ~650 s | ~125 s |
| Breakdown /hour | ghostty + code-foundry PR lists 256 (ghostty 4 pages each minute, 2.4s median, up to 4.7s), dashboard searches 89, branch PRs 43, repo stats 11, viewer 8, viewer stats 5, REST 11 | polls 60 (median 1.82s, 1.59–2.55s); the stats poll every 15 min 3.8s + 2 REST (0.35–0.65s); details 0 |

Everything an hour of the old loop fetched now comes in 60 requests. Data the old loop
had and the new one drops: the ~130 open PRs of ghostty that are not the viewer's. Data
the new one adds: merge state, size, review counts and requests, latest reviews, and
the reviewed list.

Busy account (`CODE_FOUNDRY_GH_SEARCH_AS=mitchellh`, ghostty tracked):

* **Steady state:** 1 request a minute, 3.1–3.3s, cost 1, 82 KB. These are 98
  fingerprinted PRs across 4 searches.
* **First poll from an empty cache:** the poll plus 9 detail requests (94 PRs, 2.0–5.5s
  each) plus 2 REST. The cycle took 46s and cost 10 points.
* **Second poll:** 7 refetched (mergeability still `UNKNOWN`, then settled).
* **Polls after that:** 0 details.

Per-field server time (curl against the GraphQL endpoint, 91 busy PRs over 4 searches,
or 20 PRs by id):

| Fingerprint, 91 PRs | Time |
|---|---|
| 4 searches, `id updatedAt` | 1.9–2.0s |
| + identity fields | 2.3s |
| + `statusCheckRollup { state }` | +0s |
| + rollup counts by state | +0.6s (2.9–3.4s total) |
| + `reviewDecision` | +3.5s, so it is in the detail, not the fingerprint |

| Detail, 20 PRs by id | Time |
|---|---|
| summary fields | 0.8s |
| `headRepository` | +0.25s |
| `additions deletions changedFiles` | +0.35s |
| `reviewDecision` | +1.2s |
| `mergeStateStatus` | +3.0s |
| counts, latest reviews, review requests, `mergeable`, `isInMergeQueue` | ≈ +0 each |
| all of it | 10 PRs 4.5s, 20 PRs 6.5s, 40 PRs HTTP 502 |

The fingerprint for Alex's account (no PRs) takes 1.5–2.1s. Each search costs ~0.35–0.5s
of server time, serially. Every document measured cost **1 point**: viewer, 4 searches,
4 repositories, 2 branches, and stats.

## Decisions

* **One request, not a split.** A heavy account's full poll with stats took 4.4s, well
  under GitHub's ~10s budget, so the fingerprint stays one request. Details and failing
  checks are separate requests on purpose: they are rare and they are the expensive
  part. A 502/504 on the poll halves every search (sticky, floor 10).
* **Four searches, not one with OR.** One `ISSUE_ADVANCED` search with
  `(author OR review-requested OR reviewed-by)` would save ~1s of server time. It would
  need `viewerDidAuthor`/`viewerLatestReviewRequest` to classify results (team requests
  uncertain), would share one cap of 100, and would break `SearchAs`. Latency once a
  minute is not worth that.
* **`reviewDecision` is not in the fingerprint.** It costs ~40–60ms per PR, and the
  reviews that change it bump `updatedAt`.
* **The diff baseline is the published state.** `knownPullRequests` rebuilds an id →
  PR index from the snapshot's lists and branch states each poll, so there is no second
  copy to drift. A PR whose detail failed stays as it was (or as a `partial`
  placeholder from its fingerprint), and the next poll retries it.
* **Watched branches list every author's PRs, filtered in the store.** `pullRequests`
  has no author filter. Search (`is:pr author:@me head:<branch>`) would filter, but it
  lags right after `pr.create`. The fingerprints are filtered before diffing, so other
  people's PRs never get details. The live run caught the bug where they did: 10 a poll
  on a watched `main` of ghostty.
* **Per-repo merged counts come from one two-month list (100).** This replaces two
  searches per repository. Global merged counts stay exact (`first: 0`). Beyond 100
  merged PRs in two months, per-repo merged counts are lower bounds; the store logs it.
* **Settings.** `github.poll_interval_seconds` is the one poll and
  `github.dashboards_enabled` drops the searches. Both now apply **live**:
  `gh.Options.Config`, read before each poll. Off clears the lists and sets
  `GetDashboard.dashboards_disabled`, and the page says so. The keys are unchanged. The
  stats interval (15 min), branch watch (10 min), and detail batch are constants.
* **Kept:** `GetPullRequest` and `ListChecks`, on demand only (30s cache); nothing polls
  them. `Refresh(slug)` now runs a poll and waits; `Refresh("")` marks the poll due.
* **Removed (sole user, no back-compat):**
  * `ListPullRequests` and its messages
  * `GhEvent.pull_requests_updated` (field 1 reserved)
  * the `gh_pull_requests` table, via migration `0005_drop_gh_pull_requests.sql`
    (merged migrations are never edited, so the drop needs a file)
  * the viewer, search, stats, branch, user-id, and PR-list queries
  * `RepoState.PullRequests/TotalCount/FetchedAt/LastError`
  * the `RepoInterval`, `ViewerInterval`, `DashboardInterval`, and `PageSize` options

  Cache version 2 ignores old rows.
* **Added to the API:**
  * `PullRequest`: `additions`, `deletions`, `changed_files`, `comment_count`,
    `review_count`, `latest_reviews`, `review_requests`, `partial`; merge state and
    head repo are now set for polled PRs too
  * `GetDashboardResponse.reviewed`, `dashboards_disabled`
  * `DefaultBranchStatus.last_error`
  * `GhEvent.Polled`

  The GUI view models map all of it. No new UI shows the detail fields or the reviewed
  list yet.

## Gotchas

* **GitHub closes idle HTTP/2 connections after ~30s**: reused after 28s, a new
  connection after 31s. The earlier note said ~60s; that was one observation. Any
  interval of 30s or more reconnects every poll, which costs ~0.2–0.4s once a minute and
  is not worth chasing with a sub-30s poll. The client now drops idle connections at
  25s, so it never races the server's close: a POST on a dead connection is not retried.
* **After the Mac sleeps, the first poll can fail with `connection reset by peer`.**
  Go's idle timer runs on the monotonic clock, which macOS stops during sleep. It is a
  network error: 15s pause, then the next poll succeeds (seen once: 22:08:23 failed,
  22:08:41 succeeded).
* `review-requested:@me` includes team requests, but `requestedReviewer` comes back
  `null` for teams the token cannot read, and those are skipped.
* `nodes(ids: [])` is fine, but both variables must be sent. The HTTP runner drops nil
  values, so empty lists are sent as `[]`.
* GraphQL rejects declared-but-unused variables, and the poll's parts vary. The builder
  declares each variable where it uses it, and `TestPollPlanBuild` checks
  declared = used = given.
* `mergeable`/`mergeStateStatus` are `UNKNOWN` right after a push, hence the bounded
  rechecks.
* The poll fetches the viewer every cycle. That costs nothing extra and keeps
  `GetViewer` current, so `viewer.graphql` and the 10-minute viewer poll are gone.

## Tests and fixtures

* `poll_test.go` runs the store against `fakeGitHub` (`fakegithub_test.go`). The fake
  answers Poll, PullRequestDetails, and DefaultBranchChecks from in-memory state by
  reading the document's aliases. The tests cover:
  * details only for changes, and count-only changes
  * rollup state and `updatedAt` changes
  * failing checks: once, on a failure-count change, cleared on a fix
  * partial results
  * branch watch: filter, events, expiry
  * batch and search shrinking on 502/504
  * placeholders, mergeability rechecks, dashboards off, restart from cache, stats
    bucketing, and SearchAs
* `store_test.go` keeps the pacing, auth, rate-limit, backoff, on-demand, and track
  tests.
* `poll_decode_test.go` decodes **real captures** (testdata, viewer sanitized to
  octocat):
  * `poll_partial.json`: Alex's account, with a missing repository at `r3`
  * `poll_populated.json`: the same plan for mitchellh
  * `pull_request_details.json`
  * `default_branch_checks.json`
  * `pull_request_14586_page{1,2}.json`: recaptured for the new `pull_request.graphql`
* Recapture recipe: `GH_DUMP_QUERIES=/tmp/q go test ./internal/store/gh -run
  TestDumpQueries` writes the static documents and request bodies for the fixture plan.
  Set its `author` variable to the real node id, then `curl -H "Authorization: bearer
  $(gh auth token)" -X POST https://api.github.com/graphql --data @/tmp/q/poll_me.json`.
