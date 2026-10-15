# Update checks: hourly, wall-clock

2026-10-15. The in-app updater checked for a release 30 s after daemon start and then
every 24 h. With the tip channel publishing several releases a day, and most daemons
restarting less often than once a day, users mostly saw the startup check only.

## Decisions

- **Interval is 1 h on both channels.** One constant (`update.DefaultInterval`). A check is
  one `gh api` call (stable) or one paginated releases listing (tip) against the
  authenticated limit of 5 000/h, so hourly costs nothing worth a per-channel setting.
- **Interval measured on the wall clock, polled on a tick.** Go timers run on the
  monotonic clock, which stops while a Mac sleeps, so a 1 h timer set before a closed lid
  fires 1 h of awake time later, not 1 h of real time. The loop now keeps a 1 min ticker and
  runs a check when `Now().Round(0)` is at least `Interval` past the last check it ran. An
  overdue check runs within a minute of wake. No NSWorkspace sleep notifications needed.
- **Timing is per loop, not persisted.** The loop's own last-check time gates the tick;
  a manual check (the command) does not push the next scheduled one out, and a failed
  check still counts so the loop does not retry every minute on a bad network.
- **`Options.Tick`** exists for tests (default `min(1 min, Interval)`).

## Verification

- `TestCheckAfterSleep`: fake clock stands still across ~20 ticks (no re-check), then
  jumps 90 min and the next tick checks.
- `make check` green.
