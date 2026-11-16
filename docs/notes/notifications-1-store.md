# Notifications 1: the store, its API and its commands

The first of six steps of the notifications build: the daemon's record of what plugins (step 2)
and the `notification.post` command put in the bell. No GUI (step 3) and no plugin SDK here.

## What landed

- `internal/store/notification`: the store. Notifications in SQLite (migration 0063, one new
  table `notifications`, `UNIQUE (source, key)`), an atomic snapshot and a `Changed` event on
  the bus per commit. `notificationtest` opens the real store on a `dbtest` database with a clock
  the test moves and no loop (tests call `Tick`), so no sleeps anywhere.
- `NotificationService.List` (read only) and EventService's `notification` source (20, after
  layout): the whole active snapshot per change, with `arrived_ids` and `updated_ids`.
- Commands: `notification.post`, `.list`, `.dismiss`, `.snooze`, `.act`, `.clear`, `.withdraw`.
  A new `NotificationID` id kind (`n-` + 12 hex) resolves suffixes like the others.
- Daemon glue (`internal/daemon/notification_threads.go`): `thread.Removed` withdraws the
  thread's notifications; a sweep at start and every minute catches a removal the bus dropped.
- The way-back SQL for 0061 now also drops 0063's table (`internal/db/wayback`).

## The model as built

- **State** is one of active, dismissed, withdrawn, resolved. An active notification is shown,
  snoozed (`snoozed_until` set) or scheduled (`arrived_at` zero, waiting for `show_at`):
  `Notification.Status()`. Being shown depends only on stored fields, never on the clock; only
  `Tick` moves a notification into the bell, so the snapshot is the same whenever it is read.
- **Content** is level, time-sensitive, title, body, thread, actions and show_at (a SHA-256 of
  their JSON). A re-post of a key compares content:
  - same content, active, dismissed or resolved: `unchanged`, nothing written, no event;
  - same content, withdrawn: back as a new arrival (the source withdrew it and posts again);
  - changed, shown: `updated` in place (Changed.Updated, no toast);
  - changed, snoozed: `updated`, stays snoozed (the user asked not to see it yet);
  - changed, scheduled: arrives at its new show_at or now;
  - changed, closed: active again as a new arrival (`posted`, or `scheduled` for a future show_at);
  - changed with a show_at moved ahead while shown: it leaves the bell until then (`scheduled`).
- **Derived key**: `auto:` + 16 hex of SHA-256(title, body, thread). Another level or other
  actions update the same notification; other words are another one. A source may not use the
  `auto:` prefix.
- **Arrival** is a first post shown at once, a show_at reached, a snooze ended, or a closed key
  coming back. `Changed.Arrived` carries it; `Changed.Updated` carries in-place updates of
  shown ones. Consumers toast only arrivals.
- **Timers** compare the wall clock in `Tick` (every second, and once in `New`), as the thread
  store's snooze does: Go's monotonic clock stops while the Mac sleeps, so a `time.Timer` would
  fire late. A show_at or snooze that passed while the daemon was stopped arrives at start; the
  arrival event then goes out before any client is connected, so it toasts nothing (the
  snapshot shows it).
- **Clear** dismisses the shown ones only. Snoozed and scheduled ones stay: clearing the bell
  should not cancel a reminder the user cannot see yet, nor undo a snooze. (The brief said
  "every active one"; this is narrower on purpose.)
- **Snooze** takes a shown or snoozed notification; a scheduled one is refused (it is not shown
  yet), as is a closed one.
- **Withdraw** is by source and key; another source's key is NotFound. The CLI's
  `notification withdraw <key>` withdraws only source `command`'s.
- **Threads**: a post naming a thread (or a send action naming one) that the thread store does
  not have is NotFound. Removing the thread withdraws its active notifications. **Archive keeps
  them**: they stay in the bell, which is where the user finds the thread.
- **Act** looks the notification up, runs the caller's function without the store's lock, and
  resolves the notification only when that succeeded and the action resolves it. A failed run
  leaves it active. If the source changed the content while the action ran, the new content is
  not resolved: the user did not act on it.
- **Caps**: title 120 characters one line, body 1000, key 200, label 32, 3 actions, send text and
  start prompt 10000, URL 2048 (http/https only), 16 command args. 100 active notifications per
  source (ErrFull, FailedPrecondition to the CLI). Closed rows are pruned 30 days after their
  last change and past 5000, once an hour; after that a re-post with the same content shows again.

## Actions and their dispatch

Stored kinds: command (a plugin's manifest command + args; refused from source `command`), send
(thread + text), start (prompt + optional project), open (URL). `resolves` defaults to true for
command, send and start and false for open; a source may set it.

`notification.act` maps each kind to a registry verb (`notificationActionCalls` in
`commands_notification_act.go`) and runs it through `Registry.Invoke`, with the caller's view
and origin but none of its thread, project or worktree (the action says all it means), and the
caller's confirmation passed on:

- send: `thread.send --id --text`
- start: `thread.new --prompt --project`, or `--no-project` without one
- open: `view.open.url --url`
- command: not mapped yet; act fails Unimplemented. Step 2 adds the entry
  (`plugin.<source>.<command>` with the args) and decides how its confirm and origin work.

## Commands and the agent index

All seven verbs are `NoIndex`: the bell is the user's, and the brief asks for no text steering
agents to post. Posting is still a verb any caller has (`code-foundry commands`, `help
notification post`). Indexing them also put the guide over its byte budget. `notification.clear`
is the only one in the palette (the rest take an id or text). `act` is page class runs (it may
run a plugin command); the rest are state.

## The dock badge

`Snapshot.TimeSensitive` (and `NotificationSnapshot.time_sensitive`) counts the shown
time-sensitive notifications. Snoozed and scheduled ones do not count. Step 3 wires the badge.

## Gotchas

- Times are kept to the millisecond (`Truncate`), so a show_at read back from the database
  compares equal to the one posted; content compares times in UTC.
- Id args resolve by suffix, not prefix: `notification snooze 6c6f`, not `be49`.
- The guide budget (`internal/skills/budget_test.go`) fails when a category's verbs join the
  index; mark them `NoIndex` with a reason in `index_test.go` or cut elsewhere.
