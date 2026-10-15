# Snoozed threads, PR 1 of 2: daemon, command, API mapping

Update 2026-10-15 (`thread-lifecycle.md`): `session.reconnect` and `session.close` are gone; a
message starts a stopped thread (and unsnoozes it), the daemon stops idle ones, and
snooze also asks while background agents or shells run.

Status: built on branch `cf/snooze-daemon`. `make check` green; exercised end to end with
an isolated daemon, the CLI and a haiku thread (below). PR 2 (the GUI: sidebar section,
snooze menu, mock daemon) follows. Modelled on archive (`archive-threads-1-daemon.md`).

## Decisions (with Alex, not up for debate)

* Snoozing (a) ends Claude like `session.close` / archive (DISCONNECTED "closed"),
  (b) kills and removes the thread's bottom-panel shells, (c) unpins it, (d) stamps
  `snoozed_until` (unix ms, persisted, migration 0018). The GUI drops its side-panel tabs
  (PR 2; nothing on the daemon side).
* Confirmation only mid-turn (STARTING, CONNECTED + busy, or a pending permission /
  question), reusing archive's `ConfirmIf` / `DynamicConfirm` and `archiveInterrupts`.
  Unsnoozing never asks.
* Snooze and archive are exclusive: archiving clears the snooze, snoozing unarchives.
  Reconnect, Pin(true) and Send unsnooze (the spots that unarchive). A re-snooze replaces
  the time. The time must be in the future (InvalidArgument otherwise).
* The daemon wakes threads, on the wall clock: a check every 30 s and one at startup.
* Waking clears `snoozed_until`; the thread stays DISCONNECTED and becomes
  NEEDS_ATTENTION with status_reason **`snooze ended`**, `status_changed_at` = the wake,
  persisted and published. Unsnoozing early only clears the field (no attention).
* `session.snooze` (Thread category): `id` (context), `until` (string), `clear` (bool).
  `until` is parsed in the command layer; the API takes an absolute Timestamp.

## What was built

* **Proto.** `Session.snoozed_until` (38, unset = not snoozed) and
  `SessionService.Snooze(SnoozeSessionRequest{id, until})` returning the session; an unset
  `until` unsnoozes. `status_reason`'s comment lists `"snooze ended"`.
* **Store** (`internal/store/session/snooze.go`). `Session.SnoozedUntil`, migration
  `0018_session_snoozed.sql`, `Store.Snooze(ctx, id, until)`: validate (after
  `Options.Now`), Close, removeShells, then under `m.mu` refuse a thread a Reconnect won
  (FailedPrecondition, like Archive), set the time, unpin, unarchive, commit.
  `unsnoozeLocked` sits next to `unarchiveLocked` in Reconnect's update, Pin(true)'s
  commit and Archive(true); Send's post-accept `unarchive` became `backToList`, which
  does both. `ReasonSnoozeEnded = "snooze ended"`.
* **Wake.** `wakeSnoozed` walks the records under `m.mu`: every `SnoozedUntil` not after
  `Options.Now()` is cleared, and a disconnected thread gets NEEDS_ATTENTION "snooze
  ended" stamped with that now, committed (persisted + Updated on the bus) per thread.
  `New` calls it once after loading (snoozes that ran out while the daemon was stopped
  or the Mac asleep), then `wakeSnoozedLoop` every `Options.SnoozeCheckInterval`
  (default `SnoozeCheckInterval` = 30 s) under `m.wg` until Shutdown, like the
  attachment reaper. The clock is `Options.Now`, so tests drive it.
* **Fake** (`sessiontest.Fake.Snooze`): records `Snooze <id> <until UTC ms>` or
  `Snooze <id> -`, mirrors validation, close, unpin, unarchive; Pin(true), Reconnect, Send
  and Archive(true) clear `SnoozedUntil`. It never wakes anything: tests Put the woken
  state.
* **API.** Thin `Snooze` handler (a malformed Timestamp is InvalidArgument);
  `sessionToProto` maps `SnoozedUntil`.
* **Command** (`commands_session_snooze.go`, parser in `snooze_time.go`). Exactly one of
  `until` / `clear` (else InvalidArgs). Result `snoozed thread <label> until Thu Oct 15
  9:00 AM` (the year added when it is not this year) / `unsnoozed thread <label>`, JSON
  the session. CLI: `code-foundry session snooze --until 1h` / `--clear` / `--yes`.
* **Frontend mapping only.** `SessionView.snoozedUntilMs: number | null`,
  `snoozeSession(id, untilMs | null)` in `stores/sessionActions.ts` (sends
  `until: new Date(ms).toISOString()`, or `clear: "true"`), `SESSION_COMMANDS.snooze`.

## The `until` forms (`parseSnoozeUntil(s, now, loc)`)

Case-insensitive, trimmed; `loc` is the daemon's `time.Local` (same Mac as the GUI).

