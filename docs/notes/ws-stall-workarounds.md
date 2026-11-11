# Removing the held-bytes workarounds

PR 6 of six in the WebSocket series (`docs/notes/ws-transport.md`). Fetch in WKWebView held back
the tail of a stream's bytes until more bytes arrived on it: after the window was hidden
(`docs/notes/thread-render-stall.md`), and at the end of a large snapshot even while it was visible
(`docs/notes/thread-open-stall.md`). Every GUI stream now runs over the tunnel. The owner and some
users ran it for two days with no hold, and the runs below found none. So what existed only to
release held bytes is gone.

## Inventory

| Piece | Where | Verdict |
| --- | --- | --- |
| Post-snapshot flushes: `heartbeat.Flush`, `snapshotFlushes` (10 ms, 90 ms), the `soon` queue | `internal/api/heartbeat.go`, three calls in `internal/api/thread.go` | Removed. A WatchThread snapshot is now followed by silence until the interval. |
| `resyncOnVisible`, with the `resync`/`wake`/`takeResync` plumbing and every `unwatchVisibility` | `api/stream.ts` | Removed. `runStream` no longer listens to visibility at all. |
| `resyncOnVisible: true` | `stores/thread.ts`, `stores/ember.ts`, `stores/dictation.ts` | Removed from all three (below). |
| `TestHeartbeatFlush`, `TestThreadWatchFlushesSnapshot` | `internal/api/heartbeat_test.go` | Removed; `TestThreadWatchQuietAfterSnapshot` pins the silence instead. |
| `thread_stall_test.go` (`TestThreadWatchIdleHeartbeat`) | `internal/api` | Removed: a diagnostic from the stall branch. With no flushes it said what `TestStreamHeartbeats`' idle case says. |
| Flush loops in `TestWatchThreadSnapshotAfterItemsReset`, and "the heartbeats that flush the snapshot" comments in four thread tests | `internal/api/*_test.go` | Removed or reworded. Those tests still skip heartbeats. |
| `resyncOnVisible` tests (five cases, plus "an event a resynced attempt yields") | `api/streamLiveness.test.ts` | Removed. Two cases now assert the opposite: hiding and showing neither aborts nor reopens an attempt, and does not cut a backoff short. |
| `threadStallVisibility.test.ts` | `stores/` | Replaced by `watchVisibility.test.ts`: the thread's Watch, Ember's board and dictation's Watch each open once across a 30 s hide. |
| `thread-reconnect.spec.ts` "showing the window again reopens the Watch" | `e2e/` | Now a thread switch, which still reopens it with no chip. The chip test dropped its socket through the hide/show resync, and now closes the routed socket itself. |
| `StreamHeartbeat` doc comment | `proto/codefoundry/v1/heartbeat.proto` | Reworded to liveness only; `make gen` changed comments and nothing on the wire. |
| ARCHITECTURE.md "Stream liveness", ws-transport.md milestone text | `docs/` | Updated. The two stall notes carry a "superseded" line at the top. |

### Kept, and why

- **The 5 s heartbeats** (`HeartbeatInterval`, `StreamHeartbeat`, every stream). A stopped daemon
  keeps the socket open and sends nothing, and the heartbeat is the only thing that tells a live
  stream from that one. Checked: SIGSTOP on the scratch daemon with a thread open, the watchdog
  aborted the Watch 10.5 s later (within `LIVENESS_MS` of its last heartbeat), retries followed, and after
  SIGCONT the snapshot came 0.6 s later.
- **The liveness watchdog** (`LIVENESS_MS`, `StreamSilentError`). It is what acts on that silence.
- **Events' `silent` flag** (`stores/events.ts`, `SILENT_MS`). It covers a socket that never brings a
  message while unary pings answer, which no heartbeat can show because none arrives.
- **The "catching up…" chip.** It shows a retrying Watch over a loaded log, whatever the cause.
- **`onVisibilityChange` and `onBecameVisible`.** `stores/fileStamps.ts` and `files/useTabRead.ts` use
  them to re-read files on return. That is about files changing on disk, not streams.
- **`e2e/live-stall.spec.ts` and `stores/threadStall.test.ts`.** Both came from the stall
  diagnosis, but neither works around anything: the first compares daemon, store and DOM during a
  live turn (ws-transport.md PR 3 used it), and the second is the Watch batching model test.
