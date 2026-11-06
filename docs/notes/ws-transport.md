# WebSocket transport: the GUI side

`docs/notes/ws-tunnel.md` is the daemon side. PR 2 of six added the client and moved
`EmberService.WatchBoard`. PR 3 moved the heavy streams: `ThreadService.WatchThread`,
`TerminalService.Attach` and `PluginService.WatchSurface`. Every other stream and every unary call
stays on fetch, terminal input included, and the stream slots and the plugin cap stay until PR 5,
so each of these still claims a slot.

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
| Reader past `MAX_QUEUED_BYTES` | not reached | body errors, `TypeError` |
| Abort | promise rejects, `signal.reason` | body errors, `signal.reason` |
| Bad head, body before head, second head | promise rejects, `TypeError` | body errors, `TypeError` |

A `TypeError` is what `isUnreachable` reads, directly or as the cause of connect-web's `Unknown`.
A 1000 with no end of stream is connect-web's "missing EndStreamResponse", as a truncated fetch is.
So the daemon closes with 1013 after a failed write, which arrives as a plain dead socket.

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

- A browser empties the socket whether or not the page runs, so TCP tells the daemon nothing. The
  client's counts replace it (below).
- A failed upgrade is only a dead socket. A refused Origin or a missing route looks like a daemon
  that is down, and the stream retries forever. There is no fallback to fetch.
- A stream has no CORS preflight, so a tunnelled stream never shows an `OPTIONS` line.

## A reader that falls behind

Measured in the built app on a scratch home: 60 s of `yes` in a terminal, sampled with `top` for
memory and temporary page telemetry for the rest. "Blocked" is an OSC that spins the main thread
for 60 s. The temporary build is not in this PR.

| Run | WebContent peak | Networking peak | Queued in `wsFetch` | Result |
| --- | --- | --- | --- | --- |
| fetch, reader live | 607 MB | 8 MB | n/a | Wedged after about 12 s, for good |
| socket, reader live, no fix | 566 MB | 8 MB | 0 | The same wedge |
| fetch, blocked (two runs) | 1.6 GB and rising | 3.0-4.1 GB | n/a | Survived; no page tick in the 146 s after the block |
| socket, blocked, no fix | 4.4 GB | 8 MB | not visible | WebContent crashed as the block ended (`reason=Crash`); the page reloaded |
| socket, reader live, fixed | 600 MB | 8 MB | 0 | 39 resyncs, 0 errors, backlog at most 8.4 MB, correct screen |
| socket, blocked, fixed | 432 MB | 8 MB | 0 | `write timeout` at 32 s, one slow subscriber dropped, correct screen |

What this showed:

- **A cap in `wsFetch` cannot do the job alone.** A live reader takes each message in the task it
  arrives in, so the queue measured 0 at any rate. A blocked main thread runs no JS, so nothing can
  check a cap while memory grows at about 73 MB/s. The cap is in (`MAX_QUEUED_BYTES`, 64 MiB, above
  the largest snapshot seen, 49 MB), for a reader that stalls with the main thread running. Nothing
  does that today. It checks before it enqueues, so one message larger than the cap is delivered.
- **So the tunnel has flow control** (`docs/notes/ws-tunnel.md`): a running count every 2 MiB and
  an 8 MiB window. A stopped page now holds 8 MiB per stream, the write deadline fires for the first
  time, and the terminal store's slow-subscriber drop works as designed.
- **Fetch has no backpressure in WebKit either.** The bytes wait in the Networking process, not the
  page. That is why fetch survives a long block and the socket did not, and why fetch was no model
  to preserve: the page then takes minutes to work through them.
- **The wedge was a bug in `AttachController`, on any transport.** A live reader outruns xterm:
  26 MB/s arrive and xterm parses about 9 MB/s, so its buffer reaches its 50 MB limit and `write`
  throws. A throw from a `parsed` callback, from replaying held output, ends xterm's parse loop for
  good. Every later snapshot's write then threw, a reconnect loop at 4/s that outlived `yes`.
- **`term.reset()` leaves xterm's write buffer alone.** So a snapshot written over a backlog met a
  screen that was not fresh, which `internal/store/terminal/snapshot.go` requires. A tab switch had
  the same hole.

`AttachController` now counts what xterm has not parsed. Past `MAX_BEHIND_BYTES` (8 MiB, about a
second of parsing) it drops the stream, lets xterm finish, and opens a new one, so a flood costs
about one reconnect every 1.5 s with nothing open between them, and Ctrl-C shows within a second.
Nothing is lost: the snapshot has the screen and scrollback. Input keeps working through this, so the
phase stays `live`. A snapshot always waits for xterm to finish before `reset()`.

## Terminals on the socket

- Input stays unary. Echo over the real daemon in WebKit, 300 keys: p50 4 ms, p95 8 ms on the tunnel;
  p50 4 ms, p95 8-9 ms with Attach on fetch.
- Pastes of 64, 512 and 1000 KiB arrived whole. 2 MiB is refused with 429, by the terminal store's
  input backlog limit (`ErrInputBacklog`). That is daemon behaviour that this PR does not touch.
- An exited terminal's stream logs `served` and does not reconnect. A 10.9 MB snapshot crossed as
  one message in WKWebView, so nothing in the path applies a 1 MiB limit.
- A socket delivers a thread's snapshot on a different beat from fetch, which exposed a stale read in
  the timeline's `onScroll`: two scrolls before a render left `atBottom` false at the bottom, and the
  Jump to bottom chip stayed up. It failed 11 of 30 runs of one e2e test on the tunnel, and 0 of 18
  on fetch. The list was at the bottom in every failure.
