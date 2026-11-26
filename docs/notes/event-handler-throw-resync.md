# A slice handler that throws resyncs from snapshots, once per minute at most

Since the GUI's one `EventService.Watch` resumes with `since_seq` after a reconnect
(docs/notes/perf-gui-reconnect-pr-patch-diff-cache.md), its resume cursor advanced only after
`dispatchEvent` returned. A slice handler (or a bridge tap) that threw on an event failed the
attempt; the reconnect resumed at the same `since_seq`; the daemon replayed that event first; it
threw again. `runStream` resets its backoff on every message, so this repeated about every 250 ms
until 4,096 newer events pushed the event out of the hub's resume log. Every live update stopped
meanwhile, and a tap that threw after its slice took the event re-applied it (and its toasts) on
each loop. Before resuming existed, a reconnect took snapshots and stepped past the event.

## The fix (`stores/events.ts`)

- **Taps are contained one by one** (`tellTaps`). A tap that throws is logged with
  `console.error`; the other taps still hear the event, and the stream goes on. The slice took the
  event before the taps run, so there is nothing to resync.
- **A slice handler's throw on a live event (seq > 0) restarts the stream from snapshots.** The
  cursor goes to 0, the attempt ends with a `HandlerFailedError`, and the next attempt (about
  250 ms later: the attempt had heard messages, so the backoff is at its start) connects without
  `since_seq`. That is the same path as a resume the hub could not serve: every slice is rebuilt,
  exited terminals are pruned, watched GitHub details are read again. The event is never replayed,
  and the slice it broke is not left half-applied.
- **The guard: at most one such resync per `HANDLER_RESYNC_COOLDOWN_MS` (60 s).** Within it, a
  throwing live event is skipped (cursor advances past it) and marked; the first live event after
  the cooldown resyncs before it is applied. A handler that throws on every event therefore costs
  one snapshot reconnect a minute, not a loop.
- **A throw on a snapshot event (seq 0) is skipped and never resyncs**: the next snapshot would
  bring the same event back. The live throw that led to that snapshot already resynced once, so a
  handler that throws on both paths gives exactly one resync and then carries on.
- **Reporting.** Every throw is `console.error`ed with the source and the event. A resync also
  shows one error toast (fixed id `event-handler-failed`, so it replaces itself), and the status
  row says "retrying" with the error for the moment the reconnect takes. An observer (the shot
  window's page check) gets no toast.
- `onError` skips `invalidateOnTransportError` for `HandlerFailedError`: the endpoint is fine.

## Decisions

- **Resync, not skip.** Skipping alone would end the loop but leave the broken slice silently out
  of step (half-applied state, a missed removal) until the next real reconnect. Snapshots are what
  a reconnect did before `since_seq`, so this costs one full snapshot burst per failure, which is
  what every reconnect cost before #898.
- **Not retry-the-resume.** Resuming at the same seq cannot succeed: the replayed event is the same.
- **Time cooldown over an attempt flag.** "No second resync during the recovery attempt" would
  leave events skipped for as long as that attempt lasts (hours). The cooldown bounds both the cost
  and how long a skipped event can stay unrepaired. The deferred resync waits for a live event (not
  a timer): heartbeats are not events, and the gh poll alone brings events often.
- **Replayed arrivals are left as they are.** On a resume, replayed notification and thread-list
  events arrive as live ones, so arrival toasts, the bell tilt and the dock bounce can fire for
  things that arrived while the GUI was disconnected, where a snapshot used to re-baseline them.
  Only a resume does this (a daemon restart or a wrapped log still takes snapshots), so it covers
  what arrived during a short drop while the daemon kept running. Showing those is arguably right;
  hiding them is a separate change (the envelope would need to mark replayed events) and is not in
  this fix.

## Gotchas

- Only a live event's throw can resync. A mid-stream resync snapshot (a source whose queue
  overflowed) is seq 0 too, so its throw is skipped, as on connect.
- vitest's fake timers fake `Date.now`, which the cooldown reads; the tests in
  `stores/eventsReconnect.test.ts` drive it with `advanceTimersByTimeAsync`.