- **The heartbeat oneof cases**, unchanged on the wire.

None of the kept pieces can go: each is the only check for its own failure.

### Ember and dictation

`git log -S resyncOnVisible` puts both on the commits that added the stores (0429e6033 for Ember's
board, d77167fcd for dictation). Neither commit nor its note gives a reason. Both streams send a
whole snapshot in every message, so a resync on show could only bring news that was being held
back. After a lid sleep the socket is either alive, so heartbeats feed the watchdog, or dead, so the
watchdog or the health store's `wakeAllStreams` reconnects it. Neither needs the page's visibility.
Both are removed.

## Measured

Built app (`make gui-build`) in the real Wails window, scratch `CODE_FOUNDRY_HOME` under /tmp, scratch
repo, debug logs. A temporary probe in `stores/thread.ts` (not committed) posted each Watch
message, the store's seq after each batch, visibility changes and a two-frame paint mark to a
listener on loopback.

Opening a thread, 30 opens each, alternating between the two (`thread.focus`). "Arrived" is from the
attempt's start to the snapshot leaving the stream's iterator; a held end would show as about 5 s,
since no flush follows it any more.

| Thread | Snapshot arrived, median | Worst | Held (≥ 1 s) | Painted, median | Worst |
| --- | --- | --- | --- | --- | --- |
| 18,003 items, 24.9 MB of item data | 187 ms | 246 ms | 0 of 30 | 263 ms | 330 ms |
| 3 items | 20 ms | 39 ms | 0 of 30 | 62 ms | 84 ms |

The hide recipe from `thread-render-stall.md`: Sonnet 5.5 at medium, "Without tools, write a
1500-word story in numbered sections about …", hidden 6 s after the send, shown after 30 s, read 10 s
later. The app was hidden and shown through `NSRunningApplication` for its own pid, and nothing else
on screen was touched. Each turn ran about 25 s and ended while the window was hidden.

| Run | Events while hidden | Turn end to the page | Store seq at show / daemon | 10 s later | WatchThread opens after show (page / daemon log) |
| --- | --- | --- | --- | --- | --- |
| h1 | 747 | 153 ms | 899 / 899 | 899 / 899 | 0 / 0 |
| h2 | 766 | 126 ms | 1824 / 1824 | 1824 / 1824 | 0 / 0 |
| h3 | 658 | 205 ms | 2630 / 2630 | 2630 / 2630 | 0 / 0 |
| h4 | 726 | 179 ms | 3482 / 3482 | 3482 / 3482 | 0 / 0 |
| h5 | 721 | 192 ms | 4339 / 4339 | 4339 / 4339 | 0 / 0 |

So nothing waited for a heartbeat: each turn's tail reached the store while the window was still
hidden, in about 0.2 s. "Turn end to the page" runs from the turn end's `updatedAt` to the page
receiving the highest seq. The fetch runs in `thread-render-stall.md` held 8 of 11 tails for 5-6 s.
Over the whole session the daemon logged 65 `tunnel open` for WatchThread, all from opens and
switches, and none from a show.

## Versions

The proto is unchanged, and either side may be older during an update.

- A new GUI on an older daemon still receives the flushes and ignores them, as it ignores any
  heartbeat.
- An older GUI from the tunnel era on a new daemon still resyncs on show, which costs a snapshot
  and is harmless.
- A window from before the tunnel (before v0.21.6-tip.2) on this daemon uses fetch with no flushes,
  so a large thread can take up to one heartbeat interval to open until that window relaunches. An
  update relaunches it.

The daemon change needs a daemon restart to take effect. The GUI change does not.

## Gotchas

- In JXA, a method with no arguments is called by reading it as a property:
  `$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).hide`. With `()` it hides
  the app and then throws.
- Headless WebKit never held bytes, so e2e and `make drive` cannot show this either way. Only the
  built window can.
- `make check` failed once on `TestMisbehavingPlugins/flood` in `internal/store/plugin`, which this
  PR does not touch: `TempDir RemoveAll cleanup: directory not empty` under load. It passed three
  times alone, and on the rerun of `make check`.
