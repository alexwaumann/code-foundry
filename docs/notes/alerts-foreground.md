# Dock alerts for the open thread: focus joins GUI presence

Status: done on `cf/alerts-foreground`. Design signed off by Alex on 2026-10-19.

## The bug

With Code Foundry in the background, or its window covered, a turn that ended in the
thread open in the main pane never bounced the Dock or played the sound, and never
counted on the badge. The open thread view holds a `ThreadService.Watch` stream, which is
an items viewer (`Manager.WatchItems`). The runner acknowledged "finished" on every
result while a viewer watched (`acknowledgeIfViewed`), and `addViewer` / `SetFlag` saw
until-seen flags whenever one did. So that thread never entered the attention set, and
`stores/dockAlerts.ts` ("a thread entered the set while unfocused") never saw it. The
daemon's idea of "the user saw it" was "a GUI holds the stream", whatever the window was
doing.

## The rule

An open thread view counts as the user seeing the thread only while the daemon's
presence is **attended**: some GUI client reports its window both visible and focused
(key). While it is not:

* a result in a viewed thread does not acknowledge (the thread ends NeedsAttention
  "finished" like any other; also the wake-limit note);
* a viewer opening a thread does not acknowledge it, nor see its until-seen flags;
* a new until-seen flag on a viewed thread is stored, not dropped as seen.

When presence rises to attended, every thread with a viewer is acknowledged and its
until-seen flags are seen, as if the view had just opened (`Manager.AttendedChanged`). A
fall changes nothing: what was seen stays seen. Answering a request
(`Respond`) is an explicit act and still acknowledges, attended or not.

The frontend uses the same rule for itself: `dockAlerts.ts`'s input is now `attended`,
`isPageAttended()` = `document.visibilityState === "visible" && document.hasFocus()`.
The pure `stepDockAlerts` trigger is unchanged; it now sees the open thread enter the
set because the daemon no longer acknowledged it.

## Package layout

* **`internal/presence`** (new): `Kind` (None, Background, Foreground; ordered),
  `State{Kind, Attended}`, `Client{Visible, Focused}`, `Of([]Client) State` (the
  derivation), and `Tracker` with `Current()`, `Subscribe(func(from, to State))
  (unsubscribe)` and `Set(State)`. Subscribers run in subscription order, one change at
  a time (a `notify` mutex serialises `Set`), and the state mutex is never held while a
  subscriber runs, so `Current()` is safe from anywhere, under any lock, including from
  inside a subscriber (it already returns the new state). A store that wants "is the
  user looking at the app" takes `tracker.Current` as an option and subscribes in
  `daemon.go`; no new plumbing.