| Input | Means |
| --- | --- |
| `1h`, `3h`, `90m`, `1h30m` | now + a positive Go duration (absolute; `2d` is not accepted) |
| `tomorrow` | 9:00 AM tomorrow |
| `next-week` (`next week`) | 9:00 AM next Monday; a week ahead on a Monday |
| `mon`..`sun`, `monday`..`sunday` | 9:00 AM on the next such day, **never today** |
| `2026-10-20` | 9:00 AM that day |
| `2026-10-20 14:00`, `2026-10-20T14:00` | that local time |
| RFC 3339 (`2026-10-20T14:00:00Z`, `...000Z`, any offset) | that instant |

The result must be after now. Day forms are local wall times, so 9:00 AM stays 9:00 AM
across DST; a local time inside a spring-forward gap moves forward by the gap
(`wallTime`: Go's `time.Date` resolved 02:30 on 2026-03-08 in Chicago to 01:30 CST, an
hour early). Table-tested with America/Chicago (embedded tzdata) around both 2026
transitions.

## Choices made here (not in the brief)

* **A weekday name never means today**: `wed` on a Wednesday is next Wednesday, even at
  8 AM, consistent with `next-week` on a Monday. Use a duration or a date for today.
* **No `Nd` durations**: `tomorrow`, weekdays and dates cover days; the parse error lists
  every form.
* **Invalid `until` skips the confirmation**: `ConfirmIf` parses first and returns false
  on a bad or past time, so a busy thread with `--until soon` gets the parse error, not a
  confirmation followed by it. `clear` never fetches the thread.
* **The wake re-stamps an existing "snooze ended"**: a thread snoozed again without a
  reconnect already reads "snooze ended"; `setStatus` would not stamp an unchanged
  status, so the wake sets status, reason and time directly and the GUI's "ago" counts
  from the latest wake.
* **A live snoozed thread (only after a race) wakes without attention**: only cleared.
  Snooze commits on disconnected threads only and Reconnect unsnoozes, so this does not
  happen in practice.
* **`session.list` (CLI table) has no snooze column**, as for archive; `--json` has it.

## How "snooze ended" clears

It is exactly a disconnected thread's "finished": the persisted status of a
disconnected thread lasts until spawn's `setStatus(StatusUnknown, "")` (Reconnect) hands
it to the new process. Viewing a disconnected thread does not acknowledge (`acknowledge`
lives on the runner, which a disconnected thread does not have); Send needs a live
thread, so it only ever meets a reconnected one. Nothing extra was needed.

## Gotchas

* Go's monotonic clock stops while the Mac sleeps, so a timer for the snooze would fire
  late by the time slept. The 30 s ticker can also be late after sleep, but each tick
  compares wall times, so a wake happens at most one interval after the Mac wakes.
  `Snooze` strips the monotonic reading from `until` (`Round(0)`) so the comparison is
  always on the wall clock even if a caller passes `time.Now().Add(...)`.
* Like archive, Snooze waits for the close (up to `CloseTimeout`, 10 s, for a Claude that
  ignores the closed stdin). A snooze shorter than that is still accepted if it was in the
  future when asked; the next check wakes it.
* Snoozing during a permission prompt ends ERROR "interrupted", as closing does.
* **Run the CLI only with `CODE_FOUNDRY_HOME` set.** During this PR's e2e a stray
  `./bin/code-foundry session snooze --help` without it auto-started this branch's daemon
  on `~/.code-foundry`, which applied migration 0018 there (the installed app would then
  refuse the database as "newer"). It only polled gh for its 4 minutes; it was stopped
  and the migration reverted by hand (`ALTER TABLE sessions DROP COLUMN snoozed_until;
  DELETE FROM schema_migrations WHERE version = 18`; integrity check ok; a backup of the
  database before the revert is in `/tmp/cf-home-db-backup-before-revert.sqlite`).

## Tests

