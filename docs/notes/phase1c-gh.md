# Phase 1c: GitHub store

Status: done on branch. `make check` is green. The behavior was exercised end to end:
a daemon with a temp `CODE_FOUNDRY_HOME`, real `gh` 2.83.2 against `ghostty-org/ghostty`,
`buf curl` over the Unix socket, then a second daemon start.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/gh.proto` | `GhService`: GetViewer, ListPullRequests, GetPullRequest, ListChecks, Refresh, Track, Untrack, Watch |
| `internal/store/gh` | `Store` (paced poller + cache), `Service` interface, `Runner`/`ExecRunner` (gh exec), GraphQL in `queries/*.graphql` (embedded), `schema.sql` + `Migrate` |
| `internal/store/gh/ghtest` | in-memory fake `gh.Service` that publishes the same bus events |
| `internal/api/gh.go` | thin handler. It maps domain to proto and errors to Connect codes. Watch streams bus events |
| `internal/daemon/gh.go` | `startGh`: opens the DB, migrates, starts `Store.Run`, returns route + stop |
| `internal/daemon/daemon.go` | `bus.New()`, `startGh(...)`, `defer stopGh()`, route appended |

## Merge integration points

* **Migrate**: `internal/daemon/gh.go` `startGh` calls `gh.Migrate(ctx, db)` on its own
  handle from `openGhDB(p.DB())`, which is the same file 1b's `internal/db` opens. At merge,
  pass 1b's shared `*sql.DB` into `startGh` and delete `openGhDB`. You can either keep
  the `gh.Migrate` call there or move it next to 1b's migration runner. It is idempotent
  (`CREATE … IF NOT EXISTS`) and touches only `gh_*` tables. If you prefer one migration
  system, copy `internal/store/gh/schema.sql` to `internal/db/migrations/NNNN_gh.sql`
  and drop the call.
* **Track/Untrack**: `startGh` returns the `*gh.Store` as its first result (currently
  `_` in daemon.go). Hand it to the repo store and call `store.Track(repo.GithubSlug)` on
  register and on daemon start for every registered repo with a GitHub remote. Call
  `store.Untrack(slug)` on unregister. Both are cheap, non-blocking, and idempotent. They
  accept any case and normalize to lower case. They return `gh.ErrInvalidSlug` for a
  non-`owner/name` slug. The tracked set is not persisted: the repo store owns it.
* **Bus**: daemon.go now creates `events := bus.New()`. Other steps that add a bus
  should share this one. `gh.PullRequestsUpdated` and `gh.ViewerUpdated` are the event types.
* **Shutdown**: `api.NewGh(store, bus, ctx.Done())`. Watch streams end on daemon
  shutdown, so `http.Server.Shutdown` does not wait the 5s bound for them.

## Decisions

* **Only gh, never a token.** (Superseded: the store now sends HTTP requests itself with
  the token from `gh auth token`; see `gh-http-transport.md`.) Every request was
  `gh api graphql -f query=<doc> [-f str=…] [-F int=…]`. String variables use `-f` (raw)
  so a repo named `true` or `123` is not type-converted. Auth checks use
  `gh auth status --json hosts --hostname github.com`, which exits 0 regardless of auth
  state, so its JSON is authoritative: the *active* github.com account with
  `state == "success"`. gh runs with `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`,
  `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `GH_PAGER=`, a 30s timeout, and
  `WaitDelay` 2s.
* **One worker goroutine owns the network** (`Store.Run`). Track, Refresh, and the
  on-demand reads only enqueue or mark work due and then wake it. On-demand jobs
  (Refresh, GetPullRequest, ListChecks) go before scheduled polls. Identical queued jobs
  coalesce, so two GUI clients asking for the same PR cause one fetch.
* **Typed errors** (`errors.Is`): `ErrNotAuthenticated`, `ErrRateLimited`
  (`*RateLimitError{Secondary}`), `ErrNotFound`, `ErrNetwork`, `ErrServerTimeout`,
  `ErrInvalidSlug`, `ErrInvalidArgument`. Classification is a pure function over exit code,
  stdout body (GraphQL `errors[].type` first), and stderr. Connect codes: NotFound,
  FailedPrecondition (gh not authenticated; not `Unauthenticated`, which would read as
  the daemon's bearer auth), ResourceExhausted, Unavailable, InvalidArgument.
* **Snapshot + bus**: `atomic.Pointer[Snapshot]` with copy-on-write. `RepoState` and
  `ViewerState` carry `FetchedAt` and `LastError`. `PullRequestsUpdated` is published on
  track/untrack, on every successful poll (so the UI's `fetched_at` stays current), and
  when a repo's error message changes. It is not published on repeated identical failures.
* **Cache**: four tables (`gh_viewer`, `gh_pull_requests`, `gh_pull_request_details`,
  `gh_ref_checks`). The payload is the domain JSON in `{"v":1,"data":…}`, and rows with
  another version are ignored. Times are unix ms, so `fetched_at` after a restart has
  millisecond precision. Detail and ref-check rows older than 7 days are pruned on start.
  `New` loads the viewer and every PR list into the snapshot before `Run`, so List and
  GetViewer answer instantly on daemon start.
* **Restart behaviour**: a viewer cached less than 10 minutes ago is not refetched at
  startup. `Track` on a repo whose cache is younger than 60s schedules its first poll
  when the cache expires, so a restart with many repos does not burst.
* **Detail reads** (GetPullRequest, ListChecks) serve the cache when younger than 30s.
  Otherwise they fetch through the queue. If the fetch fails and a cached copy exists,
  they return the stale copy with `last_error` set instead of an error. During a
  rate-limit or network pause they fail fast instead of queueing behind the pause.
* **Refresh(slug)** is synchronous: it returns when the fetch is done. `Refresh("")`
  marks the viewer and all tracked repos due and returns immediately.
* **Watch flushes headers immediately** (`stream.Send(nil)`) *after* subscribing. Both
  connect-go and connect-web clients block until response headers arrive, and the first
  event can be a poll interval away. Subscribing first means nothing published after
  the client sees the stream open is lost.
* **Enum mapping is a lookup, not a switch**: `enumOf` maps GitHub's string to
  `v1.X_value[prefix+s]`, and unknown values become `*_UNSPECIFIED`. New GitHub enum
  values degrade gracefully.
* **Check bucketing** follows `gh pr checks`. SUCCESS → passed. SKIPPED, NEUTRAL, STALE →
  skipped. FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE →
  failed. Everything else → pending. Legacy commit statuses map onto the check-run shape
  (SUCCESS → COMPLETED/SUCCESS, FAILURE/ERROR → COMPLETED/FAILURE, PENDING/EXPECTED →
  PENDING). Detail check lists sort as failed, pending, passed, skipped, then by workflow
  and name.

## Pacing

| Knob | Value | Why |
|---|---|---|
| In flight | 1 | single worker |
| `MinGap` | 2s idle between the end of one request and the start of the next | see below |
| `RepoInterval` | 60s ±20% jitter per tracked repo | |
| `ViewerInterval` | 10 min | |
| Per-repo error backoff | 60s × 2^(n-1), cap 15 min, ±20% jitter | not found, decode errors, unknown failures |
| Network error | global pause 15s × 2^(n-1), cap 15 min | offline, DNS, HTTP 503 |
| Secondary rate limit / 429 | global pause 60s × 2^(n-1), cap 15 min | GitHub: wait ≥ 1 min |
| Primary rate limit | global pause until last seen `resetAt` + 5s | |
| Low budget | `rateLimit.remaining < 200` → pause until `resetAt` + 5s | every query selects `rateLimit` |
| Not authenticated | poll only `gh auth status`, 60s × 2^(n-1), cap 15 min | resumes everything when it reports success |
| HTTP 502/504 on a PR list | halve that repo's page size (floor 5), retry immediately | GitHub's 10s GraphQL timeout |

Rationale:

* **macOS securityd.** Every request is a new `gh` process. It reads the OAuth token
  from the login keychain and makes a fresh TLS connection, and on macOS both go through
  `securityd` (keychain item access and trust evaluation). Parallel or back-to-back gh
  processes queue on securityd, raise its CPU, and can stall unrelated apps' TLS. Serial
  requests with idle gaps keep that load flat.
* **GitHub secondary limits** punish concurrency and bursts. GitHub's guidance is no
  more than 100 concurrent requests, at most 2,000 GraphQL points per minute, and serial
  requests where possible. At one request per ≥2s we stay under 30 requests a minute.
* **Primary limit** is 5,000 points/hour for GraphQL. Every query here costs 1 point
  (observed `rateLimit.cost` = 1 for all four). One repo polled every 60s with up to 4
  pages is at most 240 points/hour. A typical repo with fewer than 25 open PRs needs 1
  page, so about 60 points/hour.

## GraphQL shapes

All four queries were validated against GitHub's public schema
(`docs.github.com/public/fpt/schema.docs.graphql`) with gqlparser, then run live.
Fragments live in `queries/fragments.graphql`. `queries.go` appends to each query exactly
the fragments it uses, transitively, because GitHub rejects unused fragments.

* `viewer.graphql`: `viewer { login name avatarUrl url }`.
* `pull_requests.graphql`:
  `repository.pullRequests(states:[OPEN], first:$first, after:$after, orderBy:{UPDATED_AT, DESC})`
  with `totalCount`, `pageInfo`, and per node `PullRequestFields` plus
  `commits(last:1).nodes.commit { oid statusCheckRollup { state contexts { RollupCounts } } }`.
  `RollupCounts` is `checkRunCount`, `checkRunCountsByState {state count}`,
  `statusContextCount`, and `statusContextCountsByState`. The aggregates count the whole
  connection, so a 104-check PR costs the same as a PR with no checks, and no `first:`
  is needed when no nodes are selected.
* `pull_request.graphql`: `repository.pullRequest(number:)` with `PullRequestFields`,
  `headRepository { nameWithOwner }`, `mergeStateStatus`, and the head commit's
  `statusCheckRollup.contexts(first:100, after:$after)` with `CheckContexts`. That is
  `RollupCounts`, `pageInfo`, and nodes that are `... on CheckRun { name status
  conclusion detailsUrl startedAt completedAt checkSuite.workflowRun.workflow.name }`
  or `... on StatusContext { context state targetUrl description createdAt }`.
* `checks.graphql`: `repository.object(expression:$ref) { ... on Commit { oid
  statusCheckRollup { state contexts(first:100, after:$after) { CheckContexts } } } }`.
  `object` is null for an unknown ref, and `{}` (no `oid`) for a non-commit, for
  example a tree. Both return NotFound.

Measured server time on ghostty-org/ghostty (~130 open PRs, ~100 checks per PR), per
100 PRs requested with only the listed field added:

| Field(s) | Time |
|---|---|
| `number title updatedAt` | 1.0s |
| `title url isDraft author headRefName baseRefName headRefOid isCrossRepository` | 0.6s |
| `headRepository { nameWithOwner }` | 3.0s |
| `reviewDecision` | 5.6s |
| `mergeable` | 1.2s |
| `statusCheckRollup { state }` | 3.3s |
| rollup `contexts` counts by state | 10.3s |
| `mergeStateStatus` | >11s → HTTP 502 |

The full list query takes about 95ms per PR: 2.6s at 25 PRs, 4.7s at 50, and 502 at 100.
That led to `DefaultPageSize = 25` and `DefaultMaxPages = 4` (the 100 most recently
updated open PRs; `total_count` still reports all of them). It also means
`mergeStateStatus` and `headRepository` appear only in the single-PR query, so
`merge_state_status` and `head_repo_slug` are set by GetPullRequest only (documented in
the proto).

## Fixtures

`internal/store/gh/testdata/` holds real `gh api graphql` output, captured with the
assembled queries from this machine against ghostty-org/ghostty on 2026-10-08:

* viewer
* PR list pages 1 and 2
* PR 14586 detail, pages 1 and 2 (104 checks)
* checks on `main`
* an unknown ref
* repo and PR NOT_FOUND bodies, with gh's stderr

The viewer identity is sanitized to `octocat`. The auth fixtures are real too:

* `gh auth status --json` with no hosts (empty `GH_CONFIG_DIR`)
* the same with a bogus `GH_TOKEN` and the keyring account inactive
* the same logged in
* gh's exit-4 stderr when logged out
* the `Bad credentials (HTTP 401)` stdout and stderr

`*_synthetic.json` files were built by hand in the same shape, for cases ghostty cannot
produce: legacy commit statuses mixed with check runs, and a RATE_LIMITED error body.
To recapture, run the queries with
`gh api graphql -F query=@<assembled query> -f owner=… -F first=25`. A dump test that
writes the assembled queries is a two-line `loadQueries()` loop.

## End-to-end run (2026-10-08)

```sh
CODE_FOUNDRY_HOME=/tmp/cf1c-home ./bin/code-foundry daemon --dev &
buf curl --protocol connect --http2-prior-knowledge --unix-socket /tmp/cf1c-home/daemon.sock \
  --schema proto -d '{}' http://localhost/codefoundry.v1.GhService/GetViewer
```

* `GetViewer` returned the logged-in account (`authenticated: true`, `fetchedAt`). The
  first request after start was the viewer query (346ms, cost 1).
* `ListPullRequests` on an untracked, never-fetched repo returned `{}`. After `Track`,
  the log showed 4 `pull_requests` pages at `first:25`, each starting 2.0s after the
  previous ended (2.4 to 3.2s each). The response had `tracked: true`,
  `totalCount: 129`, and 100 PRs, newest first. The rollups were 67 SUCCESS, 4 FAILURE,
  2 PENDING, and 27 with no checks. For example #13745 was `{SUCCESS, total 102,
  passed 97, skipped 5}`, and draft #14055 was `{PENDING, passed 91, pending 4,
  skipped 7}`.
* `Watch` received `pullRequestsUpdated` on track (no `fetchedAt`), then after each poll.
  On SIGTERM it ended within 1ms and the daemon exited 0.
* `GetPullRequest` #14586 took 4.2s cold (2 pages) and returned `BLOCKED`,
  `kgni/ghostty`, and 104 checks with workflow names and job URLs. A repeat took 40ms
  from cache. `ListChecks main` returned sha `a60e9e2…` and 54 checks (4 passed,
  50 skipped). An unknown ref gave `not_found`, an unknown repo gave `not_found` with
  GitHub's message, and a bad slug gave `invalid_argument`.
* **Second daemon start on the same home**: the log showed `gh store loaded cache
  repos=1 viewer=true`. `ListPullRequests` answered in 35ms with the 100 cached PRs
  (`tracked: false`, the earlier `fetchedAt`), and `GetViewer` answered from cache. No
  gh request had been made. `Track` then logged `first_poll_in=41s`, because the cached
  list was 19s old.

## Gotchas

* **GitHub's GraphQL timeout is ~10s and shows up as `gh: HTTP 502` with an empty
  body.** It is not a network error. It is classified as `ErrServerTimeout`, with no
  global pause, and the repo's page size is halved.
* `*CountsByState` returns an entry for **every** state, mostly with count 0. Sum them;
  don't count entries.
* `statusCheckRollup` is `null` for a commit with no checks (27 of 100 ghostty PRs),
  which maps to an all-zero rollup with state UNSPECIFIED.
* gh exits **4** when not logged in. Its stderr says
  `To get started with GitHub CLI, please run:  gh auth login`, and stdout is empty.
  A bad token exits 1 with the REST error JSON on stdout and `gh: Bad credentials (HTTP
  401)` on stderr. GraphQL errors exit 1 with the full `{"data":…,"errors":[…]}` body on
  stdout, so the body's `errors[].type` is checked before stderr.
* `gh auth status` without `--json` exits 1 when logged out, but with `--json` it always
  exits 0. With `GH_TOKEN` set, the env account is the active one and the keyring
  account is listed as inactive.
* A daemon auto-started from a Finder-launched app inherits launchd's minimal PATH,
  which has no Homebrew. `gh.LookPath` falls back to `/opt/homebrew/bin/gh` and
  `/usr/local/bin/gh`.
* Existing tests that run `daemon.Run` in-process (`internal/client`) now also start the
  gh poller. Each makes one real `gh` viewer call, which fails harmlessly without auth
  (for example in CI) and is cancelled at shutdown.
* gh was **not** authenticated when this step started (`gh auth status`: not logged
  in). It became authenticated (keyring) partway through, and live capture and the
  end-to-end run happened after that.
