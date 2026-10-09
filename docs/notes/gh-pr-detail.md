# gh store: pull request detail panel (daemon side)

Status: chunk 2 of the PR detail panel, plus the review fixes (see "Review fixes"
below). Daemon, proto, commands, TS mapping, and mock only; no UI yet. `make check` is
green and `make gui-e2e` passes. The read RPCs and the three commands were run end to
end against a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-prdetail-home`, later
`/tmp/cf-ad45-home`, debug logs) on Alex's account. A successful review request or
revert was never sent to a real PR: only refusals (a revert of an open PR, which the
store refuses before the mutation; a review request GitHub refuses with 422). The
successful paths ran against the fake GitHub (store tests, HTTP test server) and the
mock daemon.

## RPCs (GhService, additive)

| RPC | GitHub | Cache |
|---|---|---|
| `GetPullRequestDetail(repo_slug, number, refresh)` → `PullRequestDetail` | `queries/pull_request_full.graphql`, one request; `checks.graphql` pages only beyond 100 checks | memory (64 entries) + `gh_activity` row `pr_detail:<slug>#<n>` |
| `ListReviewerCandidates(repo_slug, number)` | `queries/reviewer_candidates.graphql` | none |
| `SetReviewRequest(repo_slug, number, login, kind, requested)` → pending requests | REST `POST`/`DELETE repos/{o}/{r}/pulls/{n}/requested_reviewers` | marks the detail stale |
| `RevertPullRequest(repo_slug, number)` → number, url | GraphQL mutation `revertPullRequest(input: {pullRequestId})` | marks the detail stale, polls soon |

The two writes are user actions, so they are commands too (`internal/command/commands_pr.go`),
and the GUI runs them with `runCommand` like the palette and the CLI do. The TS client
(`src/api/gh.ts`) keeps only the reads:

| Command | Args | Calls |
|---|---|---|
| `pr.revert` | `repo-slug`, `number` (positional) | RevertPullRequest. Confirm: "This opens a new pull request that reverses the changes merged by #N."; result "Opened #M to revert #N: <url>" |
| `pr.review.request` | `repo-slug`, `number`, `login` (positional), `--kind user\|team` (default user), `--requested` (default true; `--requested=false` withdraws) | SetReviewRequest |
| `pr.refresh` | `repo-slug`, `number` (positional) | GetPullRequestDetail with refresh. If the daemon answers with its cached copy (`last_error` set), the command fails with UNAVAILABLE and that error |

Their `When` (`hasPullRequest`) is always true: the pull request is named by args, and
the CLI has no context to look at. They call GhService through the daemon's own
handler (`all.Deps.Gh`), as the gitops commands do, so backend errors keep their codes.

`GhEvent.pull_request_detail_updated {repo_slug, number}` (field 7) tells clients to
re-read. The GUI's `pullRequestDetailResource` (key `slug#number`) is invalidated by it.

`PullRequestDetail` holds the `PullRequest` summary (same mapping as GetPullRequest; its
`checks` is the rollup), plus:

