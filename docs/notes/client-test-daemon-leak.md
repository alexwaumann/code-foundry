# Client test daemon leak

Five `client.test daemon --wait-lock 8s` processes sat idle for about 33 hours, orphaned,
each in a `/tmp/cf-<digits>` home.

## Cause

`TestConnectAutoStartsDaemon` and `TestConnectWaitsForShuttingDownDaemon` learn the
daemon's pid from `Ping`, so `stopProcess` is registered only after `Connect` succeeds.
Under load (`make check` runs next to other work) a start took over the 10s
`StartTimeout`. `Connect` failed, the test failed with no pid, and `shortHome`'s cleanup
deleted the home of a daemon still coming up. The daemon recreated the directory, finished
starting and served nobody.

The evidence is on the strays: each home's birth time is 10-12s after its process's start,
its inode is newer than the open `db.sqlite` and `daemon.lock`, and those two and
`daemon.log` are unlinked while still open. Two concurrent runs left 3 and 2.

A panic, `-timeout` or kill -9 of the test binary leaks the same way: no cleanup runs, and
`spawnDaemon`'s `Setsid` means nothing signals the child.

## Fix

Test code only. `spawnDaemon` detaching a daemon that outlives the client is the product,
and a client that gives up on a slow start leaves a daemon the next client uses.

- `CF_TEST_DAEMON` now carries the spawning test process's pid. The test daemon polls
  `getppid` against it (the value comes from the environment, so a parent that died before
  the daemon's first check still counts), cancels `daemon.Run` when it differs, and removes
  its home. A start or shutdown that hangs gets 10s, then the process exits anyway.
- A test daemon refuses any home but `/tmp/cf-*`, since it deletes the home.
- `TestMain` removes every `shortHome` again after `m.Run`, for a daemon that recreated its
  home and then exited by itself while the run continued. `/tmp/cf-53881103` has that
  shape (reborn, no lock, db or socket, no process); its cause is inferred, not reproduced.

## Limits

After a failed `Connect` the daemon lives until the test binary exits, not until the test
ends. A home used only by an in-process daemon stays behind if the binary is killed, since
no process is left to remove it; that leaves a directory, not a process.

## Checks

With the watcher disabled, `TestSpawnedDaemonGoesWithTheTestRun` fails both cases
("outlived its test run"). With it, repeated package runs, `-test.timeout` panics during
the lock wait, and kill -9 of a compiled test binary mid-run left no process and no home.
