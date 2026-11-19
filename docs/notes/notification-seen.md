# Notifications: seen, and the bell's corner badge

A user found it hard to tell that new notifications had arrived: the bell's count looked the same
for one from an hour ago and one from five seconds ago. The daemon now keeps, per notification,
whether the user has seen it since it last arrived, and the bell shows a corner badge while a
shown one is unseen.

## What landed

- Migration 0064: `notifications.seen INTEGER NOT NULL DEFAULT 1`. Additive; rows from before it
  take the default, seen, so an upgrade lights no badge for notifications the user already had.
  The way back from 0061 (`internal/db/wayback/0061_layout.sql`) also forgets version 64 (its
  column goes with the table it already drops).
- `notification.Notification.Seen`, `Snapshot.Unseen` (shown and unseen), `Store.See(ctx, id)`
  (id "" sees every shown one), and the same on the wire: `Notification.seen`,
  `NotificationSnapshot.unseen`.
- `notification.seen [id]`: every shown one, or one by id (a suffix resolves). `notification list`'s
  JSON carries `seen` per notification and `unseen`.
- GUI: `lib/notifications.ts` `bellCount` gains `unseen` and `unseenUrgent`, `unseenIds`;
  `stores/notificationSeen.ts` runs `notification.seen` while the bell is open;
  `NotificationBell.tsx` draws the badge.

## The rules

- **Unseen on arrival**: wherever the store sets `arrived_at` (its first post shown at once, a
  show_at reached, a snooze ended, a closed key coming back). An in-place update of a shown one
  keeps its seen state, and so does a snooze (the arrival at its end makes it unseen).
- **Seen**: opening the bell's list (`notification.seen` with no id); an arrival while the list is
  open (on screen, so seen at once); acting on a notification (`notification.act`, from the
  panel, a toast or a row's hover card) marks that one only, in the store, before the action
  runs: a failed action still saw it, a refused act (no such action, a closed one) did not.
- **Not seen**: an arrival toast showing or being closed, a row's hover card showing it.
- Seen is not a change to the notification: `UpdatedAt` stays (it orders closed ones and ages
  them out), and `See` publishes a `Changed` with no arrivals or updates, so nothing toasts.

## Decisions

- **A boolean, not a seen time.** `seen` with default 1 makes old rows seen with no data
  migration; a `seen_at` compared with `arrived_at` would have needed an UPDATE to do the same.
- **Not in the palette** (`NoPalette`): opening the bell does it, and there is nothing to choose.
  `NoIndex` like every `notification.*` verb, page class state, no keybinding.
- **The badge follows the snapshot's `unseen` count**, not each notification's flag. A daemon from
  before this sends neither, so its flags all read false; with the count at 0 the GUI shows the
  old look and never runs `notification.seen`.
- **The trigger is keyed on the unseen ids while open** (`useUnseenWhileOpen`): it runs on opening
  and again when a new id appears, also when the seen's answer and an arrival land in one render.
  A failed call does not loop (the key stays the same); it is quiet (no toast: the user pressed
  nothing, and an older daemon lacks the verb).
- **Act marks seen in the daemon**, not the GUI, so the CLI, a toast and a hover card all get it.
- **The badge is in the flow**, pulled over the bell's top-right corner with a negative margin and
  lifted, so two and three digits widen the button instead of covering the bell. The button ends
  the top bar, so it grows leftwards. 14px high (`h-3.5 min-w-3.5`), `text-caption-sm leading-none
  font-semibold`, `rounded-full`, `ring-2 ring-cf-chrome` (the top bar's background).
- **Tones**: accent fill (`bg-cf-accent text-cf-accent-foreground`) while unseen; the warning fill
  (`bg-cf-warning text-cf-warning-foreground`, the theme slot derived to read on the fill) while an
  UNSEEN one is time-sensitive. A seen time-sensitive one beside an unseen plain one is the accent
  badge. The bell icon takes the full text colour while the badge shows.
- `data-unseen` on the bell and `data-tone` on the badge are for tests; the count keeps the
  `notification-bell-count` test id in both looks, so tests reading the number work in either.

## Mock

`mock/notifications.ts` keeps seen as the daemon does. A quiet post or seed (no arrival: what was
there before the GUI connected) is seen unless `seen=0`; `post`, `seed` and `github` take
`seen=0|1`.

## Tests

- Go: `internal/store/notification/seen_test.go` (each arrival kind, in-place update, snooze, see
  all, see one, act marks only that one, a failed act, a refused act, a restart, a row without the
  column, the event and `UpdatedAt`), `internal/db/notification_seen_migration_test.go`,
  `internal/command/commands_notification_test.go` `TestNotificationSeen`.
- vitest: `NotificationBellSeen.test.tsx` (the looks, two and three digits, an old daemon, opening
  runs it, nothing unseen runs nothing, an arrival while open, two events in one render, shut
  arrivals, a failure), `lib/notifications.test.ts`, `api/notifications.test.ts`.
- e2e `notification-seen.spec.ts`: the badge on the bell's corner inside the bar, three digits
  widening the button, opening taking it off through the mock's stream. `SHOTS=<dir>` saves the
  PR's shots.

## Gotchas

- `make drive DAEMON=dev` with `DRIVE_HOME` under the session scratchpad fails: the daemon's socket
  path passes macOS's 103 bytes. Leave `DRIVE_HOME` unset (a short `/tmp` dir).
