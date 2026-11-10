# Daemon fixes: stores own the open, reports and waits read the store's facts

Five daemon changes, each re-checked against the code before it was made.

## workspace.open.editor runs through the gitops store

`workspace.open.editor` ran `open -b` itself from `internal/command` (`OpenWithApp`),
so the command package owned a process. The gitops store already had the op:
`OpenEditor` with `App` set resolves any existing absolute directory (`resolve` looks the
project up but does not need one), checks the app against the detected editors, and runs
`<Open> -b <bundle> <dir>` as a tracked `open-editor` op with the injectable open
binary. So the command now calls `GitOpsService.OpenEditor` with the workspace's folder
and the app, through the backend it already had for `ListEditorApps`; `OpenWithApp`,
`OpenWithFunc` and `WorkspaceOpenDeps.Open` are gone. The message and JSON are the same
("opened <dir> in <app>", `{path, app}`); a failed op is the error `gitOpResult` makes
for every gitops command. The old comment said worktree.open.editor opens registered
worktrees only: the store never required that, so the comment now says what differs (a
workspace argument rather than a path).

Gotcha: the op's title uses the folder's base name, which for a synthetic workspace is
its id (`w-1`), not its name. The result message keeps the full path, as before.

## The latest turn's start is on the thread row

`thread.reports` called `Get(with_detail)` per reported thread to compute one bool,
which loaded each thread's whole item log from SQLite and left it cached in daemon
memory. The rule it needed is the wake's (`wakeDetailOf`): the report is stale when it
was made before the latest turn started, at millisecond precision, where a turn starts
at the first top-level user message Claude read after the turn before it ended
(`lastTurn`: queued messages do not count, a message read mid-turn is no new turn,
subagents' items are skipped, a placed message counts where it was placed).

- `Thread.TurnStartedAt`, persisted in `threads.turn_started_at` (unix ms, 0 for none;
  migration 0059), proto `Thread.turn_started_at` (78).
- The log keeps it: `threadLog.turnStarted()` runs `lastTurn` over the items, cached
  until a top-level user message or turn end is written, updated, consumed or dropped
  (`noteHandledLocked` and `dropItem` mark it dirty). So it is the wake's rule by
  construction, including placement after a reorder.
- The runner publishes it with the status, as it does `HandledThrough`: `readStatus`
  reads it, a change schedules the debounced publish, and a change saves the row even
  when the status stayed the same. `finish` sets it from the log when the process ends.
  Every user-message and turn-end write in a running thread goes through the runner,
  which calls `checkStatus` after it; outside a runner only queued messages are written
  (no start) and `closeLostRun` adds a turn end (no start either).
- `Thread.ReportStale()` (turn.go) is the one rule; `wakeDetailOf` uses the same
  `reportOlder`. The API sets `report_stale` on every thread it maps (list, get,
  updates), so `thread.reports` reads it from the list and makes no `Get` calls.
  `Detail.ReportStale` is gone; `with_detail` now only fills `pending`.
- Lag: the turn start reaches the row with the debounced status publish (100 ms), the
  same moment a wake could fire on it.

### The migration and its backfill

0059 adds the column and fills it from `thread_items` in SQL, by `lastTurn`'s rule:
top-level rows only, user messages whose data has no `"queued": true`, and turn ends,
ordered as the log orders them (`placed_after` when set, else the ordinal; a placed
message after the item at its key; then the ordinal). A user message starts a turn when
the row before it in that order is a turn end or there is none (window `LAG`); the
latest such message per thread is its start. Threads without one keep 0. The table
test (`internal/db/thread_turn_started_migration_test.go`) covers ended and running
turns, a steer, a still-queued message, placement before and after a turn end,
subagent prompts and a turn end before any message.

Checked on a real-shaped database: a scratch `CODE_FOUNDRY_HOME` (a short `/tmp`
path: the scratchpad's is too long for the daemon's socket) run first by the old binary
(origin/main) with real Claude threads (see "End to end" below), then started by the new
binary, which ran the migration (schema 58 to 59). A throwaway test (not committed) read
a `.backup` of that database (a plain copy misses the WAL, where the migration still
was) and compared, for every thread, the backfilled `turn_started_at` with
`newThreadLog(...).turnStarted()` over its loaded items: both matched, the two-turn
thread at its follow-up, the steered thread at its first message.

## thread.wait's "It said" is the wake's last message

The command re-implemented the wake's last message from a full `ListItems` (every item
converted to proto on every settled wait) and disagreed with it: no 16 Ki-rune cut,
it stopped at a queued user message, and it showed for any status but busy.
`thread.LastSaid` (detail.go) is now the wake's rule (`lastTurn`'s text, `cutMessage`,
only when `Meets(CondIdle)`), which `wakeDetailOf` uses too. `ThreadService.Wait`
reads the items once, only when the thread is idle by that rule, and returns it as
`WaitThreadResponse.last_message` (5); the command prints that and no longer lists the
items for it. `pendingLines` still lists them at a permission or question (an old
daemon gives no `last_message`: the CLI then prints no "It said", which is harmless).
Command tests now cover a finished turn, a queued message after it, the cut, a
subagent's text and a question (the cut and queued cases fail on the old command).

## threads.scrollback_lines is appearance.scrollback_lines

Only the bottom panel's shells read it (the terminal store's `MaxScrollbackLines`), and
the page already showed it under Appearance › Terminal beside `appearance.font_family`
and `appearance.font_size`. The key, the field (`Appearance.ScrollbackLines`) and the
group moved; `movedKeys` maps the old key, so a settings.toml with
`[threads] scrollback_lines = N` keeps N and the next save writes it under
`[appearance]` only (the new key wins when both are set). The `Threads` doc comment now
says what the group holds. The mock schema, the GUI's settings key map and the tests
use the new key.

During an update (new GUI, old daemon until restart) the GUI asks for
`appearance.scrollback_lines`, which the old daemon does not have, so xterm uses the
default 30,000 rows until the restart. Nothing is lost: the file keeps the value.

## Workspaces refresh on events connect

The GUI reads workspaces from `EventService`, whose workspace snapshot did not re-read
the folders, so hand edits to a workspace's instructions and skills showed only after
a thread event. `workspaceSource` now calls `EnsureDirs(ctx, "")` before its snapshot
and on a resume (an `eventResumer`, since a resumed stream gets no snapshot; a change
then goes out as a live event). It also runs on a resync after drops, which is rare.
The `EVENT_SOURCE_WORKSPACE` comment says so.

## End to end

Scratch dev daemon and CLI, Sonnet 5.5 at medium effort, no-project threads:

- Old binary: "two turns" (pong, a `thread report done`, then a follow-up, ping) and
  "steered" (a 20 s `sleep` in Bash, a `thread report progress` during it, then a
  message sent mid-turn, which Claude read after the tool call). The old `thread
  reports` showed `done*` for the first and a current `progress` for the second.
- New binary on the same home: the migration ran, and `thread reports` (text and
  `--json` `stale`) said the same, now from the list alone.
- `thread send --wait` on "steered" with the new daemon printed `It said … > again.`
  from `last_message`; `thread reports` then showed `progress*`, `thread get --json`
  had the new `turnStartedAt` and `reportStale`, and the row's `turn_started_at` was
  the new message's `created_at` (the runner saved it). No warnings in the daemon log.

## Verification

- `make check` green on the final tree; `make gui-e2e` green.
- A loaded machine (load average near 30) once timed out three `internal/client` tests
  that start a daemon within 5 to 10 s; they pass alone.
