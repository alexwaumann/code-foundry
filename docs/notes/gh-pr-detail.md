# gh store: pull request detail panel (daemon side)

Status: chunk 2 of the PR detail panel. Daemon, proto, TS mapping, and mock only; no UI
yet. `make check` is green and `make gui-e2e` passes. The read RPCs were run end to end
against a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-prdetail-home`, debug logs) on
Alex's account. SetReviewRequest and RevertPullRequest were exercised only against the
fake GitHub (store tests, HTTP test server) and the mock daemon, never against a real PR.

## RPCs (GhService, additive)

| RPC | GitHub | Cache |
|---|---|---|
| `GetPullRequestDetail(repo_slug, number, refresh)` → `PullRequestDetail` | `queries/pull_request_full.graphql`, one request; `checks.graphql` pages only beyond 100 checks | memory (64 entries) + `gh_activity` row `pr_detail:<slug>#<n>` |
| `ListReviewerCandidates(repo_slug, number)` | `queries/reviewer_candidates.graphql` | none |
| `SetReviewRequest(repo_slug, number, login, kind, requested)` → pending requests | REST `POST`/`DELETE repos/{o}/{r}/pulls/{n}/requested_reviewers` | marks the detail stale |
| `RevertPullRequest(repo_slug, number)` → number, url | GraphQL mutation `revertPullRequest(input: {pullRequestId})` | marks the detail stale, polls soon |

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
  comments are only in `review_threads` (last 50, first 20 comments each).
* `checks`
* `merge_commit_sha`, `merged_by`, `closed_at`, `node_id`
* `viewer_permission` and `viewer_can_update`
* `fetched_at`, `last_error`, and the `*_truncated` flags

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

  The hook is one line in `applyPoll` (`staleFullDetails(fps)`). It compares by node id
  against every fingerprint the poll fetched, so it covers the viewer's dashboards and
  watched branches. Other PRs fall back to the age rule.
* **Events.** The poll marks an entry stale and publishes the event once. Every read of a
  stale entry then fetches, so the refetch does not announce again. A refresh or an
  age-expired fetch announces only when the content changed (JSON compared without
  `fetched_at`). That event is for other windows showing the same PR. The requesting
  client re-reads once more from cache, which is harmless.
* **SQLite is cheap here.** The rows go in `gh_activity` as key/value rows under the
  existing `pr_detail:` prefix, so no migration was needed. They are excluded from the
  startup load (read on demand, like `branch:` rows) and pruned after 7 days. Their value
  is offline tolerance: after a restart with GitHub unreachable, the panel shows the last
  fetch with `last_error`.
* **Generic on-demand jobs.** `jobFunc` (closure plus id) replaces new switch cases. Jobs
  with the same id coalesce, for example two windows opening the same PR.
  Mutations go through the same worker, so these all apply as to any other request:
  * MinGap pacing and one request in flight
  * fail-fast while rate-limit or network paused
  * 401 → auth-paused state (`restWrite` calls `noteResult`)

  Mutations are never retried. The runner retries only a 401 with a new token, and then
  the request was not executed.
* **REST writes** use the new `RESTWriter` interface (`HTTPRunner.RESTWrite`, in
  `http_write.go`). The existing `RESTRunner` interface was left untouched. HTTP 422
  becomes `ErrFailedPrecondition` with GitHub's validation details, for example "Review
  cannot be requested from pull request author." A secondary or primary rate limit on a
  REST write pauses everything. Content-creation limits are shared, and the REST core
  budget running out on our few writes is not realistic.
* **Teams.** The request accepts `org/team` or a bare slug, and REST gets the slug. The
  response's `requested_teams` have no org, so the base repository's owner is used.
  Candidates list teams only when they are already requested. Listing org teams would
  need `read:org` and another query; this is left for later.
* **Revert** uses the node id from the detail (cached, or fetched). A PR merged since it
  was cached gets one refresh before the store refuses. If the PR is not merged, the
  store returns `ErrFailedPrecondition` (Connect FAILED_PRECONDITION) without calling the
  mutation. A second revert of the same PR within 2 minutes returns the first result, so
  a double click cannot open two revert PRs. The check runs again on the serial worker.
  Afterwards the store polls soon so the new PR shows up on the dashboard.
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
* `internal/api/gh_detail_test.go`: table tests of the four RPCs (every field mapped, the
  error codes, and the Watch event).
* Frontend:
  * `api/mapping.test.ts`: detail, candidate, and event mapping
  * `stores/ghDetail.test.ts`: the resource key, event-driven re-read, and refresh

## Mock daemon

* `mock/prDetail.ts` serves all four RPCs:
  * #145 (open, draft): failing checks, changes requested (stale), a team and a user
    pending, a bot review, 2 unresolved threads and 1 resolved outdated thread, labels,
    issue comments
  * #138 (merged): merge commit `3c3c4651aa…` (the mock main head), an approval, a
    resolved thread
  * any other listed PR: a minimal detail from its summary

  Revert of #138 adds PR #151 to the dashboard and returns the same result on repeats.
  Reverting an open PR returns FAILED_PRECONDITION.
* `POST /__mock/gh/pr-comment?repo=…&number=…&body=…` adds a comment and sends
  `pull_request_detail_updated`, as a poll would.

## Gotchas

* The fake runner's operation regex now accepts `mutation`.
* `requestedReviewer` can be `null` (a team the token cannot read). It is skipped both
  in reviewers and in candidates.
* A missing PR comes back as a NOT_FOUND part next to `pullRequest: null`, with HTTP 200.
  The store reports GitHub's message, not the decoder's.
* `reviewThreads.line` is `null` for outdated threads; `originalLine` is used then.
* Per CLAUDE.md, user actions belong in `internal/command`. SetReviewRequest and
  RevertPullRequest are RPCs as this chunk specified. The GUI chunk should wrap them as
  commands (for example `pr.revert`, `pr.reviewers.set`) so the palette and CLI get
  them; the TS client calls exist for that.
