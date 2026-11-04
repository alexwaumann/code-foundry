# Servers roll up to the parent thread 1/2: action run ports

Status: done on branch `cf/action-run-ports`. PR 1 of 2: this one only makes the data exist;
PR 2 shows it in the thread info card. A dev server a project's Action started was invisible:
`serverWatch` (`docs/notes/thread-servers.md`) only looks at Claude's background shells. Now
a running run says which TCP ports its processes listen on.

## Daemon

### Data

`action.Run.Ports` and `ActionRun.ports = 17` (`repeated uint32`, like
`BackgroundShell.ports`), ascending, while the run runs. In memory like the run itself; the
run records do not carry them. `RunUpdated` now also means "its ports changed"; the API, the
only consumer, forwards it and the GUI's reducer replaces the run by id. Nothing treats a
`RunUpdated` as a start, so no toast or panel reacts.

`Run.ThreadID` and `Run.TerminalID` were already on the run and on every event, for both
modes: PR 2 needs nothing else to link a server to its owner and terminal.

### Which processes a run is (`procscan.ListeningUnder`, `treeGroups`)

A run's root is `runRec.pid`: the child for a background run, now also the terminal's pid for
a terminal run (`Terminal.Pid`, taken from `Create`, so no lookup per probe). Both lead their
group (`Setpgid`, `Setsid`).

The group alone was not enough. Measured with real listeners under `/bin/zsh -lc`:

| Command | Listener's parent | Its group | `lsof -g <root>` | `treeGroups` |
| --- | --- | --- | --- | --- |
| `python3 -m http.server` | the root (zsh execs it) | the root's | found | found |
| node forking a listener | node | the root's | found | found |
| real Vite | node | the root's | found | found |
| `(server &); sleep` | launchd | the root's | found | found |
| node `spawn(detached: true)` | node | its own | **missed** | found |
| double fork and `setsid` | launchd | its own | **missed** | **missed** |

So `treeGroups` walks the process table (the sysctl `procscan.List` already reads, pure Go,
no extra process): the root's group, every descendant of a member, the whole group of each
such descendant, until nothing new turns up. Then one `lsof -g` over all the groups of all
the runs. Groups at or below 1 and the daemon's own are never followed.

### What is missed, plainly

* **A real daemon**: a double fork and `setsid` leaves no parent, group or session tie to the
  run. The only ties left are heuristics (its working directory), which would pin another
  thread's or run's server on this run, so it is not found. `StopRun` does not reach it
  either.
* **A server that outlives its run**: ports clear when the run ends, so `server &` as the
  whole command shows nothing, because the run ends at once and the server carries on.
* **A subagent's or a user's own shell**: not a run.
* A port shows up to 10 s late (see the schedule), and closes in the list up to 10 s late.

### Stop does not reach everything the probe sees

`StopRun` signals the run's group (a terminal run: the shell's group and the foreground job).
A `detached: true` child is listed by the walk but survives a stop: the live check below left
it listening, its run EXITED and its port gone from the list. Unchanged here (it is how stop
always worked), but PR 2 must not promise that the stop square closes the port.

### The watch (`internal/store/action/ports.go`)

`portWatch` is one goroutine per store, started in `New`, stopped by `Close`. Same schedule
as `serverWatch`: nothing while no run runs; +1 s, +3 s, +10 s after any run starts; then every
10 s. One sysctl and one lsof for every running run. Same failure rule: lsof missing or 3
failures in a row turn it off until the daemon restarts, logged once; a failure skips the
tick and keeps the ports.

Own goroutine, not `serverWatch`'s loop: the two stores do not import each other, the shell
watch's mapping retries have no counterpart here, and sharing would mean a new package and a
rewrite of a tested loop to save about 40 lines. When both run, that is two lsof calls per
10 s. Three deliberate differences from `serverWatch`:

* The next probe counts from the end of the last one, and burst probes it outlasted are
  dropped, so a slow lsof never runs back to back.
