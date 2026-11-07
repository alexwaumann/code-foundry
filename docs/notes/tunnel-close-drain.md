# Tunnel close: the last count

Under a terminal flood about 5% of daemon-side ends reached the page as a dead socket, close 1006,
though the tunnel logged `served`. All the dead sockets had sent a count just before the end. The
guess was a TCP reset: the daemon stops reading, closes with that count unread, and the reset
discards what the client has not read. The fix was to be a drain after the close frame.

Neither held. The daemon already reads through the close, no reset is involved, and a drain changes
nothing. The cause is in WebKit: a `send` that crosses the server's close frame can fail the socket.
So the daemon now holds the close frame until no count is due.

## The cause

`hangUp` never stopped reading. `readUntilGone` runs until the socket closes, and `Conn.Close` reads
and discards until the client's close frame or `FinalTimeout`. What was asked for already existed.

A temporary build traced each close on a flood, and instead of closing it half-closed, read on for
1.5 s, and reset only if bytes came. 392 sockets, joined to the page's in order (each clean socket's
byte count matched exactly):

| Measured | Result |
| --- | --- |
| Dead sockets | 23, the same rate as a plain build, with no reset sent |
| Bytes unread at close | 0 in all 392 |
| Bytes arriving after the close | 0 in all 392; every one ended in a clean EOF |
| `hangUp`'s timer fired | 0 |
| Dead sockets whose last count reached the daemon | 0 of 23 |
| Clean sockets whose last count reached the daemon | 38 of 116 |
| Time from the page's `send` to the 1006 | 0-1 ms |
| Lost with the socket | 3.7-239 KB of body, and the end of stream |

So the count never left WebKit. The page sent it, and the socket failed about a millisecond later
with the tail undelivered. WebKit's network side takes frames and answers the close frame ahead of
the page, so the page can still be working through the tail when the close has been dealt with. A
count sent then does not always do harm (78 clean sockets sent one that never arrived), and did in 23.

The same thing happens with no tunnel. A bare `coder/websocket` server wrote 300 messages of 8 KiB
and its close frame, with a reader running throughout, and a page sent one text message on the way:

| Server | Page sends | Dead |
| --- | --- | --- |
| Close at once | Yes, 10-80 messages before the last | 72 of 200 |
| Close at once | No | 0 of 50 |
| Close, then half-close and read to EOF (the drain) | Yes | 75 of 200 |
| Close, then half-close and read to EOF (the drain) | No | 0 of 50 |
| Hold the close frame until the send arrives | Yes | 0 of 200 |
| Hold the close frame until the send arrives | No | 0 of 27 |

A send from 1 to 5 messages before the last failed 5-8% of the time, from 10 to 40 about half, and
at 160 a tenth, 40 tries each under a flood. A page stalled for 300 ms, whose send comes long after
the close, was clean 10 times of 10. Up to 151 messages went with the socket.

On a plain socket macOS keeps what has arrived through a reset: a Go client read all 100,000 bytes
and only then got `connection reset`. No packet capture: `/dev/bpf*` is root's on this Mac.

What goes on inside WebKit was not read, only measured from outside. This is the headless WebKit of
the e2e suite, not the app's WKWebView.

## The fix

`window.awaitCounts`, between the handler's end and `hangUp`: wait until fewer than `countStep` bytes
are uncounted. The client counts on passing a step past its last count, so past that point no count
can come and nothing can cross the close frame. It needs no change on the wire or in the GUI, so a
page already open is covered by a daemon restart alone.

- `countStep` mirrors `ACK_BYTES` in `api/wsFetch.ts`, as `HeartbeatInterval` mirrors `HEARTBEAT_MS`.
  Drift fails softly: smaller here, a close waits out `FinalTimeout` for nothing; larger, closes can
  cross counts again.
- A stream under one step has nothing to wait for. Most flood sockets are in that case, and every
  stream that stays small: Clone, dictation, search.
- It is bounded by `FinalTimeout`, and ends early if the client closes, drops or sends anything that
  is no count. `hangUp` then has its own `FinalTimeout`, so a client that neither counts nor answers
  holds a tunnel 2 s, within the 5 s shutdown. No goroutine is added: the wait is on `serve`'s own.
- It is skipped after a failed write: that client gets a 1013 and is not coming back.
- `closeReason` runs before the wait, so a client's close during it leaves a stream that finished
  as `served`. Nothing else about the reasons changed.

The drain was left out: it did not change the bare server's numbers, and no bytes arrive after a
close for it to read.

## What a lost end costs

- `Attach`: a "Reconnecting…" flash of 300-420 ms, and nothing else.
- `WatchThread`, and the other long-lived streams: `runStream` retries and the snapshot follows. They
  end from the daemon only when it stops, so a lost end there is a page that was reconnecting anyway.
- Clone has its answer in its last message and is not retried. A lost end there would read as "the
  daemon is not reachable" after a clone that worked. By this route it needs 2 MiB of progress lines
  first, since a page counts only past that, and a clone's progress is line by line. Not measured.
- A thread snapshot passes a step at once, but the stream stays open after it, so no end follows.

## Tests

`close_test.go`. `readAsPage` is a Go client made to behave as WebKit was measured to: it answers the
close frame ahead of the page, and a count sent after that loses the rest. It models the failure and
does not prove it; the tables above do that. `TestCloseFrameWaitsForTheLastCount` fails without the
fix, in three of its five cases.

## Results

`seq 1 100000000` in a loop, started through `terminal.new --argv` and shown with `ui.focus.terminal`
so that nothing was typed, in headless WebKit on `daemon --dev`, a stub `claude` on the PATH:

| Build | Time | Drops | Tunnels `served` | Dead sockets | Flashes |
| --- | --- | --- | --- | --- | --- |
| Main | 261 s | 327 | 327 | 20 (6.1%) | 20 |
| This change | 251 s | 324 | 324 | 0 | 0 |

The rate of drops did not change, 1.25/s and 1.29/s, so waiting for the count costs a flood nothing.

Reasons on this change and on main, the same in both, with two seeded stopped threads so that none
started:

| Action | Tunnels | Logged | Page |
| --- | --- | --- | --- |
| Thread switch | `WatchThread` | `client closed` | 1005 |
| Page reload | `WatchThread`, `EventService.Watch` | `client closed` | |
| Daemon stop, flood running, three times | `Attach`, `EventService.Watch` | `served`, before `closing stores` | 1000, every tunnel the daemon opened |

The page also logged 1006 twice per stream after each stop. Those are reconnects to a daemon that
had gone: the daemon's opens and closes match its 1000s. `client gone` and `write timeout` were not
produced on the real daemon; the Go tests cover them.

`-race` at 1 and 4 CPUs: the lost-end tests 200 times, the package 5 times.

## Not verified

- The app's WKWebView. The flash was first counted there, but all of this ran in Playwright's WebKit.
- Why WebKit fails the socket. Only that it does, when, and what stops it.
- A page more than `FinalTimeout` behind: the close frame then goes without its count, as every close
  did before, and such an end can still be lost. It would flash once.
