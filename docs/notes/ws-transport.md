# WebSocket transport: the GUI side

PR 2 of six; `docs/notes/ws-tunnel.md` is the daemon side. It adds the client and moves exactly
one stream onto the tunnel: `EmberService.WatchBoard`. Every other stream and every unary call
stays on fetch, and the stream slots stay, so WatchBoard still claims one.

## Shape

- `api/wsFetch.ts` is a `fetch` over one socket. `createConnectTransport({ fetch: wsFetch })`
  keeps connect-web's framing, end-of-stream parsing and error mapping, and the bytes are the
  same for binary and `?json=1`. The token reaches the head through the existing auth interceptor.
- `api/endpoint.ts` builds a composite transport: `unary` on fetch, `stream` by procedure.
  `TUNNELLED_STREAMS` is temporary. Later PRs extend it; the last one removes it.
- `mock/tunnel.ts` takes the two opening messages and replays them as a real request to the
  mock's own port, so all routes, the bearer check and `/__mock/streams` work unchanged. It checks
  no Origin and no procedure: those are daemon rules, tested in Go.

## How it fails

`runStream` does not know the transport, so `wsFetch` fails the way fetch does:

| Event | Before the head | After the head |
| --- | --- | --- |
| Close other than 1000, or a failed upgrade | promise rejects, `TypeError` | body errors, `TypeError` |
| Close 1000 | promise rejects, `TypeError` | body ends |
| Abort | promise rejects, `signal.reason` | body errors, `signal.reason` |
| Bad head, body before head, second head | promise rejects, `TypeError` | body errors, `TypeError` |

A `TypeError` is what `isUnreachable` reads, directly or as the cause of connect-web's `Unknown`.
A 1000 with no end of stream is connect-web's "missing EndStreamResponse", as a truncated fetch is.

## Gotchas

- `signal.aborted` comes first: `abort` never fires on a signal that has already aborted. The
  spike leaked one live socket per stream under StrictMode without it.
- After a cancel or an abort a `close` event still arrives, and `controller.close()` on a finished
  stream throws. `finished` guards every later event.
- `new WebSocket` throws a `SyntaxError`, and `new Response` throws on a head with status 204 or
  99. Both become `TypeError`.
- The count falls on the `close` event, not on `close()`, so a socket in its closing handshake
  still counts. It warns on passing 150, once per crossing, and caps nothing.
- Upgraded sockets leave Node's connection list, so `closeAllConnections` misses them and
  `server.close` would wait for them forever: the mock's shutdown drops them first.
- `gui-build` rewrites `gui/build/darwin/icons.icns` and adds `Assets.car`. Keep both out of a PR.

## Differences from fetch

- A socket has no backpressure: messages queue in the body until read. A board is small, but
  check this before moving a stream with big snapshots.
- A failed upgrade is only a dead socket. A refused Origin or a missing route looks like a daemon
  that is down, and the stream retries forever. There is no fallback to fetch.
- A stream has no CORS preflight, so a `WatchBoard` never shows an `OPTIONS` line.

## Managed Mac milestone

Run a tip with Ember on: `ember.enabled` must be true, since a stream exists only while a view
holds it, and the sidebar row is the view that holds it on an idle app. Set
`advanced.log_level = debug` to get the fetch baseline below. Read
`~/.code-foundry/logs/daemon.log`, JSON lines, rotated to `daemon.log.1` at 10 MiB: at debug, check
both files, and note the start time of each step.

```sh
L=~/.code-foundry/logs/daemon.log
grep -E '"tunnel (open|closed|refused)"' "$L" | jq -c '[.time, .msg, .reason, .dur, .origin]'
grep -c '"tunnel open"' "$L"
grep '"path":"/codefoundry.v1.EventService/Watch"' "$L" | grep '"method":"POST"' | jq -c '[.time, .status, .dur]'
```

| Line | Meaning |
| --- | --- |
| `tunnel open` | A socket passed Origin. Wants `origin` `wails://localhost` and `procedure` `/codefoundry.v1.EmberService/WatchBoard`. |
| `tunnel closed` | With `reason` and `dur`, the socket's lifetime. |
| `tunnel refused` | Origin failed. Should never appear on this Mac. |
| `request`, path `/stream/...`, status 101 | Debug only: the upgrade, logged at its end. |
| `request`, path `.../EventService/Watch` | Debug only: the fetch stream beside it, the baseline. |

`reason` needs care. `served` means the handler returned, and that covers the client leaving: a
quit, a resync and the watchdog all log `served`, as a daemon shutdown does. `client gone` and
`write timeout` mean a write failed. `no request` means the opening frames never came. A killed
daemon logs no `tunnel closed` at all.

Checks:

1. Start: one `tunnel open` with the origin above, and no `tunnel refused`. No `tunnel open` at all
   while Ember's row shows an error means the upgrade never reached the daemon: something on the
   Mac is stopping `ws://127.0.0.1`. That is the result this milestone exists to catch.
2. Overnight idle, window open: compare the `tunnel open` count with the `EventService/Watch` POST
   count over the same hours. They should be close. Long `dur` values are the goal. The stream
   sends a heartbeat when idle, and the client treats 15 s of silence as dead, so a rate far above
   the fetch stream's means the socket is being dropped.
3. Lid sleep: on wake expect at most a few reconnects, within seconds, not one every few seconds
   for minutes. Then run `code-foundry ember.task.add --title check` and see the task on the board
   with no reload, which proves the new socket carries data.
4. Backoff: any two `tunnel open` lines under about a second apart, repeating, is a loop. A single
   pair can be a resync.
5. `write timeout` or `client gone` on an idle tunnel: note the time and what the Mac was doing.

WatchBoard reconnects by design when the window goes from hidden to visible (`resyncOnVisible`), so
covering and uncovering the window adds `tunnel open` lines. Keep it out of the idle count.

To back out: empty `TUNNELLED_STREAMS`. WatchBoard is back on fetch; the tunnel stays unused.

## Verified

- `wsFetch.test.ts` and `endpoint.test.ts`: head to Response, frames, already-aborted signal, abort
  before and mid-stream, 1000 against other codes, cancel, the count, connect-web's error mapping
  and routing.
- Built app on a scratch home, debug logs: `tunnel open` with `wails://localhost` and the procedure,
  and no `tunnel refused`. The socket held for 1m43s with no reconnect. By `nettop`, one
  connection's bytes out stayed flat while a board change brought it 267 bytes in. SIGTERM and
  SIGKILL of the daemon: the host started a new one on a new port and token, and the board was
  back in under a second (SIGTERM: `tunnel closed` before `listeners closed, closing stores`).
  `WatchBoard` was the only `tunnel open`; `EventService/Watch` and `ThreadService/WatchThread`
  showed their `OPTIONS` preflights.
- `daemon --dev` in WebKit: a CLI `ember.task.add` reached `useEmberStore`, with
  `openSocketCount()` at 1 under StrictMode. The window capture of the built app came back blank
  on this machine, so board contents were read here, not on screen.
- `e2e/ember.spec.ts` over the mock tunnel, with `openStreams()` still 1.

Not verified: a real lid sleep or an overnight idle. That is the milestone.
