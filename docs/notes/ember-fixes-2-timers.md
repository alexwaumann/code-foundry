# Ember fixes 2, PR C: timer notes, local times, scheduled timers on the board (2026-10-21)

Findings e13-2, e13-3, e13-5 and e13-7 of the second Ember battle test
(`/tmp/ember-r2/results/SYNTHESIS.md`, "PR C: timers"). Timers came in
`ember-1-primitives.md`; the board in `ember-2-store.md` and `ember-3-gui.md`.

## What was built

### Notes on subscriptions (e13-2)

- `thread subscribe --note "<why>"` (`SubscribeThreadRequest.note`, `SubscribeOptions.Note`)
  is stored on the subscription: migration 0043 adds `thread_subscriptions.note` (TEXT,
  default ''). `thread.CleanNote` puts it on one line (whitespace runs as one space) and
  refuses more than `MaxNote` (200) characters: INVALID_ARGUMENT from the store, an args
  error from the CLI before any request.
- Any subscription takes one, not only timers. Subscribing again to the same target
  (`existed`) with a note replaces the note; without one keeps it.
- A timer's wake header ends with it: `Timer sub-… fired at 01:32 CDT (set for 01:32 CDT):
  remind the user to review the PWA branch (t-aa39dec3).` Every wake's JSON has
  `"note"` (omitted when empty): timer, thread, removed thread, action run, pull request,
  plugin. Only the timer puts it in the header; a thread wake's header is long already.
- `thread subscriptions` gets a NOTE column, only when some listed subscription has a
  note (the table is unchanged otherwise; rows without one carry no trailing spaces).
  `ThreadSubscription.note` carries it in `--json`.
- `thread subscribe` / `unsubscribe` messages end ` · <note>`.

### Local times in subscribe and unsubscribe (e13-5)

`timerWhen` printed `at 2026-10-21T06:25:45Z`; it now uses the store's clock format
(`thread.ClockTime`, exported from `clockTime`): `wakes at 01:25 CDT (once)`, `at Oct 21
15:00 CDT` when not today. `--json` keeps the UTC target id. `thread subscriptions`'
LAST FIRED stays UTC (the decision covered subscribe and unsubscribe only).

### Ember's timers on the board (e13-3)

- The thread store publishes `thread.SubscriptionsChanged{SubscriberID}` on the bus
  whenever a subscriber's subscriptions change: one added, removed (unsubscribe, a
  one-shot that fired, archive), a repeat one fired (its count, a timer's next slot), a
  note or repeat flag rewritten. It is its own bus type, so `thread.Event` subscribers
  (ThreadService.Watch and the rest) see nothing new.
- `Subscription.NextAt` and `Every` are read-time fields `DescribeTimer` (exported) fills
  for a timer in `Subscriptions`.
- The Ember store follows `SubscriptionsChanged`: `refreshTimers` reads the resident's
  subscriptions (off its lock), keeps the timers (`timersOf`: soonest first) and
  republishes. `Snapshot.Timers` (`ember.Timer`: ID, NextAt, Every, Note, CreatedAt); the
  store's `Threads` interface gained `Subscriptions`.
- Proto: `EmberBoard.timers` (4; 3 is the heartbeat from main), `EmberTimer{id, next_at, every ("2m", "" for once),
  note, created_at}`. WatchBoard sends a new board on every timer change.
- `ember board` and seed BOARD.md get a `## Scheduled` section between Blocked and Done
  today (only when there are timers), one line per timer:

  ```
  ## Scheduled

  Your timers; `code-foundry thread unsubscribe <id>` cancels one.

  - 15:00 CDT · once · remind the user to review the PWA branch (t-aa39dec3) · sub-356d9568d82c
  - 01:34 CDT · every 2m · ping the user · sub-1eabd59314b2
  ```

  Times in the board's zone, with the date when not today. `ember board --json` is
  still the task list (unchanged shape).
