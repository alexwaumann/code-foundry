# gh store: in-process HTTP transport

> **Superseded (2026-10-10):** `repo.register` (`code-foundry repo register --path`) was removed. Add a folder with `code-foundry repo add <folder>` on the CLI, or the Add Project dialog (`repo.add`) in the app; see `add-project-remove-register.md`. Mentions below are historical.

Status: done on branch `t3code/review-gh-git-diff-services`. `make check` is green. The
change was exercised end to end with scratch daemons (`CODE_FOUNDRY_HOME=$(mktemp -d)`):
one logged in as `alexwaumann`, and one started with `GH_TOKEN=bogus`.

The GitHub store no longer starts a `gh` process for each request. It sends GraphQL and
REST requests itself over one long-lived `*http.Client`. The token still comes from gh:
`gh auth token --hostname github.com` runs once at startup, then again only when needed.
What is polled, the query shapes, and the scheduling in `poll.go`/`activity.go` are
unchanged.

## What changed

| Path | What |
|---|---|
| `internal/store/gh/http.go` | `HTTPRunner` (implements `Runner` and `RESTRunner`): token cache, 401 → re-resolve → retry once, `send`, `parseGraphQLResponse`, `classifyHTTP`, rate-limit headers |
| `internal/store/gh/token.go` | `TokenSource`, `GhToken` (`gh auth token`), `ErrNoToken`, `LookPath` (moved here from runner.go) |
| `internal/store/gh/runner.go`, `runner_rest.go` | `ExecRunner`, gh argv building, stderr classification and `gh auth status` parsing removed. The `Runner`/`RESTRunner` interfaces, `classifyGraphQLErrors`, and `RateLimitError` remain. `RateLimitError` gained `RetryAfter` and `ResetAt` |
| `internal/store/gh/pace.go` | `DefaultMinGap` 2s → **1s**; `rateLimitPause` (honors retry-after / x-ratelimit-reset) |
| `internal/store/gh/store.go` | default runner is `NewHTTPRunner`; `noteResult` uses `rateLimitPause` |
| `internal/store/gh/poll.go`, `gh.go` | comments only (`checkAuth` now means token re-resolution + `GET /user`) |
| `internal/daemon/stores.go` | `gh.NewHTTPRunner{Tokens: GhToken{Path: advanced.gh_path}, UserAgent: code-foundry/<version>}` |
| tests | `http_test.go` (httptest server), `token_test.go`, `TestRateLimitPause`, `TestStoreSecondaryLimitHonorsRetryAfter`; `runner_test.go` removed |
| testdata | `stdout_bad_credentials.json` → `http_401_bad_credentials.json` (the same body). The `stderr_*.txt` and `auth_status_*.json` fixtures are deleted because nothing parses gh output any more |

The `Runner` interface is unchanged (`GraphQL`, `AuthStatus`), so `ghtest` and the store
tests' `fakeRunner` work as before. `AuthStatus.TokenSource` was dropped because nothing
read it.

## Decisions

* **The token comes from `gh auth token --hostname github.com`.** The gh path is
  `advanced.gh_path` when set, otherwise `LookPath()` (PATH, then the Homebrew
  locations). Using gh's own answer means `GH_TOKEN` overrides, keyring vs. file
  storage, and `gh auth switch` all behave as they do for gh. The token is cached in
  memory and resolved again:
  * on a **401**: re-resolve, and retry the request once **only if gh now returns a
    different token**. Sending the same rejected token again would fail the same way,
    and the bogus-token run below confirmed that. If the retry also gets a 401, or the
    token did not change, the result is `ErrNotAuthenticated`.
  * after **`TokenTTL` (15 min)**. After `gh auth switch` or a re-login as another
    account, the old token usually stays valid, so a 401 would never prompt a switch.
    Each re-resolution costs about 50ms (one gh process and one keychain read), so 4
    an hour is noise.
  * on every **auth check**, while the store is paused as unauthenticated.
* **No token is `ErrNotAuthenticated`.** That covers gh not installed, not logged in, a
  hung keychain, and the 15s timeout. The store then takes its usual auth-paused path
  (poll `AuthStatus` with backoff, resume on success). Before this change a missing gh
  binary was an unclassified per-request error.
* **`AuthStatus` (used by `checkAuth`)** forces token re-resolution, then sends
  `GET /user`. That costs one REST core point; the GraphQL budget is untouched. 200
  returns `LoggedIn` with the login. 401, or no token at all, returns `LoggedIn=false`
  with the reason in `Error`. A transport failure returns an error, as before. The
  store's auth-paused/resume logic is unchanged.
