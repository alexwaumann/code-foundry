# gh store: poll cadence by GUI presence

Status: done on `cf/gh-poll-tiers` (PR 2 of 3 after #152). `make check` is green. Run end
to end on 2026-10-17 with a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cfpt-home`,
`daemon --dev`, this repository registered, default 60 s poll), the built GUI against it,
and the CLI's `events` verb.

## What changed

The fingerprint poll used to run every `github.poll_interval_seconds` around the clock.
Now the interval after each poll depends on whether anyone is looking:

| Presence | Meaning | Interval after a poll |
|---|---|---|
| foreground | a GUI client is connected and its window is visible | the configured interval (60 s default) |
| background | GUI clients are connected and every one reports hidden | `DefaultBackgroundInterval`, 5 min |
| none | no GUI client (only the CLI, or nothing) | `DefaultNoGUIInterval`, 15 min |

`nextInterval(cfg, presence, idle, idleInterval)` (`internal/store/gh/presence.go`) is
`max(configured, tier)`, then `max(that, IdleInterval)` when nothing is tracked or
watched. The configured interval is a floor, so a 20 min setting is never shortened. The
stats-deferred case (interval 0 right after the viewer's id arrives) is unchanged.

**Signal.** `WatchEventsRequest` gained `client_kind` (unspecified, gui, cli),
`client_id` (a token the GUI makes per stream) and `visible`. `EventService.SetClientState
(client_id, visible)` updates an open stream (a stream request is immutable once open);
NotFound for an unknown id, InvalidArgument for an empty one. The CLI's `events` verb
sends `CLIENT_KIND_CLI`; unspecified and CLI streams are never counted.

**Registry.** `api.Clients` (`internal/api/events_clients.go`) keeps the GUI streams by
`client_id` with their visibility; Watch joins before the first send and leaves when the
stream ends. Its `Presence()` is `gh.Options.Presence`; on each change of presence it
calls `gh.Store.PresenceChanged(from, to)` (wired in `internal/daemon/daemon.go`). The gh
store never imports `internal/api`; `gh.Presence` is its own type. Nothing about the tier
is stored: `applyPoll` reads `Presence()` after every poll.

**Snap-back.** `PresenceChanged` on a rise (none → any, background → foreground) moves the
next poll to `lastPoll + nextInterval(new presence)`, which is within `pollDebounce`
(0.5 s) when the last poll is older than that. A fall changes nothing until the next poll
schedules the one after it. The worker sleeps on a timer in a `select` that also reads
`s.wake`, so `nudge()` interrupts a 15 min sleep at once (`TestPollTiersAndWake`).

**Writes.** Every GitHub write now brings the poll forward through one helper,
`s.pollSoon()`: MergePullRequest, SubmitPullRequestReview, RevertPullRequest (as before),
plus AddPullRequestComment and SetReviewRequest (new). Refresh is unchanged.

**GUI.** `watchEvents` (`src/api/events.ts`) opens the stream as a GUI client with a
fresh 24-hex id and `document.visibilityState`. `startEventSync` adds one
`onVisibilityChange` listener (`src/api/stream.ts`; `onBecameVisible` is now built on it)
that calls `reportVisibility()`, which sends SetClientState when the page's state differs
from what the daemon last heard. Calls are chained and each reads the visibility when it
runs, so out-of-order completion cannot leave a stale state. On the stream's first message
it reports once more, covering a change made while the stream was opening (SetClientState
before the daemon joined the stream answers NotFound and is dropped). No new timers.

**Setting text.** The `github.poll_interval_seconds` description (schema and the mock's
copy) now says the interval applies while the window is visible and names the 5 and 15
minute cadences. The key and its range are unchanged.

**Logs.** Info `gh poll tier` on each presence change (`from`, `to`, `interval`,
`poll_soon`, `next_in`). The `gh poll` debug line gained `tier` and `next_in`.

## Decisions

* **The snap-back threshold is the new tier's interval, not always the foreground one.**
  The brief said "poll soon if the last poll is older than the foreground interval" for
  every rise. For background → foreground that is what happens. For none → background (a
  GUI that starts hidden), the next poll moves to 5 min after the last one instead of
  right away: nobody is looking, and it still never waits the 15 min it had planned.
  A rise inside the threshold still pulls the next poll in: background → foreground 15 s
  after a poll moved the 5 min schedule to 45 s (measured below).
* **No `pollAgain` on a presence rise.** `pollSoonLocked` sets `pollAgain` so a poll
  running now is followed by another (it may have planned without the caller's change).
  Presence does not change a plan, and the running poll's schedule already reads the new
  presence, so `PresenceChanged` moves `pollNext` directly and nudges.
* **The tier log is on the presence change, not on the next poll.** It says right away
  what the next interval will be. No previous tier is kept for it: the registry passes
  `from` and `to`.
* **Registry callbacks run with the registry locked**, so changes arrive in order.
  `PresenceChanged` takes `s.mu`; the store reads `Presence()` only without `s.mu` held, so
  the two locks are never taken in the other order.
* **A reused `client_id` replaces the first stream's entry**; the first's leave then leaves
  the second alone. Only a broken client reuses an id. A GUI stream without an id counts
  with the visibility it opened with.
* **New() is unchanged**: after a restart the first poll waits out the configured interval
  from the cached poll, whatever the presence. `lastPoll` starts at the cached poll's
  time, so a GUI connecting right after a restart does not poll early.

## Measured (2026-10-17, CDT, from the scratch daemon's log; fields trimmed)

GUI start, last poll 10 s old: the next poll moved from 15 min to 51 s, not right away.

```
04:49:19.684 DEBUG "gh poll" details=50 dur=11.348s tier=none next_in=15m0s
04:49:29.086 INFO  "gh poll tier" from=none to=foreground interval=1m0s poll_soon=false next_in=51s
```

Cmd-H (System Events `visible` false): background; the next poll schedules 5 min.

```
04:49:41.139 INFO  "gh poll tier" from=foreground to=background interval=5m0s poll_soon=false next_in=39s
04:49:41.139 DEBUG request POST /codefoundry.v1.EventService/SetClientState status=200 origin=wails://localhost
04:50:21.278 DEBUG "gh poll" dur=1.592s tier=background next_in=5m0s
```

Window brought to the front 3 min 21 s after that poll: snap-back. The poll started 0.5 s
after SetClientState (it ended 04:53:45.949 after 3.055 s).

```
04:53:42.392 INFO  "gh poll tier" from=background to=foreground interval=1m0s poll_soon=true next_in=1s
04:53:42.392 DEBUG request POST /codefoundry.v1.EventService/SetClientState status=200
04:53:45.949 DEBUG "gh poll" requests=2 details=1 dur=3.055s tier=foreground next_in=1m0s
```

Minimized (AXMinimized) and restored 15 s after a poll: background, then foreground
without a poll, the 5 min schedule pulled in to 45 s.

```
04:53:55.665 INFO  "gh poll tier" from=foreground to=background interval=5m0s poll_soon=false next_in=50s
04:54:48.986 DEBUG "gh poll" dur=3.036s tier=background next_in=5m0s
04:55:03.696 INFO  "gh poll tier" from=background to=foreground interval=1m0s poll_soon=false next_in=45s
```

GUI quit (SIGTERM): no GUI; the next poll schedules 15 min. Then `code-foundry events
--source gh` (unix socket, CLIENT_KIND_CLI) streamed snapshots: no tier change.

```
04:55:11.594 INFO  "gh poll tier" from=foreground to=none interval=15m0s poll_soon=false next_in=37s
04:55:51.746 DEBUG "gh poll" dur=2.758s tier=none next_in=15m0s
04:55:58.682 DEBUG request listener=unix POST /codefoundry.v1.EventService/Watch status=200 origin="" dur=1.021s
```

GUI started again 70 s after the last poll: none → foreground with a poll 0.5 s later.

```
04:57:02.253 INFO  "gh poll tier" from=none to=foreground interval=1m0s poll_soon=true next_in=1s
04:57:04.411 DEBUG "gh poll" dur=1.656s tier=foreground next_in=1m0s
04:57:10.116 INFO  "gh poll tier" from=foreground to=none interval=15m0s next_in=54s   (GUI quit)
```

## Gotchas

* **Unhiding the app is not "visible" if its window is covered.** WebKit's
  `visibilityState` follows occlusion: after System Events `visible true` the window sat
  behind other windows and stayed hidden; it turned visible (and snapped back) only once
  frontmost. A GUI fully covered by other windows therefore polls in the background tier,
  which is intended.
* `next_in` is rounded to seconds, so a 0.5 s debounce logs as `next_in=1s`.
* `cmd/code-foundry` `TestRunEvents` and `internal/store/thread` `TestSendSpawnFailure`
  (claude exits before its handshake: "writ…" vs "exit code 2") each failed once during
  `make check` and pass on rerun; neither touches this change (timing flakes).

## Tests

* `TestNextInterval`: each tier, idle against each tier, the configured interval as a
  floor (20 min) for every tier and idle.
* `TestPresenceChangedSnapBack`: rises with the last poll older or younger than the new
  tier's interval, none → background, a sooner poll never delayed, idle, falls and no
  change leave the schedule alone; `pollAgain` never set; nudge only on a rise.
* `TestPollTiersAndWake`: a running store schedules 15 min with no GUI, a rise inside the
  threshold does not poll, background → foreground wakes the worker off its 15 min timer
  and polls, falling back to background schedules 5 min.
* `TestWritesPollSoon`: review, comment, and review request each bring a poll.
* `TestClientsPresence` (api): join/leave/set, two GUI clients where one is hidden, the
  visible one hiding or leaving, unknown and empty ids, a stream without an id, a reused
  id; the change log of each.
* `TestEventsClientState` (api, over the real handler): CLI and unspecified streams do not
  count and SetClientState cannot find them; GUI streams join hidden, are set visible,
  leave when their stream ends (NotFound after); empty id is InvalidArgument.
* `src/api/eventsVisibility.test.ts`: the request carries GUI kind, a fresh id per stream
  and the page's visibility; changes are sent only when they differ; a change made before
  the daemon joined the stream is sent on its first message; nothing without a stream.