- At five streams, a new Attach takes the slot of an inline holder for a moment, so a board with no
  core view reconnects on each tab switch. That ends with the slots in PR 5.

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

`reason` says who ended it:

| `reason` | Meaning |
| --- | --- |
| `served` | The handler returned first: a terminal that exited, a daemon shutting down. |
| `client closed` | The client sent a close, or data that is not a count: a tab switch, a resync, the watchdog, a quit, `AttachController` dropping a stream. The end of stream then fails to write; that failure is not news. |
| `client gone` | The connection died with no close frame, or a write failed. A crashed page, or a close that a full-speed write reached first (1 in 39 under `yes`). |
| `write timeout` | The client took nothing for 30 s: a window that never reopened, or a write that never finished. |
| `no request` | The opening frames never came. A view that left at once logs this too. |

A killed daemon logs no `tunnel closed` at all.

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

`resyncOnVisible` streams (Ember's board, the visible thread, dictation) reconnect in 15-20 ms each
time the window goes from hidden to visible, by design, so covering and uncovering the window adds
`client closed` and `tunnel open` lines. Keep them out of the idle count. `EventService.Watch` has no
such setting.

To back out: empty `TUNNELLED_STREAMS`. WatchBoard is back on fetch; the tunnel stays unused.

## Managed Mac milestone 2

A day of normal use on a tip with this PR: several threads, a shell in the bottom panel, and a plugin
tab if there is one. Keep `advanced.log_level = debug` and Ember on. Every `tunnel` line now names one
of four procedures. These commands read the current log; at debug, check `daemon.log.1` too.

```sh
L=~/.code-foundry/logs/daemon.log
grep '"tunnel closed"' "$L" | jq -r '[.procedure, .reason] | @tsv' | sort | uniq -c | sort -rn
grep '"tunnel refused"' "$L"
grep -E '"reason":"(write timeout|client gone)"' "$L" | jq -c '[.time, .procedure, .reason, .dur]'
grep -c 'dropped slow attach subscriber' "$L"
```

What to expect:

1. `tunnel refused`: none, as in milestone 1.
2. Almost every close is `client closed`, and `served` for exits and restarts. Tab switches and
   showing the window each add a few.
3. `write timeout` should be rare and should line up with something: a very busy page, or a build
   flooding a terminal while the page was stalled. Note what the Mac was doing. On an idle tunnel it
   means a daemon that stopped hearing counts, which is the result to report.
4. `client gone` should be rare outside a crash or a force quit.
5. Live views: threads stream and terminals type with no `Reconnecting…` that lasts. A long `yes`
   shows jumps rather than every line, and `tunnel open` about every 1.5 s while it runs. That is
   the flood path working.
6. WebContent's memory in Activity Monitor stays in the hundreds of MB through a noisy build.

To back out one stream, remove its entry from `TUNNELLED_STREAMS` in `api/endpoint.ts`: each is
independent, and the stream goes back to fetch with no daemon change. `TerminalService/Attach` is the
first to try. The `AttachController` limit applies on either transport, so it stays.

## Verified

- `wsFetch.test.ts` and `endpoint.test.ts`: head to Response, frames, already-aborted signal, abort
  before and mid-stream, 1000 against other codes, cancel, the count, connect-web's error mapping
  and routing.
- Built app on a scratch home, debug logs: `tunnel open` with `wails://localhost` and the procedure,
  and no `tunnel refused`. The socket held for 1m43s with no reconnect. By `nettop`, one
  connection's bytes out stayed flat while a board change brought it 267 bytes in. SIGTERM and
  SIGKILL of the daemon: the host started a new one on a new port and token, and `tunnel open`
  followed within 0.1 s of `daemon started`. SIGTERM took 0.5 s end to end, with `tunnel closed`
  before `listeners closed, closing stores`; SIGKILL's start was not timed.
  `WatchBoard` was the only `tunnel open`; `EventService/Watch` and `ThreadService/WatchThread`
  showed their `OPTIONS` preflights.
- `daemon --dev` in WebKit: a CLI `ember.task.add` reached `useEmberStore`, with
  `openSocketCount()` at 1 under StrictMode. The window capture of the built app came back blank
  on this machine, so board contents were read here, not on screen.
- `e2e/ember.spec.ts` over the mock tunnel, with `openStreams()` still 1.

Not verified in PR 2: a real lid sleep or an overnight idle. Milestone 1 then passed on a managed
Mac.

For PR 3, on a built app with a scratch home unless noted, with the same temporary telemetry:

- One app with a thread streaming, a shell, a plugin surface and the board: all four on the tunnel
  from `wails://localhost`, plus Events on fetch. That is five, the slot limit, so more than four
  tunnelled views at once needs PR 5.
- Six tab switches between two shells: one Attach live at the end, every close `client closed`.
- Hiding and showing the window: the thread and the board logged `client closed` and reopened in
  11-14 ms. The shell's Attach stayed.
- SIGTERM: all four `served`, a new daemon in 0.1 s, and streams back within 0.1 s of `daemon started`.
  SIGKILL: the same recovery, with no `tunnel closed`. Terminals die with the daemon on either.
- `yes` with a 35 s block, past the write deadline: phase back to `live`, `CF-END-OF-YES` and the
  prompt on screen.
- Resize against `daemon --dev` in WebKit: 138 to 98 columns reached the PTY and xterm.
- `make gui-e2e`: `thread-reconnect`, `subagent-view` and `threads` now watch sockets, since no
  `request` event shows one and a count of them would have passed at 0. Stream counts through
  `/__mock/streams` held with no other change.

Not verified: inline preemption on a real plugin node (e2e covers it over the mock tunnel), and a day
of use. That is milestone 2.