* **HTTP client.** It is a clone of `http.DefaultTransport` with HTTP/2,
  `MaxIdleConnsPerHost=2`, `IdleConnTimeout=5m` (now 25s, see below),
  `TLSHandshakeTimeout=10s`, and `ResponseHeaderTimeout=30s`. Each request has a 30s
  context timeout that also covers reading the body, and bodies are capped at 32 MiB.
  Requests send these headers:
  * `Authorization: Bearer`
  * `User-Agent: code-foundry/<version>`
  * `Accept: application/vnd.github+json`
  * `X-GitHub-Api-Version: 2022-11-28`
  * `Content-Type: application/json` on the GraphQL POST

  gzip is negotiated by the transport.
* **GraphQL variables** are sent as JSON, with nil values omitted. Strings stay strings,
  so a repo named `true` is safe without gh's `-f`/`-F` distinction.
* **Error classification** maps onto the same sentinels the gh-stderr parser produced:

  | Response | Error |
  |---|---|
  | body has `errors[]` (even with HTTP 200 and `data`) | `NOT_FOUND` → `ErrNotFound`; `RATE_LIMITED` → `*RateLimitError` (secondary if the message says so); anything else → unclassified (per-repo backoff) |
  | 401 | `ErrNotAuthenticated`, message `Bad credentials (HTTP 401)` like gh's |
  | 403/429 + "secondary rate limit"/"abuse" in the message | `*RateLimitError{Secondary}` |
  | 403/429 + `x-ratelimit-remaining: 0` or "rate limit exceeded" | `*RateLimitError` primary, `ResetAt` from `x-ratelimit-reset` |
  | 429 or `retry-after` without a recognizable message | `*RateLimitError{Secondary}` |
  | other 403 (permissions, SSO) | unclassified |
  | 404 | `ErrNotFound` |
  | 502, 504 | `ErrServerTimeout` (GitHub's ~10s GraphQL limit; the page-size halving still applies) |
  | 503 | `ErrNetwork` |
  | other non-2xx | unclassified, `github: <message> (HTTP n)` |
  | dial/DNS/TLS/reset, or our 30s timeout | `ErrNetwork` (wraps the cause, so `errors.Is(err, context.DeadlineExceeded)` holds for timeouts) |
  | the caller's ctx cancelled | the ctx error, not global |

* **Retry-After is now honored.** gh never surfaced the header; the store sees it now.
  `rateLimitPause` picks the resume time:
  * `retry-after` present: now + retry-after + 1s.
  * Primary limit: the later of that and `ResetAt` (header) or the last seen `resetAt`,
    + 5s.
  * Neither: the old jittered `SecondaryBackoff` (≥ 1 min).

  On-demand calls during the pause still fail fast.
* **GitHub Enterprise is out of scope.** `BaseURL` is `https://api.github.com` and the
  token is pinned to `--hostname github.com`. `HTTPOptions.BaseURL` exists for tests,
  and GHE would also need its `/api/graphql` path and the token for its host.
* **No settings or cache changes.** `advanced.gh_path` now feeds the token lookup.
  `internal/store/gitops` (user-initiated `gh pr create` and so on) and the updater still
  use the gh CLI.

## Measurements (2026-10-08, this machine, `alexwaumann`)

Viewer query (`queries/viewer.graphql`, cost 1), serial, 0.5s apart. Two runs of a
throwaway live test that ran both runners on the same query, before `ExecRunner` was
deleted:

| Path | Run 1 | Run 2 |
|---|---|---|
| `gh auth token` alone | 56, 52, 45 ms | 53, 47, 44 ms |
| old: `gh api graphql` per request | 736, 520, 989, 752, 758 ms | 570, 445, 463, 449, 452 ms |
| old: CPU of the 5 gh children (user+sys, excludes securityd) | 304 ms (~61 ms/request) | 348 ms (~70 ms/request) |
| new: first request (token + TLS + HTTP/2 setup) | 611 ms | 430 ms |
| new: warm keep-alive requests | 287, 658, 256, 279, 266 ms | 215, 219, 233, 203, 211 ms |
| new: fresh connection, cached token | 379, 420 ms | 391, 522 ms |

* A warm request saves about 250ms of wall time (median ~450–750ms → ~210–280ms). It
  also removes ~65ms of CPU in our children per request, and the keychain and TLS work
  that securityd did for every request.
* What remains is GitHub's server time. Reconnecting costs about +150–250ms (TLS).

In the daemon (debug log, `msg="github http"`, all over HTTP/2):

| Request | Duration |
|---|---|
| startup: `gh auth token` | 130 ms |
| startup: first viewer request (new connection) | 414 ms |
| dashboard searches | 464–584 ms |
| `viewer_stats` | 584 ms |
| REST `search/commits` | 354–361 ms |
| `pull_requests` code-foundry | 338–574 ms |
| `repo_stats` | 671–802 ms |
| `pull_requests` ghostty (25 PRs/page, about 95ms of server time per PR) | 3.2–5.5 s |
| NOT_FOUND `pull_request` | 221 ms |

* Every request after the first had `reused_conn=true`, including after 30s idle.
* After 63s idle, in the bogus-token run, the request opened a new connection. Measured
  later (`gh-viewer-polling.md`): GitHub closes idle connections after ~30s (reused
  after 28s, new after 31s), so the client now drops its own at 25s. A reconnect costs
  ~150–400ms and is transparent.
* The ghostty pages are server time and unchanged by the transport.

## MinGap: 2s → 1s

The 2s gap protected securityd from back-to-back gh processes. That cost is gone. The
remaining constraints are GitHub's:

* **Secondary limits.** Keep requests serial (still one worker, one in flight), stay
  under ~2,000 GraphQL points/min, and avoid bursts. At 1s plus a ≥0.2s request the
  worker cannot exceed 50 requests/min.
* **Primary budget.** 5,000 points/hour, **shared per user** with Alex's other daemon,
  the `gh` CLI, and anything else on the token. `rl_remaining` in the log moved by more
  than our own requests. If the worker never idled, it would make at most
  3600 / (1s + 0.2s) = 3,000 requests/hour, so even a runaway schedule cannot drain the
  budget below `MinRemaining`. A 0.5s gap would allow ~5,100/hour, which can. So 1s is
  the smallest round gap where the pacing alone bounds the hourly cost.

The polling cadence itself (intervals, page counts) is unchanged and left to the
polling redesign (done: `gh-viewer-polling.md`).

## End-to-end runs

1. Logged in. The scratch home had `advanced.log_level = "debug"` and
   `repos.fetch_interval_seconds = 0`. Two repos were registered with
   `code-foundry repo.register`:
   * this repo
   * a stub `git init` whose origin is `ghostty-org/ghostty`, so there was no clone and
     no fetches

   `buf curl` over the Unix socket then showed:
   * `GetViewer`: `alexwaumann`, `authenticated: true`.
   * `GetDashboard`: stats `2026-10` with 215 commits (`commitsSource: search`, through
     REST) and both slugs tracked.
   * `ListPullRequests ghostty-org/ghostty`: `totalCount: 132` and 100 PRs (4 pages).
   * `GetRepoActivity`: default branch `main` `c770410`, rollup SUCCESS 98/103.
   * `GetPullRequest` on a missing repo: Connect `not_found` with GitHub's message.
2. `GH_TOKEN=bogus` (gh returns the bogus token):
   * The viewer request got a 401. The token was re-resolved, gh returned the same
     token, so there was no retry.
   * The store logged `gh is not authenticated; polling paused`.
   * About a minute later `checkAuth` re-resolved the token, sent `GET /user`, and got a
     401.
   * `GetViewer` returned only
     `lastError: "gh is not authenticated (run `gh auth login`): Bad credentials (HTTP 401)"`
     (`authenticated` is false, so the JSON omits it).

## Gotchas

* `gh auth token` with an empty `GH_CONFIG_DIR` still printed a token and exited 0: gh
  2.83.2 finds the keyring entry anyway. To simulate "logged out" use
  `GH_TOKEN=bogus` (a 401 path) or a fake gh. When gh truly has no token it prints
  `no oauth token found for github.com` and exits 1, and `parseTokenOutput` maps that to
  `ErrNoToken`.
* Never log the token. Only durations and errors are logged; `parseTokenOutput` rejects
  output containing whitespace, so a stray message is never sent as a bearer token.
* Tests that run `daemon.Run` in-process (`internal/client`) now run `gh auth token` plus
  one HTTPS request instead of one `gh api` process. Without gh or auth (CI) they fail
  harmlessly as not authenticated, as before.
* GraphQL `RATE_LIMITED` arrives with HTTP 200 (or 403). The rate-limit headers are read
  in both cases.
* REST `search/commits` has its own `search` budget (30/min, `rl_resource=search`). As
  before, only auth or network failures there have global effects.
