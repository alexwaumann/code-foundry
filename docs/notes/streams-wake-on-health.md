# Streams wake when the daemon answers again

After an outage of more than a few seconds (a crash before something restarts the daemon, a slow
`daemon restart`, an install that stops it), the status dot turned green but the thread still showed
"catching up…", and the board and Events came back on their own schedules. Each `runStream` runner
slept out its own backoff (`defaultBackoff`: 250 ms doubling to 10 s, ±20% jitter). Only a stop or a
resync (`resyncOnVisible`) cut that sleep short. Nothing told the runners that the daemon answered
again. This was true of the fetch streams too, but since every view became a stream on this path
(#593), they all lag together.

## The fix

- `api/stream.ts` keeps a module-level set of the wake-ups of runners now sleeping in backoff. A runner
  adds its wake-up just before the sleep and removes it after. `wakeAllStreams()` calls each one, which
  ends the sleep the same way a stop or a resync does, so the runner starts its next attempt at once.
- `stores/health.ts` calls `wakeAllStreams()` when a ping succeeds after the status was not `ok`
  (`connecting` or `error`). The status is set first, then the streams are woken.

## Decisions

- **Only sleeping runners are woken.** An open attempt is left alone, and so is one that is still
  connecting (its request may be the one that is about to succeed). Neither is in the set.
- **The wake does not reset the backoff.** If the new attempt fails too (the daemon answers pings but
  the stream errors), the runner sleeps longer next time, as before. The next wake comes only after
  health goes to `error` and back, so a stream that keeps failing cannot loop on wakes.
- **No staggering.** A page has 3 or 4 streams on this path (Events, the viewed thread, Ember's board,
  a terminal), plus a plugin surface or a dictation watch when they are open. In the repro the three
  that came back reopened within 14 ms of each other, and the daemon logged no warning or error. A
  thread's snapshot is the largest message, and it is sent on any reconnect anyway.
- **The startup transition (`connecting` to `ok`) also wakes.** At launch the streams may already be in
  backoff while the daemon starts. Waking them there is what we want.
- **The health poll sets the delay.** It pings every 2 s, so a stream now returns within about 2 s of
  the daemon answering, instead of up to 12 s.

## Gotchas

- A daemon restart prunes shells, so a terminal's Attach does not come back after one. The repro
  measured Events, WatchBoard and WatchThread. Attach uses the same runner.
- The repro has to re-point the page at the new daemon, which has a new port and token: it swaps
  `daemon.resolve` (from `api/endpoint.ts`) for one that reads `window.__ep`, and sets `__ep` once
  the new daemon wrote its port and token. This mimics the Wails host's resolve after a restart.
