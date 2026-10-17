# Thread fold, PR 1: the daemon closes a turn whose process ended

Status: done on branch `cf/thread-fold-1-daemon`. `make check` green; exercised end to
end with an isolated daemon, the CLI and haiku threads with no project (below). Go only:
the GUI already folds a turn at its `turn_end` (`gui/frontend/src/lib/threadTimeline.ts`).

## What was built

* **`internal/store/thread/turnclose.go`**. When a thread's process ends while a turn is
  open, the daemon appends a `turn_end` itself: `Subtype` `"process_ended"`
  (`SubtypeProcessEnded`, documented on `TurnEnd.Subtype` and `KindTurnEnd` in
  `items.go`), `Interrupted` true, no usage, `CostUSD` 0, `TurnCostUSD` nil (the GUI
  shows no cost, as for any turn whose cost is unknown), `Model` "". Its id is
  `turn-synth-<id of the turn's first item>`: unique (an item starts one turn) and stable
  (a second close of the same turn would rewrite the item, not add one). Written through
  the thread's `itemWriter`, so it is persisted and published like any item and the
  snapshot and `Seq` stay consistent.
* **Where it is written** (every place a turn can lose its process):
  * `maybeExited` (stream.go): every end of a live process that is not a daemon stop:
    close, archive, the idle stop, a crash, a handshake that failed. After
    `closeUnfinished` and, for a crash, after the "Claude stopped unexpectedly" error, so
    the error sits inside the closed turn (the GUI keeps errors visible in a folded turn).
  * `shutdown` (stream.go): a daemon stop with threads working.
  * `failStart` (lifecycle.go): a message to a stopped thread whose start failed; the
    message's turn never ran.
  * Loading the log of a thread with no runner (`Manager.thread`, `closeLostRun`): a run
    the daemon lost (it died with the process running). `New` loads every thread that was
    live at startup right away (the same rows `disconnectedStatus` turns from busy into
    error "interrupted"), so the turn is closed before anyone reads the items. Any other
    log is closed the first time it is read: threads stopped mid-turn before this change
    get their turn end then.
* **Duration**: from the turn's first item to the moment the process ended (now) in the
  live cases. For a lost run, to the latest `created_at`/`updated_at` of the turn's items
  as stored (measured before `closeUnfinished` restamps them): the daemon has no record
  of when it died, so a run that died during a long tool call undercounts (the live
  check below shows 1.6 s for a turn that ran about 8 s). 0 when the end is not after the
  start.
* **Which turn is open** (`openTurn`) follows the GUI's grouping: the top-level items
  after the last `turn_end` or `note` (a note closes what came before it in the GUI; a
  fork's copied history ends with its "Forked from" note), starting at the first one that
  is not an error. Nothing is written when there are none: no items, the last turn ended,
  a fork's copy, only errors after the last turn end (a failed handshake of a Reconnect),
  only a background agent's subagent items after it. The status (busy, compacting,
  pending) is not consulted: a busy thread with no item since its last turn end has
  nothing to fold.
* **Costs**: `newProjector` seeds the next process's cost check from the last turn end
  from a result and skips the daemon's (which carries no totals), so the next turn's
  `TurnCostUSD` is measured as before. Verified live: the turn after a synthetic one had
  its cost (`$0.0003`).
* **CLI**: `thread items` prints no "$0.0000 so far" for a turn end without a running
  cost.
* **Wording**: `thread.send`'s description now says "Send a message to a thread, also
  while it works: Claude picks it up mid-turn. A thread whose Claude is not running
  starts with it." Same for the Go comments on `Store.Send`, `Conn.Send` and the wake
  drain. The comments about the handshake queue (`queue`, `queued` in stream.go) are a
  real queue and stay.

## Decisions

* **Start of the turn**: the first item after the boundary, not the last user message:
  a message sent while Claude works is a steer inside the running turn (one result at
  the end, verified live by the caller), and a turn Claude starts itself (a wake after a
  background run) has no user message at all.
* **Deterministic id over `nextID`**: the lost-run path has no projector, and an id
  derived from the turn makes the write idempotent.
* **The failed start of a message is closed too**: it is a turn in the timeline (the
  message and its error); without a turn end the GUI would keep it unfinished until the
  next message.