* **`api.Clients`** is the tracker's one writer: `NewClients(tracker)`, `Join(id,
  presence.Client)`, `SetState(id, presence.Client)`; after each change, with its own
  lock held, it hands `presence.Of(all clients)` to `Tracker.Set`. SetClientState
  carries `focused`.
* **`gh`** keeps its tiers on `Kind`: `gh.Presence` is now an alias of `presence.Kind`
  and `PresenceNone/Background/Foreground` are its constants, so the store and its tests
  are untouched. `daemon.go` subscribes `gh.PresenceChanged(from.Kind, to.Kind)` when
  the kind changes (attended-only changes do not reach gh, so its tier log and snap-back
  behave as before).
* **`thread`**: `Options.Attended func() bool` (nil = always attended: tests, fakes and
  anything without a daemon keep today's behaviour) and `Manager.AttendedChanged(bool)`,
  in `internal/store/thread/attended.go`. The rise signals each viewed thread's runner
  on a new `seenSig` channel (separate from `viewSig`, whose handler acknowledges only
  when the viewer count rose).
* **Proto**: `WatchEventsRequest.focused = 7`, `SetClientStateRequest.focused = 3`.
  Additive; an older GUI sends neither and its clients are never attended, which only
  means its open thread alerts (the safe side).

## Frontend

* `api/stream.ts`: `isPageFocused()`, `isPageAttended()`, and `onPageStateChange(cb)`,
  which listens to `visibilitychange` (document) and `focus` / `blur` (window) and calls
  back once the state held still for 100 ms (`PAGE_STATE_SETTLE_MS`), so a blur/focus
  pair from a native menu or sheet is one call.
* `api/events.ts`: `reportVisibility` became `reportClientState`, which sends
  `{visible, focused}` when either differs from what the open stream last reported
  (chained, each call reads the state when it runs, failures dropped as before). The
  stream opens with both; its first message re-reports, as before.
* `stores/events.ts` uses `onPageStateChange(() => void reportClientState())`.
* No Playwright change: the mock daemon's SetClientState is a no-op.

## Decisions

* **Attended is "some single client visible and focused", not "any visible" and "any
  focused" from different clients.** A focused but hidden window (minimized while key)
  and a visible but unfocused one are both "not looking".
* **The thread store does not cache the state.** `Options.Attended` is read where it
  matters (under `m.mu` in `addViewer` and `SetFlag`, on the runner goroutine for
  results). The tracker's `Current` never waits on a subscriber, so there is no lock
  cycle with `AttendedChanged` (which takes `m.mu` while the registry lock is held), and
  no lost update: a viewer added just before the rise is caught by `AttendedChanged`
  under `m.mu`, one added just after reads attended itself.
* **Coalescing is a 100 ms settle in the GUI**, not in the daemon; the daemon applies
  each report at once. `reportClientState` is idempotent, so a flip that lands back on
  the reported state sends nothing.

## Gotchas

* A CLI never opens `ThreadService.Watch`, so all viewers are GUI views; with no GUI
  connected presence is never attended, which is moot.
* The race window after leaving the app: the GUI reports the blur after 100 ms plus a
  round trip; a turn that ends inside it is still acknowledged (no alert). Coming back,
  the daemon acknowledges the open thread right after the focus report, so the badge
  drops within the same window.
* `go vet`'s lostcancel flags a `ctx, cancel = context.WithCancel` assigned to an outer
  variable inside a test loop; the tests open viewers through a helper that registers
  `t.Cleanup(cancel)`.

## Tests

* `internal/presence`: `TestOf` (no clients, hidden, focused but hidden, visible but
  unfocused, both, mixed clients), `TestTrackerSubscribers` (order, no call without a
  change, `Current` inside a subscriber, unsubscribe), `TestTrackerUnsubscribeDuringSet`.
* `internal/api`: `TestClientsPresence` gained focus cases (visible but unfocused,
  focused but hidden, focus returning, two clients split between visible and focused,
  the attended one leaving); `TestEventsClientState` carries `focused` over the real
  handler, in the request and in SetClientState.
* `internal/store/thread` `TestAttendedAcknowledge` (fixture claude): viewer during the
  turn attended or not, the user returning with and without a viewer, the viewer closed
  first, a finished thread opened while away then attended, leaving mid-turn.
  `TestAttendedUntilSeenFlags`: the same matrix for until-seen flags, checked again
  after a restart (the database agrees).
* Frontend: `api/pageState.test.ts` (the attended predicate's four cases, the settle and
  its coalescing, stop), `api/eventsVisibility.test.ts` (the request carries focus,
  focus changes reported once each, a flip back sends nothing), `dockAlerts.test.ts`
  renamed to `attended`.

## Verified live (2026-10-19)

Isolated: `daemon --dev` and the built GUI on `CODE_FOUNDRY_HOME=/tmp/cf-af-home`, a
scratch repo under home, one Haiku 5.5 (`claude-haiku-5-5[1m]`) medium thread created
with the CLI and shown in the main pane with `thread.focus`, `cooldown_seconds 0`. The
badge was read with `lsappinfo info -long <ASN> | grep StatusLabel`, the bounce from the
GUI's `dock bounce` stderr line, presence from the thread store's debug line `thread
attention follows presence` and gh's `gh poll tier`.

* **Startup**: the GUI joined attended (`attended=true` with `gh poll tier
  none>foreground`), then SetClientState reported `attended=false` when the window lost
  key.
* **Another app active, window still visible**: presence `attended=false`, gh tier
  stayed `foreground`. A prompt sent to the open thread ended NeedsAttention
  "finished" (17:31:10.511Z), the GUI logged `dock bounce` 9 ms later, badge "1".
  Bringing the GUI forward: `attended=true` at 12:31:19.122, the thread Idle "at
  prompt" 100 ms later, badge removed (`kCFNULL`).
* **Covered**: Finder frontmost with a Finder window over the whole GUI window: WebKit
  reported hidden (`gh poll tier foreground>background`), not attended. The turn ended
  "finished", `dock bounce` at 12:31:29.022, badge "1". Back in front: attended, Idle,
  badge removed.
* **Control, attended**: GUI kept frontmost and key during the turn: the turn ended Idle
  (17:31:51.18Z, attended from 50.50 to 51.93), no bounce, no badge.
* The old build was not re-run for comparison; by the code (and the bug report) the first
  two cases ended Idle at once there, the open view acknowledging the result.
  `TestAttendedAcknowledge` fails in 11 subtests with the attended check removed.

Gotcha seen here: other sessions' GUIs on the same Mac take the focus every few seconds
(`attended` flips between runs), and an isolated GUI opens on top of theirs at the same
spot, so `screencapture -R` of its bounds can show someone else's window. Move yours
first (`set position of window 1` of the process by unix id).
