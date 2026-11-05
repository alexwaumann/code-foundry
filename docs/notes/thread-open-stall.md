# Thread open stall

A thread sometimes took about 5 s to open. The time was not the database or the daemon: a
49 MB thread loads in about 265 ms the first time and is on the wire in 25 ms after that.

WKWebView holds back the end of a large `WatchThread` snapshot until later bytes arrive on the
stream. The next bytes were the heartbeat, so the open waited out `HeartbeatInterval`. It is the
hold from `thread-render-stall.md`, but it needs no hidden window: it happens visible and
focused, on a message's end rather than a quiet stream's.

## Fix

`heartbeat.Flush` after each snapshot (the first and a resync's): the next two silences are 10 ms
and 90 ms instead of 5 s, so a held end is released at once. Any message releases it, so a
running thread's next event can stand in for a flush.

## Measured

Real Wails window (`wails://localhost`), scratch home, threads built from real transcripts,
reading the Watch's first message with a raw `fetch` from inside the page.

| After the snapshot | Held 5 s |
| --- | --- |
| nothing (before) | 30 of 128 at 0.8 MB to 32 MB; 0 of 24 at 50 KB |
| heartbeat at once | 29 of 96 |
| heartbeat at +3 ms | 2 of 112 |
| heartbeat at +10 ms | 0 of 112 |
| heartbeat at +30 ms | 0 of 112 |

With the shipped flushes (+10 ms, +100 ms): 0 of 264 held, 0.9 MB to 32 MB, worst 178 ms for the
bytes to arrive. Opening a thread, selection to rows painted, 7 opens each, no log kept:

| Snapshot | Median | Worst |
| --- | --- | --- |
| 0.9 MB | 86 ms | 93 ms |
| 4 MB | 112 ms | 128 ms |
| 8 MB | 141 ms | 153 ms |
| 16 MB | 220 ms | 262 ms |
| 18 MB | 214 ms | 343 ms |
| 32 MB | 330 ms | 414 ms |
| 49 MB (concatenated, 7,024 items) | 461 ms | 823 ms |

## Gotchas

- **Only the real window shows it.** Headless Playwright WebKit never held a snapshot, so the
  e2e suite and `make drive` cannot see this or a regression of it. Go tests pin that the flushes
  are sent; only a live window proves they work.
- A heartbeat sent at once is useless: it arrives with the end it should release. The gap is the
  fix, so do not fold the two into one write.
- Where inside WebKit the bytes wait is still unknown, as in `thread-render-stall.md`. The fix
  does not depend on it, but 10 ms is a measured margin, not a guarantee: hence the second flush.
- Only `WatchThread` is covered. `TerminalService.Attach` and `EventService.Watch` also open with
  a snapshot and were not measured.

## Decisions

- No cache, prefetch or smaller snapshot in this change: the plain path comes first, measured on
  its own. About 90% of a large snapshot's bytes are `Read` results that only an expanded row
  shows, if it ever needs slimming.
- Not a unary snapshot, which never held: more change, and slower on large threads (32 MB took
  about 500 ms against 40 ms for the stream's bytes).