* `body`, `labels`
* `reviewers`: one per login, merging `latestReviews` with `reviewRequests`. Each has
  `state`, `requested`, and `stale` (the review's `commit.oid` differs from the head).
  Requested reviewers come first, then the most recent review.
* `commits` (last 100) and `commit_count`
* `comments`: issue comments and reviews (last 100 of each), oldest first. Inline
  comments are only in `review_threads` (last 50, first 20 comments each), each with
  `review_id` (the review it belongs to) so a client can group them. Reviews that are
  COMMENTED with an empty body are left out of `comments`: GitHub records every inline
  comment and every thread reply as one (14 of 37 entries on ghostty#13779), and their
  text is in the threads. Empty APPROVED or CHANGES_REQUESTED reviews stay.
* `checks`
* `merge_commit_sha`, `merged_by`, `closed_at`, `node_id`
* `viewer_permission` and `viewer_can_update`
* `fetched_at`, `last_error`, and the truncation flags:
  * `labels_truncated`: more than 20 labels
  * `reviewers_truncated`: more than 50 latest reviews or more than 50 pending requests
  * `comments_truncated`: covers both streams, more than 100 issue comments or more
    than 100 reviews
  * `review_threads_truncated`, and `comments_truncated` per thread
  * `checks_truncated`: a checks page beyond the first failed (`last_error` says which
    and why; the checks fetched so far are kept), or `MaxPages` ran out

## Decisions

* **One document, cost 1.** Every real request measured cost 1 point:
  * code-foundry#1: 7.7 KB, 0.5–0.8 s
  * ghostty#13779 (37 comments, 15 threads): 60 KB, 1.5–1.7 s

  The nested connection that dominates GitHub's estimate is threads × comments (50 × 20).
  Fields that `PullRequestDetail` already selects with other arguments are aliased
  (`reviewers: latestReviews(first: 50)`, `requestedReviewers: reviewRequests(first:
  50)`, `reviewList: reviews(last: 100)`). GraphQL rejects one response name with two
  argument sets.
* **Cache rules.** An entry is served until one of these happens:
  * `refresh` is set
  * it is older than `github.poll_interval_seconds` (the poll interval)
  * a poll's fingerprint for that PR moved: `updatedAt`, state, head, or check rollup
    (state or counts)
  * it was just read back from SQLite. Polls that ran while the row was only on disk
    (evicted from memory, or the daemon was down) could not mark it, so a reloaded row
    starts stale and the first read fetches. Offline, that fetch fails and the row is
    served with `last_error`.

  The hook is one line in `applyPoll` (`staleFullDetails(fps)`). It compares by node id
  against every fingerprint the poll fetched, so it covers the viewer's dashboards and
  watched branches. Other PRs fall back to the age rule.
* **Events.** The poll marks an entry stale and publishes the event once. Every read of a
  stale entry then fetches, so the refetch does not announce again. A refresh or an
  age-expired fetch announces only when the content changed (JSON compared without
  `fetched_at`). That event is for other windows showing the same PR. The requesting
  client re-reads once more from cache, which is harmless.
* **SQLite is cheap here.** `gh_activity` is a key/value table, so the rows needed only
  a new key prefix, `pr_detail:<slug>#<number>`, and no migration (the 0004 migration's
  and `schema.sql`'s comments list it). They are excluded from the
  startup load (read on demand, like `branch:` rows) and pruned after 7 days. Their value
  is offline tolerance: after a restart with GitHub unreachable, the panel shows the last
  fetch with `last_error`.
* **Generic on-demand jobs.** `jobFunc` (closure plus id) replaces new switch cases. Jobs
  with the same id coalesce while queued, for example two windows opening the same PR.
  A detail fetch submitted while the same fetch is already running would queue behind
  it, so the job first checks the cache: an entry that is fresh and was fetched after
  the job was submitted is returned without a request (this holds for a refresh too:
  that data is newer than the request for it).
  Mutations go through the same worker, so these all apply as to any other request:
  * MinGap pacing and one request in flight
  * fail-fast while rate-limit or network paused
  * 401 → auth-paused state (`restWrite` calls `noteResult`)

  Mutations are never retried. The runner retries only a 401 with a new token, and then
  the request was not executed.
* **REST writes** use the new `RESTWriter` interface (`HTTPRunner.RESTWrite`, in
  `http_write.go`). The existing `RESTRunner` interface was left untouched. HTTP 422
  becomes `ErrFailedPrecondition` with GitHub's validation details, for example "Review
  cannot be requested from pull request author." A 403 that is not a rate limit is
  `ErrPermissionDenied` (in `classifyHTTP`, so for every REST and GraphQL HTTP call). A secondary or primary rate limit on a
  REST write pauses everything. Content-creation limits are shared, and the REST core
  budget running out on our few writes is not realistic.
* **Teams.** The request accepts `org/team` or a bare slug, and REST gets the slug. The
  response's `requested_teams` have no org, so the base repository's owner is used.
  Candidates list teams only when they are already requested. Listing org teams would
  need `read:org` and another query; this is left for later.
* **Revert** uses the node id from the detail (cached, or fetched). A PR merged since it
  was cached gets one refresh before the store refuses, and that refresh must succeed:
  its error comes back wrapped with `%w` ("cannot confirm it is merged: …"), so a rate
  limit is RESOURCE_EXHAUSTED, not a stale copy's `last_error`. If the PR is not merged,
  the store returns `ErrFailedPrecondition` (Connect FAILED_PRECONDITION) without calling
  the mutation. GitHub refusing the mutation comes back as a `*PartialError`; the store
  returns its classified cause (FORBIDDEN → PERMISSION_DENIED, UNPROCESSABLE →
  FAILED_PRECONDITION). Afterwards the store polls soon so the new PR shows up on the
  dashboard.
* **Revert dedupe (2 minutes).** The outcome of a revert answers repeats of the same PR
  for 2 minutes, checked before the job and again on the serial worker:
  * success: the first result, so a double click cannot open two revert PRs
  * server timeout (502/504), network error, or deadline: the mutation may have run.
    The store remembers "outcome unknown" and returns an error telling the user to
    check GitHub before trying again; a retry inside the window gets that error and
    sends nothing. After the window a retry sends the mutation.
  * a refusal (FORBIDDEN, UNPROCESSABLE) is not remembered: nothing was opened.
* **Error codes** (`internal/api/gh.go`): one code per sentinel, so clients can tell them
  apart.

  | Store error | Connect code |
  |---|---|
  | `ErrInvalidSlug`, `ErrInvalidArgument` | INVALID_ARGUMENT |
  | `ErrNotFound` | NOT_FOUND |
  | `ErrFailedPrecondition` (not merged, HTTP 422, GraphQL UNPROCESSABLE) | FAILED_PRECONDITION |
  | `ErrPermissionDenied` (GraphQL FORBIDDEN, HTTP 403 that is not a rate limit) | PERMISSION_DENIED |
  | `ErrNotAuthenticated` (gh needs `gh auth login`) | FAILED_PRECONDITION (not UNAUTHENTICATED: the GUI drops its daemon endpoint on that code) |
  | `ErrRateLimited` | RESOURCE_EXHAUSTED |
  | `ErrNetwork`, `ErrServerTimeout` | UNAVAILABLE |
* **Viewer drafts.** PENDING reviews are the viewer's own unsubmitted drafts. They are
  left out of `reviewers` and `comments`.
* **Write access.** `viewer_can_update` is true for `viewerPermission` ADMIN, MAINTAIN,
  or WRITE. It is not GitHub's `PullRequest.viewerCanUpdate`, which is true for a PR's
  author even without write access, and such an author can neither revert nor always
  request reviewers. The raw permission is in `viewer_permission`.

## End to end (2026-10-09, scratch daemon, `alexwaumann`)

| Call | Result |
|---|---|
| `GetPullRequestDetail alexwaumann/code-foundry#1` | MERGED, node `PR_kwDOVAtW7M8AAAABHeFTDg`, merge `1ef770ad8238` by alexwaumann, closed 05:21:40Z, `admin`/can update, 8/8 commits, 1 check (SUCCESS), no labels/reviewers/comments/threads; one `pull_request_full` request, cost 1, 510 ms |
| same again | served from cache (same `fetched_at`, no request) |
| same with `refresh` | fetched again (816 ms), new `fetched_at`, no event (unchanged) |
| `GetPullRequestDetail ghostty-org/ghostty#13779` | OPEN, `read`/cannot update, label `gtk`, reviewers `bo2themax`, `jcollie` (requested), `pluiedev` APPROVED stale, `copilot-pull-request-reviewer` COMMENTED stale (bot); 37 comments, 15 threads (1 unresolved), 9 commits, no checks (fork PR); 1.5 s, 60 KB, cost 1 |
| `ListReviewerCandidates code-foundry#1` | empty: the only assignable user is the author (excluded); 251 ms, cost 1 |
| `ListReviewerCandidates ghostty#13779` | 94, not truncated; `bo2themax`, `jcollie` (requested) then `00-kat`, `a-lang`, …; 1.7 s, cost 1 |
| `RevertPullRequest ghostty#13779` (open) | `failed_precondition: pull request #13779 is open, not merged`; it refreshed the detail once, no mutation sent |
| `GetPullRequestDetail code-foundry#99999` | `not_found: … Could not resolve to a PullRequest with the number of 99999.` |
| SQLite | `pr_detail:alexwaumann/code-foundry#1` (5.4 KB) and `pr_detail:ghostty-org/ghostty#13779` (57 KB) |

Review fixes, same day, scratch daemon `/tmp/cf-ad45-home`, through the CLI:

| Call | Result |
|---|---|
| `code-foundry pr refresh alexwaumann/code-foundry 1` | "Refreshed #1: GitHub store: …", exit 0 |
| `pr refresh alexwaumann/code-foundry 99999` | `not found on github: Could not resolve to a PullRequest with the number of 99999.`, exit 2 |
| `pr revert ghostty-org/ghostty 13779 --yes` | `failed precondition: pull request #13779 is open, not merged`; two detail reads, no mutation |
| `pr revert alexwaumann/code-foundry 1` (no `--yes`, no tty) | the confirmation message, "Re-run with --yes to confirm.", nothing sent |
| `pr review request alexwaumann/code-foundry 1 alexwaumann` | GitHub's 422: `failed precondition: Review cannot be requested from pull request author.` |
| `GetPullRequestDetail ghostty-org/ghostty#13779` | 23 comments (19 issue comments, 4 reviews), 28 of 28 thread comments with `review_id`, no truncation |
| restart, then `GetPullRequestDetail code-foundry#1` twice | the first read fetched (the SQLite row starts stale), the second was a cache hit |

Calls were made with
`buf curl --protocol connect --http2-prior-knowledge --unix-socket $HOME/daemon.sock --schema proto --data '{…}' http://localhost/codefoundry.v1.GhService/<RPC>`.

## Tests and fixtures

* Real captures (2026-10-09):
  * `testdata/pull_request_full_cf_1.json`: merged, admin viewer
  * `testdata/pull_request_full_13779.json`: busy open PR with a bot, outdated and
    resolved threads, and a `null` requested reviewer (a team the token cannot read)
  * `testdata/reviewer_candidates_13779.json`

  Recapture: `GH_DUMP_QUERIES=/tmp/q go test ./internal/store/gh -run TestDumpQueries`,
  then `gh api graphql -F query=@/tmp/q/pull_request_full.graphql -f owner=… -f name=…
  -F number=…`.
* `pr_detail_decode_test.go`: both detail captures, the candidates capture and
  synthetic shapes, the revert and REST responses, and the declared = used variables
  of the three documents.
* `pr_detail_test.go`:
  * cache hit vs refresh; poll-driven staleness on `updatedAt` and on check counts;
    age; stale-on-error; SQLite after a restart
  * candidates through the worker
  * `SetReviewRequest` through `HTTPRunner` against an HTTP test server: POST/DELETE
    method, path, and JSON body; team `org/slug` becomes the slug; 422 →
    FailedPrecondition; invalid input sends nothing; 401 → auth-paused
  * revert: refused for an open PR without a mutation, a merged PR reverted once (the
    repeat is memoized), an event, a poll soon, and fail-fast while paused
* `fakegithub_detail_test.go` adds `PullRequestFull`, `ReviewerCandidates`, and
  `RevertPullRequest` to the fake GitHub.
* `pr_detail_cache_test.go`: 64-entry eviction (the entry being stored is never the one
  evicted), adopt is atomic (a concurrent fetch is never replaced by the SQLite row),
  a reloaded row fetches once, and a read submitted during the same fetch reuses it
* `pr_detail_checks_test.go`: checks beyond 100 on the detail path (pages asked for by
  cursor on the head SHA), `MaxPages` truncation, and a failed page (truncated plus
  `last_error`)
* `pr_actions_test.go`: reverting a closed PR, a cached open PR whose confirming fetch is
  rate limited (RESOURCE_EXHAUSTED, no mutation), FORBIDDEN (PERMISSION_DENIED, not
  memoized), UNPROCESSABLE (FAILED_PRECONDITION), the outcome-unknown window and its
  expiry, and a success's window expiring (a second revert is sent)
* `pr_detail_decode_test.go` also covers null authors in comments, reviews, and thread
  comments; PENDING and empty COMMENTED reviews; a team reviewer and a stale reviewer
  re-requested; a null `mergedBy`; every truncation flag
* `TestSetReviewRequestREST` also covers a 403 without push access (PERMISSION_DENIED)
* `internal/api/gh_detail_test.go`: table tests of the four RPCs (every field mapped, the
  error codes, and the Watch event); `gh_test.go` has the full code table.
* `internal/command/commands_pr_test.go`: availability, confirmation and its message,
  requests sent, messages, argument errors, and backend codes passed through.
* Frontend:
  * `api/mapping.test.ts`: detail (with the new flags and `reviewId`), candidate, and
    event mapping
  * `stores/ghDetail.test.ts`: the resource key, event-driven re-read, the 60 s
    keep-alive, refresh writing its answer (fresh, or the cached copy with
    `lastError`), and a failed refresh RPC (entry error, rethrown)
  * `stores/resource.test.ts`: `set` (data, error keeping data, superseding a read in
    flight)

## Mock daemon

* `mock/prDetail.ts` serves all four RPCs and the three commands (with `pr.revert`'s
  confirmation):
  * #145 (open, draft): failing, in-progress, and queued checks; changes requested by a
    reviewer who is stale and re-requested; a team and a user pending; a bot review;
    `reviewers_truncated`; 2 unresolved threads and 1 resolved outdated thread (with
    review ids); labels; issue comments, one by a deleted account
  * #138 (merged): merge commit `3c3c4651aa…` (the mock main head), an approval, a
    resolved thread
  * #131 (closed without merging) and #140 (someone else's, read access, so
    `viewer_can_update` false): on no dashboard, open them by number
  * any other listed PR: a minimal detail from its summary

  Revert of #138 adds PR #151 to the dashboard and returns the same result on repeats.
  Reverting an open or closed PR returns FAILED_PRECONDITION.
* `POST /__mock/gh/pr-comment?repo=…&number=…&body=…` adds a comment and sends
  `pull_request_detail_updated`, as a poll would.

## Gotchas

* The fake runner's operation regex now accepts `mutation`.
* `requestedReviewer` can be `null` (a team the token cannot read). It is skipped both
  in reviewers and in candidates.
* A missing PR comes back as a NOT_FOUND part next to `pullRequest: null`, with HTTP 200.
  The store reports GitHub's message, not the decoder's.
* `reviewThreads.line` is `null` for outdated threads; `originalLine` is used then.
* The GUI's `pullRequestDetailResource` re-reads every 60 s while shown (the default
  poll interval; reads are cache hits until the daemon's entry ages). A PR the poll does
  not cover (not on a dashboard or watched branch) never gets
  `pull_request_detail_updated`, so without the keep-alive an open panel went stale.
* `refreshPullRequestDetail` writes the refresh's answer into the resource
  (`createResource.set`) instead of re-reading: a re-read would lose the refresh's
  `last_error`. `set` bumps a per-key generation, so a read already in flight cannot
  overwrite it.
* gh-not-logged-in stays FAILED_PRECONDITION. A first cut used UNAUTHENTICATED, but the
  GUI's `invalidateOnTransportError` reads that code as a stale daemon bearer token and
  drops the cached endpoint. The GUI already learns about gh auth from `authenticated` on
  the viewer and dashboard reads.
* The CLI prints "Run `code-foundry help <cmd>` for usage" after FAILED_PRECONDITION and
  NOT_FOUND (its rule for caller mistakes), so a refused revert gets that hint too.
* The fixtures were recaptured for `pullRequestReview { id }` and the reviewer
  `totalCount`s. They match the earlier captures apart from the new fields.

## Review fixes

The review of this chunk found the problems below; each is fixed and tested as listed
above.

1. Empty COMMENTED reviews flooded the conversation; thread comments had no review id.
2. Refused reverts and review requests came back as UNKNOWN (`*PartialError`, an
   unclassified 403).
3. The revert's merged check hid a failed refresh in `last_error`.
4. The writes were RPCs only; they are commands now.
5. An open panel on a PR outside the poll never refreshed (keep-alive).
6. A refresh's answer (and its `last_error`) was dropped (`set`).
7. A revert that timed out could be sent twice (outcome-unknown window).
8. A detail fetch requested during the same fetch was sent again.
9. `fullCache.adopt` was not atomic.
10. Rows reloaded from SQLite skipped poll staleness.
11. Labels, reviewers, and checks could be truncated silently.
12. Not-authenticated shared FAILED_PRECONDITION with real precondition failures.
13. Key comments and the "existing prefix" claim were out of date.
14. Mock fixtures lacked a closed PR, a read-only PR, and several reviewer and check
    states.