* A burst probe within `portGap` (1 s) of the last is dropped: many runs starting together
  cost about a probe a second, not three each.
* When the watch turns off it clears the ports: nothing would ever correct them.

Ports are sorted because lsof's order follows the processes', which is no reason to publish;
it also puts Vite's 5173 before its HMR 24678.

### Publish

No lock is held during a probe. `Manager.setPorts` takes `m.mu`, refuses a run that is
forgotten or no longer running, compares, and only then rebuilds and publishes. `finish`
clears the ports under the same lock, so its own `RunUpdated` carries none: a run that exits
between probe and publish gets no stale ports and no extra event.

Daemon restart: nothing to do. A clean stop kills the runs and the new daemon has none; after
a SIGKILL a background run's server lives on, unknown to the new daemon, as before.

## CLI

`action runs` has a PORTS column (`localhost:5173, localhost:24678`), empty when there are
none. `--json` carries `ports`.

## GUI

`ActionRunView.ports` is mapped in `src/api/actions.ts`; nothing renders it yet.

## Mock (for PR 2)

* `POST /__mock/action/ports?run=r-…&ports=5173,24678` (or `terminal=t-…`): a running run
  listens on these now; empty closes them. Only a change is published. `GET /__mock/actions`
  and the controls' answers carry `ports`. A run's end clears them.
* `pnpm dev` (action Dev) listens on 5173 1.1 s after it starts, unless ports were set first.
* `POST /__mock/thread-info?scenario=child-server` returns the parent `s-ti-1`, which runs
  Debug daemon in the background on 7788; its child `s-ti-kid-srv` runs Dev in a terminal on
  5173 and 24678 and has the `servers` state's shells. A second call starts nothing.

## Tests

* `treeGroups` (table: detached child, job-control shell, orphaned members, double fork, two
  trees, launchd's and the daemon's groups, a ppid cycle), a live `ListeningUnder` over a
  listener in a session of its own.
* The watch on a fake clock: schedule, sorting, a slow probe, 40 runs starting, the failure
  rule.
* Through the Manager, background and terminal: no port, a port, unchanged (nothing
  published), several, one closing while the run goes on, the end, the probe stopping; a run
  exiting during a probe; a forgotten run; a restart; `Close` during a probe; a live run with
  the real probe.
* The API mapper, `action runs`, the view mapping, the mock's ports.

## Verified live

Scratch `daemon --dev` on `CODE_FOUNDRY_HOME=/tmp/cf-arp/home`, scratch repo, `/bin/zsh`:

* Each row of the table above as a real Action, in a terminal and in the background: every
  one but the double fork showed its port 1.1 to 1.2 s after the start, in both modes. The
  double fork stayed empty for 14 s while lsof showed it listening.
* After a stop every run was EXITED with no ports. Still listening afterwards: the detached
  child and the double fork, in both modes (see above).
* Two ports on a run, one closed at +5 s, the other at +19 s: the list went `[19601, 19602]`
  at +1.0 s, `[19601]` at +10.1 s, empty at +20.3 s with the run still running. The event
  stream had 5 `run_updated` for it (start, three changes, end) and 2 for a quiet `sleep`.
* A terminal run owned by a thread: `threadId`, `terminalId`, `ports` all on the run.
* `python3 -m http.server … &` as the whole command in the background: the run was `exited 0`
  with no ports while lsof showed the server listening.
* A clean daemon stop closed the ports of both modes; the restarted daemon listed no runs and
  made no probe. After a SIGKILL of the daemon a background server stayed up.

## Measured

40 background runs, each with a listener: all 40 ports at +1.1 s, a whole probe (sysctl and
lsof) 45 to 65 ms, 5 probes in the first 15 s. With 1 or 2 runs a probe takes about 40 ms;
lsof itself is about 30 ms and 200 M instructions either way.

## Gotchas

* Go tests outside `make` need its `PKG_CONFIG_PATH` (libghostty, whisper).
* Fake terminals have pids from 10001, which can be real processes: the action tests default
  to a fake probe.
