# gh HTTP/2 keep-warm and off-path token refresh

Status: implemented on branch `perf/gh-http2-keepwarm`.

## Problem

Two recurring stalls remained on interactive GitHub requests in `HTTPRunner`:

1. **Cold TCP + TLS + HTTP/2 reconnects (~100–120 ms)**: `internal/store/gh/http.go` drops idle connections at `idleConnTimeout = 25s` because `api.github.com` closes idle HTTP/2 connections around ~30s. After any idle gap >25s (including returning to foreground from background), the next poll or PR click pays DNS + TCP + TLS setup.
2. **Synchronous `gh auth token` subprocess stall (~60–130 ms every 15m)**: `HTTPRunner.resolveToken` ran `gh auth token` synchronously on whichever request crossed `DefaultTokenTTL` (15m).

## Step 1: Live HTTP/2 PING probe against `api.github.com`

Before changing `idleConnTimeout`, we ran a live probe (`go1.26.10 darwin/arm64`, `net/http.HTTP2Config{SendPingTimeout, PingTimeout}`) against `https://api.github.com` with `GODEBUG=http2debug=1` across 45s and 65s idle gaps:

| Configuration | Idle gap | Endpoint | `Reused` | DNS / TCP / TLS | Total |
|---|---|---|---|---|---|
| Baseline (`IdleConnTimeout=25s`, no PING) | 65s | `POST /graphql` | `false` | 2ms / 45ms / 51ms | 280ms |
| Control (`IdleConnTimeout=90s`, no PING) | 45s | `GET /rate_limit` | `false` | 32ms / 45ms / 58ms | 460ms |
| `SendPingTimeout=15s`, `PingTimeout=10s`, `IdleConnTimeout=90s` | 45s | `GET /rate_limit` | `false` | 3ms / 47ms / 58ms | 515ms |
| `SendPingTimeout=15s`, `PingTimeout=10s`, `IdleConnTimeout=90s` | 65s | `POST /graphql` | `false` | 1ms / 43ms / 52ms | 263ms |
| `SendPingTimeout=20s`, `PingTimeout=10s`, `IdleConnTimeout=90s` | 45s | `GET /rate_limit` | `false` | 3ms / 44ms / 52ms | 427ms |
| `SendPingTimeout=20s`, `PingTimeout=10s`, `IdleConnTimeout=90s` | 65s | `POST /graphql` | `false` | 2ms / 41ms / 45ms | 266ms |

Frame-level `GODEBUG=http2debug=1` trace confirmed why **Outcome B** applies:

- At +15s and +20s idle, Go sent HTTP/2 `PING` health checks and `api.github.com` replied `PING flags=ACK` (`health check success`).
- Despite successful `PING` ACKs, `api.github.com` still sent `GOAWAY LastStreamID=3 ErrCode=NO_ERROR` and closed every connection with `EOF` at **+30–32s** after the last HTTP stream.

**Decision**: Keep `idleConnTimeout = 25s` unchanged so we never race GitHub's ~30s `GOAWAY`/EOF close.

## Zero-cost connection pre-warming on foreground return (Outcome B)

We probed candidate warm-up endpoints live against `https://api.github.com` to verify HTTP/2 pool sharing with `POST /graphql` and check rate-limit cost:

| Warm-up request | Status | Proto | Body bytes | Core RL delta | Subsequent `POST /graphql` `Reused` |
|---|---|---|---|---|---|
| `GET /rate_limit` (auth) | 200 | HTTP/2.0 | 1235 | **0** (4976 → 4976) | `true` (189ms) |
| `HEAD /rate_limit` (auth) | 200 | HTTP/2.0 | **0** | **0** (4976 → 4976) | `true` (171ms) |
| `HEAD /rate_limit` (noauth) | 404 | HTTP/2.0 | 0 | n/a | `true` (238ms) |
| `HEAD /` (auth) | 200 | HTTP/2.0 | 0 | −1 (4993 → 4992) | `true` (173ms) |
| `GET /zen` (auth) | 200 | HTTP/2.0 | 43 | −1 (4975 → 4974) | `true` (185ms) |

**Decision**: Use authenticated `HEAD /rate_limit` in `HTTPRunner.WarmConnection(ctx)` (`internal/store/gh/keepwarm.go`) and trigger it asynchronously in `Store.PresenceChanged` (`internal/store/gh/presence.go`):

