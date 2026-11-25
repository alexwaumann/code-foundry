# Sleep/wake recovery for `gh.Store` and `project.Git`

Status: implemented on branch `perf/gh-project-sleep-wake`. Verified with `go test -race -count=1 ./internal/store/gh/... ./internal/store/project/...` and `make check`.

## Problem

When a Mac sleeps and wakes up:

1. Pooled keep-alive TCP sockets in `gh.HTTPRunner` are silently dropped by NAT/GitHub during sleep and sit half-open on resume.
2. GraphQL reads are HTTP `POST` requests, so Go's `net/http` does not retry when a reused keep-alive connection returns `io.EOF` / `ECONNRESET` / `EPIPE` before any response headers arrive.
3. `gh.Store.noteResult` treated that single stale-socket `ErrNetwork` as a global network outage and started a 15-second pause (`DefaultNetworkBackoff`), causing every subsequent interactive PR read to fail fast for 15 seconds without trying.
4. On macOS, Go's monotonic clock (`mach_absolute_time`) pauses during system sleep while the wall clock advances. Both `gh.Store` timers and `project.Git`'s `tierLoop` timers and `tierSched.due` checks waited on pre-sleep monotonic deadlines, leaving polls and remote fetches waiting up to 2–15 minutes after wake.

## What changed

| Path | What |
|---|---|
| `internal/store/gh/sleepwake.go` | `ConnectionDropper` interface (`CloseIdleConnections()`), wall-vs-monotonic `sleepDetector` / `sleepJump`, `Store.onWake`, `HTTPRunner.CloseIdleConnections`, `isConnResetErr`, `isMutationDoc`, `shouldRetryConnReset` |
| `internal/store/gh/http.go`, `http_raw.go` | `sendOpts.idempotent` (true for GraphQL queries, `REST`, `RESTRaw`, `AuthStatus`; false for GraphQL mutations and `RESTWrite`); single fresh-connection retry in `send`/`sendOnce` on pre-response stale-socket reset |
| `internal/store/gh/store.go` | `sleepDet` initialized in `New`, 5s heartbeat tick case in `Run` (zero extra goroutines), opportunistic skew check in `submit` / `submitBackground` |
| `internal/store/project/sleepwake.go` | Wall-vs-monotonic `sleepDetector` / `sleepJump`, `Git.runWakeMonitor`, `Git.onWake` (low-priority `jobReconcile` + `jobBase` for live projects and fetch loop wake) |
| `internal/store/project/store.go`, `activity.go` | `fetchWake` channel wired into fetch `tierLoop`, wall-clock `Round(0)` comparison in `tierSched.due`/`wait`, `runWakeMonitor` started under `g.wg` |
| `internal/store/gh/sleepwake_test.go`, `internal/store/project/sleepwake_test.go` | Deterministic unit and integration tests with zero real sleeps |

## Decisions & Invariants Preserved

* **Mutations and `RESTWrite` are never retried.** `isMutationDoc` scans top-level GraphQL tokens (skipping `#` comments, string literals, and preceding fragment blocks) so any `mutation` or `subscription` sets `idempotent: false`, and `RESTWrite` leaves `idempotent: false`. Even within the post-wake grace window, writes never retry on connection reset.
* **Only pre-response connection resets retry, and at most once.** `sendOnce` tracks `httptrace.GotConnInfo.Reused` and `GotFirstResponseByte`. A retry runs only when `resp == nil && !gotFirstByte`, `ctx.Err() == nil`, and `isConnResetErr(err)` matches `io.EOF`, `io.ErrUnexpectedEOF`, `ECONNRESET`, `EPIPE`, `ECONNABORTED`, `net.ErrClosed`, or Go's bundled http2 connection-lost/GOAWAY errors (never `ECONNREFUSED`, timeouts, or caller cancellation). If the single fresh retry also fails (genuinely offline), normal `ErrNetwork` pause/backoff applies unchanged.
* **Rate-limit and auth pauses are never cleared or bypassed on wake.** `Store.onWake` clears `pauseUntil`/`pauseErr` only when `errors.Is(pauseErr, ErrNetwork) && !errors.Is(pauseErr, ErrRateLimited)`. Rate-limit pauses strip only their monotonic reading (`Round(0)`) so an already-expired pause does not stay stuck behind a paused monotonic clock while any still-active rate-limit pause remains enforced. `authBad`/`authNext` are untouched.
* **No change to `idleConnTimeout` (remains `25s`) or worker concurrency/lanes.** `gh.Store.Run` handles the 5-second wake tick directly in its existing `select` loop with zero extra goroutines.
* **Skew-only wake detection in `gh.Store`.** `gh.Store`'s `sleepDetector` triggers strictly on wall-vs-monotonic skew (`wallDelta - monoDelta >= 10s`, where `wall` is `t.Round(0)` and `mono` is `t`). Because `Store.Run` executes HTTP calls inline (up to 30s timeout), relying on skew alone guarantees a busy worker during a real network outage never reads as a wake and never resets `globalFailures` or network backoff. `checkSkew` also runs opportunistically on interactive `submit` so a click immediately after lid-open recovers before the 5s ticker fires, without double-firing on the next tick. Backward NTP jumps never trigger, and `project.Git`'s `tierSched` uses `max(wallDelta, monoDelta)` (treating negative elapsed on wall-only clocks as immediately due) so backward wall-clock steps never stall polling/fetching.
* **Live projects only on wake in `project.Git`.** `onWake` requests `prioLow` `jobReconcile` + `jobBase` and wakes the fetch `tierLoop` for live projects (`projectLive`), avoiding a thundering herd across idle repositories while still letting idle projects whose wall-clock `IdleFetchInterval` genuinely expired during a long sleep become due.
* **Real-world wake caveat.** The measurements below use deterministic loopback sockets and fake clocks. On a real Mac wake, Wi-Fi may take 1–3 seconds to re-associate; if the immediate post-wake poll or `git fetch` runs before the interface comes up, it hits a dial error (not a connection reset) and falls back to normal backoff/scheduling. Clearing dead keep-alive sockets and stale pre-sleep network pauses still avoids the 15s wait once connectivity returns.