- GUI (`BoardSurface.tsx`): a "Scheduled" section between Up next and Done today, one
  bordered card (like a task card) holding one row per timer in the worker line's style
  (h-6, `text-caption`): an `AlarmClock` where the dot sits, the note (or "Reminder",
  muted), "every 2m" for a repeating one, the time (`snoozeTimeShort`: "3:32 PM", "Wed
  3:00 PM", "Oct 19, 9:00 AM"), and a ghost `icon-xs` shadcn Button with an X that runs
  `thread.unsubscribe <id>` (quiet; disabled while it runs). The row goes when the board
  stream says so. The header adds "· N scheduled" when there are timers; a board with
  timers and no tasks shows the section instead of the empty state.
- `lib/ember.ts` `timerRows` (pure, vitest); `api/ember.ts` `EmberTimerView`;
  `stores/ember.ts` `useEmberTimers`, `useBoardCounts().scheduled`.
- Mock: `MockEmber` keeps timers (none after a reset); `POST
  /__mock/ember/timer?minutes=…[&every=2m][&note=…]` adds one (returns `{ id }`); the mock
  gains `thread.unsubscribe` (by subscription id, for Ember's timers only).

### A thread wake's run time (e13-7)

The thread block of a thread wake's JSON has `started_at` (the last top-level user
message: its brief, a follow-up or a wake) and `ran_for` ("2m 22s", `thread.RunTime`):
to the turn end after it when the thread is idle, else to the fire (a pending prompt, a
turn still going). Left out for a thread that never got a message. Batched and restart
wakes carry it too (they share `threadWakePayload`). JSON only; the header stays as it
was.

### Skill

Ember's SKILL.md (v2, PR #290, already had `--note "<why>"`) "Later" line only: the
placeholder is `--note "<what to tell the user> (t-…)"` and it says the wake and the
board show the note. The guide (at its cap) and the orchestrate skill's `wakes.md` are
not touched, so `ran_for` and `note` are self-describing in the wake JSON.

## Decisions

- **Notes on every subscription**, not only timers: the column is generic, a note on a
  `--notify` subscription costs nothing, and the decision named `thread subscribe`.
- **Note too long is an error, not a cut**: an agent learns the limit once; a cut note
  could lose the task id at its end.
- **Its own bus event** instead of polling subscriptions on the ember store's minute
  tick: the board's × must drop the row at once, and a one-shot that fires must leave.
- **Scheduled in BOARD.md before Done today**: open things first, history last.
- **No tooltip on ×**: an icon button with an aria-label naming the note (the tooltip
  rule: tooltips only for hidden information).

## Gotchas

- `gofmt` rewrote `''` in a Go comment to a typographic quote; say "empty" instead.
- The command package has local variables named `thread`; it imports the store as
  `threadstore` in `commands_thread_subscribe.go`.
- Migration numbers must be unique (`LoadMigrations` refuses a shared version): PR A
  (task branch column) may also take 0043; whichever merges second renumbers.

## Tests

- Store: `TestCleanNote`, `TestTimerNote` (stored, listed with NextAt/Every, replaced,
  persisted across a restart, in the wake header and JSON, SubscriptionsChanged
  published), `TestTimerWakeMessage` note cases, `TestRunTime`, `TestThreadWakeRunTime`
  (turn end, last turn only, subagent turn ends ignored, prompt and live turn to the
  fire, no message). DB: `TestThreadSubscriptionNoteMigration`.
- Ember: `TestRenderBoard` (Scheduled cases), `TestTimersOf`, `TestTimers` (resident only,
  soonest first, BOARD.md after a reseed, cancel).
- API: the note through Subscribe/List and a long one refused; `EmberBoard.timers`.
- Commands: local times, the note on subscribe and unsubscribe, the NOTE column, a long
  note refused.
- Frontend: `timerRows` (vitest); e2e `ember.spec.ts` "Scheduled lists Ember's timers
  before Done today; the × cancels one".

## End to end (2026-10-21, scratch home)

`make build`; `CODE_FOUNDRY_HOME=/tmp/ember-fix-c bin/code-foundry daemon --dev`; Ember
and its workers on Haiku 5.5 at medium; `cf` pins that home.

```
$ cf thread send --id <ember> --text "Remind me in 1 minute to stretch my legs and refill my water. Put a note on the reminder." --wait
# Haiku reached for Claude Code's own ScheduleWakeup tool, not the skill (a PR D matter);
# asked again to use the code-foundry timer from its skill's Later line, it ran:
code-foundry thread subscribe --at 1m --note "Reminder: stretch your legs and refill your water."
→ subscribed sub-e1c6b6bc0708: s-9524e28859e1 wakes at 09:36 CDT (once) · Reminder: stretch your legs and refill your water.
$ cf thread subscriptions --id <ember>
ID                SUBSCRIBER              TARGET              UNTIL  REPEAT  FIRED  LAST FIRED  TARGET STATUS   NOTE
sub-e1c6b6bc0708  s-9524e28859e1 (Ember)  timer at 09:36 CDT  fired  no      0      -           next 09:36 CDT  Reminder: stretch your legs and refill your water.
$ cf ember board
## Scheduled

Your timers; `code-foundry thread unsubscribe <id>` cancels one.

- 09:36 CDT · once · Reminder: stretch your legs and refill your water. · sub-e1c6b6bc0708
# the wake:
Timer sub-e1c6b6bc0708 fired at 09:36 CDT (set for 09:36 CDT): Reminder: stretch your legs and refill your water.
{ "kind": "timer", …, "at": "2026-10-21T14:36:50.656Z", "note": "Reminder: stretch your legs and refill your water." }
```

Then two timers by hand (`--at 2h --note …`, `--every 30m --note …`) and `ember reseed`:
seed/BOARD.md had both under Scheduled, soonest first. A plain parent subscribed to a
child (`--note "check the child's answer"`) got a settled wake with `"note"` and
`"started_at": "…14:37:14.755Z", "ran_for": "5s"` (the turn itself took 2.8 s; the rest
is the spawn after the message). In the GUI (Vite against the scratch daemon, WebKit)
the Board showed both timers; the × on the repeating one removed it from the board and
from `thread subscriptions`. Then the daemon was stopped and the scratch home and its
transcripts deleted.

## Daemon restart

Needed after merging: migration 0043, new proto fields, the ember store's timers.
