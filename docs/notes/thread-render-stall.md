# Thread render stall: diagnosis and fix

The report: in a rendered thread, messages stop rendering while Claude keeps working.
They show up once the user leaves the thread and comes back. The diagnosis comes first;
the shipped fix and its live result are in "Fix (shipped)" below.

## Verdict

**Confirmed root cause.** After the Wails window has been hidden, minimized, or covered
by another app's window while a turn streams, WKWebView sometimes holds back the last
bytes of the `ThreadService.Watch` response. The daemon has written and flushed them,
and both kernel socket queues are empty, but they do not reach JavaScript until **more
bytes arrive on the same stream**. The stream stays open and raises no error, so
`runStream` never reconnects. The Watch carries nothing while a thread is quiet, so the
held tail can wait for a long time:

* the turn ended (the last text deltas, the item's final update and the turn end are held
  until the next turn);
* or the turn went quiet mid-way (a long tool call, a subagent, a pending permission):
  the rows before the quiet part are held, while the sidebar's status (EventService)
  still says Working.

Leaving and returning stops the Watch and opens a new one, and the new snapshot carries
everything. That is the workaround users found.

Confidence: high that this is the mechanism behind the reports. It was reproduced in
the real Wails app, the daemon side and both socket queues were observed, and new bytes
were shown to release the held tail (a heartbeat prototype stopped the stall). It is
less clear where inside WebKit the bytes wait (the network process or the hand-off to
the web content process). The fix does not depend on that.

## Reproduction (real Wails window, WKWebView)