* Store (`snooze_test.go`): snooze table (connected, pinned, already disconnected,
  archived → closed / kept reason, unpinned, unarchived, shells of the thread removed and
  the worktree's kept, re-snooze replaces the time, persisted); past times refused and
  nothing changed; unknown id; unsnooze table (clear, reconnect, pin, archive, send; no
  attention; persisted); kept by unpin, unarchive, rename, close; the wake loop on a fake
  clock (not a minute early, then NEEDS_ATTENTION "snooze ended" at the clock's time on
  the bus, another thread's later snooze untouched, persisted, a second wake re-stamps,
  reconnect clears the attention); the startup check after a "sleep" of 26 h with no
  ticks.
* Command: `parseSnoozeUntil` (48 cases incl. DST and the gap), `formatSnoozeTime`,
  `session.snooze` (no confirmation idle / finished / disconnected; asks working,
  starting, permission, question, by id when unnamed; runs once confirmed; clear never
  asks; argument errors without asking or calling the backend; NotFound from Run).
* API: snooze mapping, unset unsnoozes, past and malformed times InvalidArgument, unknown
  NotFound. Frontend: mapping and `snoozeSession`'s args.

## End to end (2026-10-14)

Isolated daemon `CODE_FOUNDRY_HOME=/tmp/cf-snooze-daemon ./bin/code-foundry daemon --dev`,
scratch repo `~/cf-scratch-snooze`, `claude-haiku-5-5[1m]` at effort low
(`claude-4.5-haiku[1m]` answered "error: 404" here). All deleted afterwards.

```
$ code-foundry session.new --repo 603ab34534d9 --model 'claude-haiku-5-5[1m]' --effort low --name "snooze idle" --prompt "Reply with just the word ok."
$ code-foundry terminal.new --context-session s-6daca859bffa; code-foundry session.pin --id s-6daca859bffa --pinned=true
10:27:33 $ code-foundry session.snooze --id s-6daca859bffa --until 1m </dev/null
snoozed thread snooze idle (s-6daca859bffa) until Wed Oct 14 10:28 AM     # no confirmation: turn finished
{DISCONNECTED closed, NEEDS_ATTENTION finished, pinned: unset, snoozedUntil: 2026-10-14T15:28:33.723Z}
$ code-foundry terminal.list                                              # the shell is gone
# daemon log 10:28:51: snooze ended session=s-6daca859bffa late=17s
{DISCONNECTED, NEEDS_ATTENTION "snooze ended", statusChangedAt: 15:28:51.033Z, snoozedUntil: unset}

$ code-foundry session.reconnect --id s-6daca859bffa                     # CONNECTED, IDLE "at prompt"
$ code-foundry thread.send --id s-6daca859bffa --text 'Run ... for i in $(seq 1 40); do echo $i; sleep 1; done'
$ code-foundry session.snooze --id s-6daca859bffa --until tomorrow </dev/null
code-foundry session.snooze: Snooze thread snooze idle? Claude is still working; snoozing ends the turn.
Re-run with --yes to confirm.                                            # exit 2
$ code-foundry session.snooze --id s-6daca859bffa --until tomorrow --yes  # 0.26 s
snoozed thread snooze idle (s-6daca859bffa) until Thu Oct 15 9:00 AM     # {closed, ERROR interrupted}

$ code-foundry session.archive --id … --archived=true    # archivedAt set, snoozedUntil unset
$ code-foundry session.snooze --id … --until next-week   # until Mon Oct 19 9:00 AM; archivedAt unset
$ code-foundry session.snooze --id … --until "2026-10-20 14:00"   # replaced: Tue Oct 20 2:00 PM
$ code-foundry session.pin --id … --pinned=true          # pinned, snoozedUntil unset
$ code-foundry session.snooze --id … --until 2026-10-01
code-foundry session.snooze: invalid snooze time: Thu Oct 1 9:00 AM is in the past   # exit 2
$ code-foundry session.snooze --id …                     # "give until (...) or clear", exit 2
$ code-foundry session.snooze --id … --until fri; code-foundry session.snooze --id … --clear
unsnoozed thread snooze idle (s-6daca859bffa)            # status unchanged (no attention)
$ code-foundry session.snooze --id … --until 3h; code-foundry session.reconnect --id …   # STARTING, snoozedUntil unset

10:29:41 $ code-foundry session.snooze --id … --until 30s     # until 10:30:11
$ kill -TERM <daemon>; sleep 50; code-foundry daemon --dev
# log 10:30:35, before "daemon started": snooze ended until=10:30:11 late=24s
{DISCONNECTED, NEEDS_ATTENTION "snooze ended", statusChangedAt: 15:30:35.245Z, snoozedUntil: unset}
$ code-foundry session.snooze --id … --until 2026-10-14T23:00:00.000Z   # the GUI's format
snoozed thread snooze idle (s-6daca859bffa) until Wed Oct 14 6:00 PM
```

Not exercised live: snoozing at a permission prompt (the confirmation is the archive
path, covered by the command table test) and a real Mac sleep.

## For PR 2 (the GUI)

* Field `SessionView.snoozedUntilMs` (null = not snoozed). A woken thread has
  `snoozedUntilMs === null`, `status === "attention"`, `statusReason === "snooze ended"`
  and `statusChangedAtMs` = the wake (render "Snooze ended · 2m ago" in amber).
* Command `session.snooze` with `until` (any form above; the GUI sends RFC 3339) or
  `clear=true`; `snoozeSession(id, untilMs | null)` in `stores/sessionActions.ts` goes
  through runCommand, so the confirm dialog appears only when the daemon asks. Compute
  presets (later today, tomorrow 9 AM, next Monday 9 AM, …) in the GUI.
* Like archived threads in `attentionIds`, a snoozed thread that ended a turn keeps its
  "finished" attention on the daemon while snoozed; decide whether the bell skips
  snoozed threads (archive's choice).
* Clear the thread's side-panel tabs on a null → set transition of `snoozedUntilMs`
  (the archive cleanup subscription is the model).
* Mock daemon: `session.snooze` (confirmIf as archive), `snoozedUntil` on its sessions,
  and a way to wake one (status "snooze ended").

## Daemon restart

Yes: new RPC, command and migration 0018.