- Costs **0 core and 0 GraphQL rate-limit points** and transfers **0 body bytes**.
- Because Go's HTTP/2 transport pools connections as soon as the TCP+TLS+HTTP/2 handshake completes (~100–120ms), a `POST /graphql` arriving during or after the 500ms `pollDebounce` multiplexes directly onto the warmed connection (`reused_conn=true`).
- Tightly gated at both layers:
  - `Store.PresenceChanged`: only on presence rise to `PresenceForeground` (`to == PresenceForeground && to > from`), never when idle (`!Dashboards` and nothing tracked/watched), unauthenticated (`authBad`), paused (rate-limit or network backoff), or stopped.
  - `HTTPRunner.WarmConnection`: singleflight (`warming` guard), skipped if a connection succeeded within `warmFreshWindow` (15s, after any `lastWake`), capped by `warmCooldown` (20s) against rapid focus/blur flipping, skipped when `knownRejected` or closed, bounded by `warmTimeout` (5s), and never mutates store auth/pause state.

## Step 2: Soft-TTL background `gh auth token` refresh

`HTTPRunner` (`internal/store/gh/http.go`) now separates hard expiry (`TokenTTL`, default 15m) from a soft refresh threshold (`TokenSoftTTL`, default `TokenTTL * 4 / 5` = 12m):

- When a cached token is valid (`age < TokenTTL`) and `age >= TokenSoftTTL`, `resolveToken` returns the cached token immediately (0 ms) and spawns at most one coalesced background goroutine (`refreshing` guard, bounded by `DefaultTokenTimeout` and `bgCtx`) without holding `r.mu` during `Tokens.Token`.
- `resolveMu` serializes synchronous `Tokens.Token` calls (cold start, hard TTL expiry, and `force == true` 401 retry / `AuthStatus`) without holding `r.mu`, so concurrent cold callers (`WarmConnection` + worker) never spawn duplicate `gh auth token` subprocesses and a slow non-forced resolution can never overwrite a newer forced token.
- `tokenGen` increments on every synchronous resolution so an older in-flight background refresh can never overwrite a newer synchronous token.
- On background refresh error, the still-valid cached token is preserved until `TokenTTL` expires, and background retries are throttled by `bgRefreshRetry` (30s).
- `Store.Run` defers `shutdownRunner()`, cancelling `warmCtx`, calling `HTTPRunner.Close()` (cancelling `bgCtx` and draining `bgWG`), and waiting on `warmWG` before returning so no background goroutine or warm-up request outlives daemon shutdown.

## Before vs After Measurements

### Live `api.github.com` 65s idle gap (`POST /graphql` `viewer { login }`)

Measured live on this machine (`gh.HTTPRunner` + `gh.GhToken` against `https://api.github.com`; n=1 paired sample demonstrating HTTP/2 reuse that saves the ~95 ms TCP+TLS handshake observed in the probe table above):

| Path | `reused_conn` | `POST /graphql` latency (n=1) | Notes |
|---|---|---|---|
| Before (65s idle, cold reconnect) | `false` | **385 ms** | Paid cold DNS+TCP+TLS handshake (~95 ms) |
| After (65s idle, `WarmConnection` during 500ms `pollDebounce`) | **`true`** | **286 ms** (−99 ms) | `HEAD /rate_limit` overlapped with `pollDebounce`; 0 RL points (`4965 → 4965`) |

### Cached token refresh across 12m–15m

| Measurement | Before (sync at 15m) | After (soft TTL 12m → at 12m30s) | After (at 15m30s) |
|---|---|---|---|
| Live `gh auth token` (`resolveToken`) | **60.0 ms** (61–76 ms cold) | **19 µs** | **0 µs** |
| Simulated 130 ms keychain stall (`TestHTTPRunnerSoftTTLRefresh`) | **134 ms** | **1 ms** | **3 ms** |

## Gotchas

- `resolveToken` must never hold `r.mu` across `Tokens.Token(ctx)`: holding it would both block concurrent hot-path requests and deadlock `Close()` when cancelling an in-flight `WarmConnection` blocked on `Tokens.Token`.
- `HTTPRunner.recordConnUse` + `r.lastConnAt.After(r.lastWake)` lets `WarmConnection` notice `CloseIdleConnections()` from `sleepwake.go` without modifying `sleepwake.go`.
- Tests with mock `Now` clocks that cross `TokenSoftTTL` must synchronize clock reads/writes because background token refresh calls `r.opts.Now()` off the request goroutine.