Setup: an isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-stall-home`, `daemon --dev`), the
GUI from `make gui-build` started with the same home, a scratch repo `~/cf-stall-scratch`,
and threads on `claude-haiku-5-5[1m]` at medium effort. `claude-4.5-haiku[1m]` was
rejected off the work Bedrock setup.

For one run:

1. Focus the thread in the GUI and send "Without tools, write a 1500-word story in
   numbered sections about …" with the CLI. The turn streams for about 20 s, roughly 500
   events.
2. 6 s in, hide the app (`System Events … set visible … to false`), minimize its window
   (AXMinimized), or cover it with a full-screen Finder window and activate Finder.
3. After 30 s (the turn has ended), show the app again and wait 10 s.
4. Compare the thread store with the daemon. A scratch-only build (not committed)
   rendered the Watch counters in a corner of the pane: events received by the
   `for await` loop, batches flushed, queued events, whether a flush timer was pending,
   the store's seq, and the Watch status. The daemon's seq came from `ListItems`.

Results:

| GUI state during the turn | runs | stalled |
| --- | --- | --- |
| hidden 30 s, long turn | 9 (two more turns were refusals and are excluded) | 6 |
| minimized 30 s, long turn | 2 | 1 |
| covered by another app's window 30 s, long turn | 3 | 1 |
| visible, another app frontmost, long turn | 3 | 0 |
| visible and frontmost, short turns | 3 | 0 |
| hidden 5 s or 30 s, short turns (~25 events) | 6 | 0 |
| hidden 30 s, long turn, **heartbeat prototype** | 4 (+1 unreadable screenshot) | 0 |

What a stalled run looks like (run `x1`): the store stopped at seq 555 while the daemon
was at 558. The text ended mid-word, with no footer and no Working row, and the composer
was idle because the EventService had delivered the idle status. The overlay read
`received=…, queued=0, timer pending: no, last flush 33 s ago, watch=open,
visibility=visible`. In other words:

* the 16 ms batching timer was not the problem: nothing was queued and no timer was
  pending, so events never reached `onEvent` at all;
* the stream was not dead: `watch=open`, no error, no retry;
* React was running: the overlay re-rendered on EventService changes, such as a rename
  used to poke it.

Daemon side, with a scratch per-send log (not committed), for the same run:

```
00:23:26.054 SCRATCH thread watch sent session=s-d90df148bbdc seq=555 peer=127.0.0.1:57147
00:23:26.077 … seq=556 peer=127.0.0.1:57147
00:23:26.081 … seq=557 peer=127.0.0.1:57147
00:23:26.107 … seq=558 peer=127.0.0.1:57147
00:24:01.235 … seq=559 peer=127.0.0.1:57147   (the next turn)
```

Port 57147 belonged to `com.apple.WebKit.Networking`, which held the GUI's only Watch.
connect-go flushes after every `Send` (`protocol_connect.go`, `defer
flushResponseWriter`), and `statusRecorder` passes `Flush` through
(`internal/daemon/log.go:72`). `netstat` showed Recv-Q and Send-Q at 0 on both ends while
the GUI was stalled. When the next turn's first event (seq 559) arrived, seq 556–558
arrived with it, and the earlier turn's footer and last words appeared. The same thing
happened in runs `h30` and `v2`, where a later "PING" turn released the held events.

The heartbeat prototype (scratch, not committed) made the daemon `Send` an empty
`ThreadEvent{}` every 5 s on each Watch. The current GUI maps it to null and ignores it.
With that change, 4 of 4 readable hidden-window runs caught up within the 10 s wait.

Why the earlier attempts did not reproduce it: Playwright's WebKit page is never hidden
or occluded. These runs all stayed in sync: `e2e/live-stall.spec.ts` with long tool
turns, a subagent, queued follow-ups, scrolling, switching threads every 10 s, a 150 s
idle Watch before the turn, and load on other threads. So did a Go client reading the
Watch over HTTP/1.1, including one deliberately slowed to 300 ms per event.

## Candidates, ranked

1. **Confirmed: WKWebView holds a streaming response's tail after the page was hidden,
   minimized or occluded, and the Watch has no heartbeat or liveness check.** This is
   evidence above. Code involved:
   * `internal/api/thread.go:50-93`: the Watch loop only sends when a thread event or a
     resync comes in. An idle thread sends nothing.
   * `gui/frontend/src/api/stream.ts:108-112`: a stream that stays open is trusted
     forever. Nothing detects silence.
   * `gui/frontend/src/stores/thread.ts:257-287`: no resync on `visibilitychange`.
   * `gui/frontend/src/components/thread/ThreadPane.tsx`: a retrying Watch shows nothing
     once a log is loaded (`watchError` only shows while `!loaded`). A real
     reconnect loop would be just as silent. This is a secondary gap.

   Probably not affected in practice: EventService probably has periodic traffic of its
   own (the gh source's `Polled` after every poll, activity updates), which would release
   a held tail within a minute. That would explain why the sidebar and composer were
   current while the thread was not. The same reasoning says `TerminalService.Attach`
   could hold a shell's last output after a hide.

2. **Ruled out: the frontend store loses or skips events.** `applyThreadEvent` and
   `applyThreadEvents` (`stores/thread.ts:138-224`) were reviewed: the delta fast path,
   copy-on-write of `own`, snapshot replace, seq dedupe.
   `stores/threadStall.test.ts` is a model test over 200 seeds: a Go-like thread log
   emits appends, deltas, finishes and re-appends; the store gets them in random batches,
   with resync snapshots and reconnects mixed in. The store always ends equal to the
   daemon's snapshot. Live runs agreed (store seq equals daemon seq).
3. **Ruled out: the timeline does not render data the store has.** No virtualizer
   measurement problem, `getItemKey` collision or shallow-selector staleness was seen.
   The live diagnostic samples the mounted `data-index` rows against the rows built from
   the store, and the last text row's DOM length against the store's text. No lag over
   about 700 samples, including scrolling away and back and thread switches. Row keys
   (`lib/threadTimeline.ts`) are unique by construction, since item ids are unique. Turn
   folding is deterministic given the items, so a remount cannot change it.
4. **Ruled out: daemon ordering and snapshot gaps.** The Go client saw no seq gaps and
   no stale drops over thousands of events.
   * Seq is assigned and published under `threadLog.mu` (`items.go:432-468`,
     `mcp.go:172-183`, `slashcommands.go:86-95`), so seq order is publish order per
     thread.
   * The Watch subscribes before taking its snapshot and filters `seq <= snap.Seq`
     (`api/thread.go:52-86`).
   * Deltas are only published for known items (`items.go:432-457`).
   * `m.threads` entries are only dropped on Remove or a failed Create/Fork, so a live
     thread's seq never resets.
5. **Ruled out: slow-subscriber drops without a resync.** Drops are detected on the next
   receive, and the queue is full when a drop happens, so that receive always comes. The
   handler then resends a snapshot taken after the drop (`api/thread.go:74-84`).
   Correct, but see minor note (a).
6. **Ruled out: an idle stream timing out, or exhausting the six HTTP/1.1 connections.**
   A 150 s idle Watch in Playwright WebKit delivered the following turn. The server has
   no write or idle timeout on open requests (`daemon.go:257-268`). The WebKit network
   process held a stable 4–6 connections while switching threads, all with empty socket
   queues.
7. **Ruled out: the 16 ms flush timer throttled while hidden.** The overlay showed
   nothing queued and no timer pending during a stall. EventService applies its events
   without a timer and kept working.

Minor findings that are not the cause, recorded for later:

* (a) The Watch's resync after drops counts drops of **every** thread's events (the bus
  topic is shared, 2048 buffer). A busy fleet can make the visible thread resend its
  whole snapshot (JSON, possibly MBs) repeatedly. It converges, but it is costly. A
  per-thread filter before the bounded queue would avoid it.
* (b) A stopped Watch's late events still reach `applyWatchBatch`: neither `runStream`
  nor `onEvent` checks `stopped()`. That is harmless except for a stale snapshot from a
  watch stopped right after opening, which could briefly roll the log back.
* (c) `Fork` puts the record in `m.recs` before `forkLog` installs the copied log
  (`manager.go:490`, `fork.go:60-68`). A `thread(newID)` call in between would build an
  empty log from the DB that `forkLog` then replaces. Unreachable today, because the id
  is not published until spawn.
* (d) virtual-core 3.17 has `anchorTo: 'end'` and `followOnAppend`. They could replace
  the hand-rolled pinning in `Timeline.tsx` one day. This is unrelated to the stall.

## Proposed fix (for cause 1)

1. **Daemon heartbeat on `ThreadService.Watch`.** Add a `heartbeat` case to the
   `ThreadEvent` oneof (proto change and `make gen`). Send it once the stream has been
   quiet for about 5 s (a timer reset on each send). The new bytes release anything
   WebKit holds, within one interval. It is backward compatible:
   `toThreadEventView` maps an unknown case to null, so an older GUI ignores it.
   `TestThreadWatchIdleHeartbeat` (8 s budget) fails until this lands. Consider the same
   for `TerminalService.Attach`, and for EventService if its natural traffic can stop
   (gh disabled).
2. **Client resync when the page becomes visible.** On `visibilitychange` to
   `visible`, after the page was hidden, restart the visible thread's Watch (its snapshot
   replaces the log, which is what leaving and returning does today). This fixes the
   common case at once, without waiting for a heartbeat.
   `stores/threadStallVisibility.test.ts` fails until this lands.
3. **Client liveness watchdog.** Once a stream has delivered a heartbeat, abort and
   reconnect it after about 3 intervals without any message. Gating on the first
   heartbeat keeps an older daemon (no heartbeats) from reconnecting in a loop. Also show
   something when the Watch is `retrying` with a log loaded.

Item 1 alone fixes the reported symptom with at most about 5 s of lag. Item 2 removes
the lag on return. Item 3 covers a stream that dies for any other reason.

## Fix (shipped)

All three items, on branch `t3code/thread-stream-heartbeat`.

1. **Heartbeats.** `proto/codefoundry/v1/heartbeat.proto` adds an empty
   `StreamHeartbeat`, a oneof case on `ThreadEvent` (9), `AttachEvent` (5) and `Event`
   (13). `internal/api/heartbeat.go` holds the one interval, `HeartbeatInterval = 5s`, and
   a small silence timer: each stream selects on it next to its sources and resets it
   after every message it sends (the heartbeat included), so a busy stream never
   heartbeats and the timer stops with the handler. A heartbeat carries no seq, so the
   Watch's seq and dedupe are untouched (`TestThreadWatchHeartbeatKeepsSeq`). Streams:
   * `ThreadService.Watch`: the stall itself.
   * `TerminalService.Attach`: the same risk for a shell's last output after a hide.
   * `EventService.Watch`: its own traffic is not guaranteed (gh polling off, no thread
     busy), and it carries the sidebar status and pending prompts.
   * Not `TerminalService.Watch`: the GUI does not hold it (EventService carries
     terminal events); only tests and the CLI use it, and they do not run in WebKit.
2. **Resync on visible.** `runStream`'s `resyncOnVisible` (used by the thread Watch
   only) aborts the current attempt, or cuts its backoff sleep, and reopens at once
   (status `connecting`, no error, backoff reset) when `visibilitychange` goes to
   `visible` after `hidden`. WKWebView in Wails fires `visibilitychange` for all three
   cases measured live: app hidden, window minimized, and window covered by another app's
   window (occlusion). The terminal Attach does not resync: its snapshot resets xterm and
   rewrites up to 10,000 lines of scrollback (losing the scroll position and selection),
   and the heartbeat already releases a held tail within 5 s.
3. **Liveness watchdog.** `runStream` (all three streams) arms a timer on an attempt's
   first heartbeat and resets it on every message; after `LIVENESS_MS` (3 ×
   `HEARTBEAT_MS`, 15 s) of silence it aborts the attempt with `StreamSilentError` and
   reconnects through the normal backoff. Mixed GUI/daemon versions are not a concern
   (the update replaces both together); the arming on the first heartbeat stays because
   it keeps fakes and the mock daemon, which send no heartbeats, from reconnecting every
   15 s. `HEARTBEAT_MS` in `api/stream.ts` mirrors the Go constant (comments on both).
   Two related fixes in `runStream`: a stopped or resynced attempt's late events no
   longer reach `onEvent` (minor finding (b)), and a stream without `onConnect` reports
   `open` on its first message instead of as soon as the request starts, so a reconnect
   that hangs (a stopped daemon) stays `retrying`.
4. **Reconnecting chip.** With a log on screen, a `retrying` Watch shows a small
   "reconnecting…" chip at the top right of the thread pane (the SessionIndicator's
   style), hidden while the session is starting or closing.

### Live result (real Wails window, after the fix)

Same recipe as above (isolated home, haiku 5.5 at medium in a scratch repo, 1500-word
story, hide 6 s in, show after 30 s, wait 10 s). A scratch build (not committed) reported
the GUI's store seq, heartbeats, Watch opens and visibility events to a local listener,
so the catch-up time could be compared with the turn end's timestamp in the daemon.

| GUI state during the turn | runs | tail held (catch-up 5–6 s after the turn end) | behind at show | behind 10 s after show |
| --- | --- | --- | --- | --- |
| hidden 30 s | 7 | 5 | 0 | 0 |
| minimized 30 s | 2 | 1 | 0 | 0 |
| covered by Finder 30 s | 2 | 2 | 0 | 0 |

The hold still happens (8 of 11 runs), but every time the first heartbeat after the turn
end released it, 5.1–6.1 s later, while the window was still hidden. The other three
caught up within 0.5 s. No run was behind when shown, so the stall rate went from 8 of
14 to 0 of 11. On show the thread Watch reopened and its snapshot matched the daemon.

Watchdog check: `kill -STOP` on the daemon with the thread open. The Watch reported
`retrying: no data for 15 s` 15 s after the last heartbeat, the "reconnecting…" chip
appeared over the log, and after `kill -CONT` the Watch reopened with a snapshot and the
chip went away.

## Diagnostics kept on the branch

* `gui/frontend/e2e/live-stall.spec.ts`: an opt-in live run (`LIVE_DAEMON=1`,
  `CODE_FOUNDRY_HOME`, `LIVE_STALL_SESSION`, `LIVE_APP_URL`; with `LIVE_STALL_PROMPT`,
  `_SECS`, `_SCROLL`, `_SWITCH`, `_IDLE`) against Vite pointed at a real daemon. It
  samples daemon, store and DOM every 500 ms and fails naming the layer that lags. It
  cannot hide the page, so it does not reproduce this cause, but it rules out the store
  and render layers.
* `gui/frontend/src/stores/threadStall.test.ts`: the Watch batching model test (passes).
* `internal/api/thread_stall_test.go` and `gui/frontend/src/stores/threadStallVisibility.test.ts`:
  written before the fix, they failed on the diagnosis branch and pass with it. New tests:
  `internal/api/heartbeat_test.go` (the timer; each stream heartbeats when idle, never
  while busy, and ends on client cancel; seq unchanged), `api/streamLiveness.test.ts`
  (watchdog arming and firing, open status, resync) and `api/heartbeat.test.ts` (the
  stream openers map a heartbeat to `HEARTBEAT`).

The scratch tools were not committed: the Go Watch checker, the hide, minimize and occlude
scripts, the pane overlay and the per-send log. They are described above well enough to
rebuild.

## Gotchas

* `code-foundry <verb> --help` without `CODE_FOUNDRY_HOME` auto-starts a daemon in the
  real home. That happened once during this investigation (`~/.code-foundry`, about 44
  minutes, no threads reconnected). It was stopped with SIGTERM. It happened again during
  the fix's live check: a run script set its home variable but did not export
  `CODE_FOUNDRY_HOME`, so its `thread.send` started a daemon in `~/.code-foundry` (78 s,
  nothing reconnected, the send failed: unknown thread). Export the variable in scripts.
* The GUI started with an isolated home auto-starts a daemon as soon as its daemon dies.
  To restart the daemon with different flags, stop the GUI first.
* `go test` outside `make` needs `CGO_LDFLAGS=-mmacosx-version-min=13.0` as well as
  `PKG_CONFIG_PATH`. Without it, the build cache can link another worktree's
  libghostty-vt path.
* Haiku refuses to write the same story again and again. Vary the prompt between runs.
