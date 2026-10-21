# Daemon lifecycle fixes from the 2026-10-21 fuzz pass

Fixes for the API report's findings 1, 2 and 7 and the config report's finding 2 (the
same root as API 2).

## Event hub: stale events after a bus drop (API 1)

When the hub's bus subscription for a source overflowed, `busTap.run` emitted the resync
marker and then still numbered and published the events left in the subscription
buffer. Those are all older than the dropped ones. A stream that resynced before they
were numbered got seqs above `covered` for them, applied them on top of the newer
snapshot, and stayed on stale values (n257 of n400). The resume log restarted with them
too.

- State topics drain the subscription buffer before they emit the marker. The snapshot
  the marker triggers is newer than everything drained, and drops that happen while
  draining are covered by the same snapshot (`dropped` is read again after the drain).
- Transient topics (intents) have no snapshot, so they keep their buffered events. They
  now also emit the marker followed by the event in hand. Before, that event was lost.
- The plugin event feeds and `events --since` go through the same hub, so this fixes
  them too. `WatchThread` was never affected because it filters by the store's own seq.
- `TestEventsDropDoesNotReplayStaleEvents` holds `hub.mu` to stall the tap, does 400
  Puts of one thread, and checks that the client ends on the last one. It runs 15
  rounds. Without the fix it fails on round 0.

## Auto-start (API 2, config 2)

- `spawnDaemon` returns the child's exit, and `Connect` selects on it. When the child
  exits before it answers, `Connect` first pings once more, because the child may have
  lost a start race to a peer that answers now. If nothing answers, it fails at once
  with `ErrDaemonExited`. The error says why:
  - Exit status 3 (`client.ExitLockHeld`, set by `code-foundry daemon` on
    `ErrAlreadyRunning`) gives "a daemon (pid N, from daemon.lock) holds the lock but
    does not answer; if it is hung, run `kill N`".
  - Otherwise the reason is the last error in the daemon.log lines written since the
    spawn. That is either the CLI's own `code-foundry: ...` stderr line (the auto-start
    redirect appends it to the same file) or a JSON line at level ERROR (its `err`,
    else its `msg`). If the log is shorter than the offset recorded before the spawn,
    the new daemon rotated it, so it is read from the start.
- I chose this over a separate `daemon.err` file. The log already has the line, and an
  offset per spawn keeps concurrent clients from reading each other's failures.
- `--wait-lock <d>` (passed by `spawnDaemon`, d = StartTimeout - 2s, at least half of
  it): while daemon.lock is busy and nothing accepts on daemon.sock, the daemon retries
  every 50 ms. Once it has the lock it logs "the previous daemon was still shutting
  down; waited for its lock". If the socket accepts, the holder is serving (a peer won
  the race), or it is hung but its backlog still takes connections (SIGSTOP). In both
  cases the daemon fails at once as before. That is why a stopped daemon is reported
  in about 3 s rather than after the lock wait. A manual `code-foundry daemon` does not
  wait.
- The shutdown window: the listeners close (and Go unlinks the socket) before the
  stores close, and the lock is released last. No reordering was needed, since a
  waiting daemon covers the window.
- "daemon stopped" is now logged from a defer that runs after the stores and plugins
  close, with `shutdown` (how long closing took). A "listeners closed, closing stores"
  line marks the start of that phase. Any error that ends `Run` after the log opened
  is logged as "daemon cannot start" from the same defer, not only store errors.
- GUI host: after a start failure (`ErrDaemonExited`) it does not spawn again for 5 s
  and returns the same error meanwhile. Without this, the health poll and the relaunch
  watcher would start a doomed daemon every second or two. Within the backoff it still
  uses a daemon someone else started. The Wails binding passes `err.Error()` through as
  the RuntimeError message, which the sidebar's daemon status tooltip already shows, so
  the frontend needed no change.

Checked end to end with a scratch home:

| Case | Before | After |
| --- | --- | --- |
| python holding flock for 3 s, no socket | timeout | comes up after the lock frees (2.9 s) |
| `kill -STOP` daemon | 10 s timeout | about 3 s, with "pid N ... does not answer; `kill N`" |
| future `schema_migrations` row | 10 s timeout | 50 ms, with the newer-schema message |
| `daemon.restart` with a HUP-ignoring terminal and 30 status calls 100 ms apart | calls in the window failed and no daemon stayed up | all 30 succeeded on the new daemon once the old one finished its 3 s grace |

In the restart case, the losing children log "another daemon is already running": a
peer won.

## daemon.log rotation (API 7)

- A new package, `internal/logfile`, is a log file with a size cap and one `.1`
  rotation. The plugin logs now use it (it replaces `logBuffer.write`'s own rotation),
  and so does daemon.log (10 MiB, checked at open and on every write, under its own
  mutex).
- The auto-start redirect still appends the child's stdout and stderr to daemon.log.
  When the daemon starts with stderr on that same file (`os.SameFile`, checked before
  the rotation at open), each rotation `dup2`s the new file onto fds 1 and 2. A panic
  or the CLI's final error line then lands in the live file, not in `.1` or an unlinked
  inode. The rotation at open is the case that matters: `Connect` reads the reason from
  the live file.