## Measured Before vs After

Measured deterministically on this machine with real loopback HTTP/TCP half-open sockets (`SetLinger(0)` RST and FIN close after request 1 on a reused keep-alive connection), real `gh.Store` (`DefaultNetworkBackoff = 15s`, `DefaultMaxBackoff = 15m`, `PollInterval = 5m`), and real git fixtures in `project.Git` (`FetchInterval = 5m`, `PollInterval = 5m`, `IdleFetchInterval = 15m`).

| Scenario | Before | After |
|---|---|---|
| Half-open `EOF` on reused keep-alive GraphQL read (`gh.Store`) | Read 1 fails (`ErrNetwork: EOF`, `480µs`), triggers **15s** global network pause; Read 2 fails fast (`paused until ...`, `32µs`); `handled=1` | Retries once on fresh conn: Read 1 succeeds (`<nil>`, `3.56ms`), **0s** pause (`pause_set=false`); Read 2 succeeds (`<nil>`, `2.83ms`); `handled=5` |
| Half-open `ECONNRESET` on reused keep-alive GraphQL read (`gh.Store`) | Read 1 fails (`ErrNetwork: connection reset by peer`, `319µs`), triggers **15s** global network pause; Read 2 fails fast (`23µs`); `handled=1` | Retries once on fresh conn: Read 1 succeeds (`<nil>`, `3.50ms`), **0s** pause (`pause_set=false`); Read 2 succeeds (`<nil>`, `2.68ms`); `handled=5` |
| Dead keep-alive GraphQL mutation / `RESTWrite` | Fails with `ErrNetwork`, `0` retries (`new_handled=0`) | Still fails with `ErrNetwork`, **0 retries** (`dropped=1`, `handled=1`) |
| 5-minute wake jump in `gh.Store` (foreground, pre-sleep `ErrNetwork` pause) | `CloseIdleConnections=0`, `polls=1` (next poll in `5m0s`), `14.9s` pause remains, post-wake read fails fast | `CloseIdleConnections=1`, stale net pause cleared (`<nil>`), immediate foreground poll (`polls=2`), post-wake read succeeds (`<nil>`) |
| 5-minute wake jump in `gh.Store` (active rate-limit or auth pause) | Pause preserved | Pause still preserved (`0` unsolicited polls; rate-limited reads still return `ErrRateLimited`; `authBad` unchanged) |
| 5-minute wake jump in `project.Git` (1 live + 1 idle project, remote commit landed during sleep) | `fetch_delta=0`, `rev_parse_delta=0`, `worktree_delta=0` (waits up to `5m` / `15m`) | Immediate live refresh: `fetch_delta=1` (live project only, picks up `BaseBehind=1`), `rev_parse_delta=3`, `worktree_delta=1`; idle project not force-fetched |

## Gotchas

* **Half-open TCP writes succeed locally.** On a half-open socket after sleep, writing the HTTP request headers and body into the local kernel send buffer succeeds (so `httptrace.WroteHeaders` fires) before the peer's `RST`/`EOF` arrives on read. Gating retries on `resp == nil && !gotFirstByte` (rather than `!wroteHeaders`) is required for real half-open recovery.
* **Go monotonic clocks pause during macOS sleep.** Both `time.Time.Before` and `time.Time.Sub` compare monotonic readings when both operands came from `time.Now()`. Using `t.Round(0)` strips the monotonic reading so wall-clock intervals (`sleepJump`, `tierSched.due`/`wait`, and remaining rate-limit deadlines) advance across sleep.