* **Proto comment not changed**: `proto/codefoundry/v1/thread.proto`'s Send comment still
  says "queues it or folds it in". Changing it needs `make gen`, which rewrites the GUI's
  generated TS, and this PR does not touch `gui/`. Fix it with the GUI PR.

## Gotchas

* **Archive did not reproduce the missing result** on Claude Code 2.1.302 with haiku:
  three archives of a busy thread (mid-Bash, and right after a Bash finished) each got
  Claude's own result (`error_during_execution`, interrupted, terminal reason aborted)
  before the process exited, so no synthetic turn end was written there, as it should
  be. The synthetic one covers the archive or close whose process ends first (stdin
  closed before the interrupt is answered, the SIGTERM/SIGKILL after `CloseTimeout`).
* **A SIGKILLed daemon leaves Claude running** while it runs a tool: the orphan finished
  its `sleep 15` and exited later on its own (closed stdout). Not changed here.
* `thread close` is not a CLI verb any more; `thread archive --yes` is the close for a
  busy thread.
* The worktree sandbox refused CLI calls with a free-text prompt argument; small shell
  scripts outside the worktree ran them.

## Live check

Isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-synth-e2e`, `daemon --dev`), each thread
`thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --permission auto
--prompt 'Run the shell command `sleep 15` three separate times, one Bash call each, then
reply exactly: DONE. Do not read or write any files.'`.

Claude killed (SIGKILL) about 8 s in, then a follow-up message:

```
#1 you: Run the shell command `sleep 15` three separate times, one Bash call each, then reply exactly: DONE. Do not read or write any files.
#2 tool Bash [error] {"command":"sleep 15","description":"Sleep 15 seconds (first run)"}
    → Interrupted: the thread's process ended.
#3 error: Claude stopped unexpectedly (killed)
#4 turn end: process_ended, 9.9s, 0 in / 0 out tokens (interrupted)
#5 you: Do not run any tools. Reply exactly: OK
#6 claude: OK
#7 turn end: success, 1.1s, 22864 in / 4 out tokens, $0.0003, $0.0003 so far, claude-haiku-5-5
```

Daemon killed (SIGKILL) about 8 s in, then restarted (status error "interrupted",
disconnect "daemon restarted"; the turn end was there before the first read):

```
#1 you: Run the shell command `sleep 15` three separate times, ...
#2 tool Bash [error] {"command":"sleep 15","description":"Sleep 15 seconds (run 1 of 3)"}
    → Interrupted: the thread's process ended.
#3 turn end: process_ended, 1.6s, 0 in / 0 out tokens (interrupted)
```

Daemon stopped (SIGTERM) about 8 s in:

```
#1 you: Run the shell command `sleep 15` three separate times, ...
#2 tool Bash [error] {"command":"sleep 15","description":"Sleep for 15 seconds (first run)"}
    → Interrupted: the daemon stopped.
#3 turn end: process_ended, 10.1s, 0 in / 0 out tokens (interrupted)
```

Archived (`thread archive --yes`) mid-Bash: Claude's own result, no synthetic one:

```
#1 you: Run the shell command `sleep 15` three separate times, ...
#2 thinking
#3 tool Bash [error] {"command":"sleep 15","description":"Sleep for 15 seconds (run 1 of 3)"}
    → The user doesn't want to proceed with this tool use. The tool use was rejected ...
#4 turn end: error_during_execution, 9.6s, 22664 in / 190 out tokens, $0.0017, $0.0017 so far, claude-haiku-5-5 (interrupted)
```

## Tests

`turnclose_test.go`: `TestOpenTurn` (the grouping, no-op cases included),
`TestCloseOpenTurn` (payload, duration, persistence, once only, the cost seed skipping
it), `TestProcessEndClosesTheTurn` (exit, crash, kill, close, archive and daemon stop
while busy; exit, close and daemon stop at the prompt write nothing),
`TestRestartClosesTheLostTurn` (a live row with an open turn closed at startup and timed
to its last item; a stopped log closed on first read; ended turn, fork copy and no items
left alone). `TestSendSpawnFailure` and `TestRenderedSetEffortRespawnExecFails` now
expect the turn end after the start failure.
