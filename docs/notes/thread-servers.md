# Thread info card 5/5: servers from background shells

Status: done on branch `cf/thread-servers` (one PR: daemon, proto, command, card). The last
of the five thread info card PRs (2/5: `docs/notes/thread-info-card.md`). A thread's own
background shell (Bash `run_in_background`, Monitor) that listens on a TCP port becomes a
server row in the card's Shells group: `localhost:<port>`, its command, runtime and uptime;
a click opens the port in the browser, a stop square stops the shell.

## Daemon

### Which process a shell is (`internal/store/thread/servers.go`)

The task frames carry no pid. Claude Code runs each background task as a direct child of
its process, leading a process group of its own, with standard output on the task's output
file: `/private/tmp/claude-<uid>/<cwd slug>/<session>/tasks/<task id>.output` (what the
`task_notification`'s `output_file` names). So a new shell is found by that file:

* `procscan.Children(claudePID)` (sysctl `kern.proc.uid`, pure Go), keeping only the
  children that lead their group (an MCP server or a hook is no task);
* one `lsof -w -a -d 1 -Fpn -p <children>` for their standard outputs (`procscan.Stdouts`);
* `taskOfOutput` takes the task id from a `…/tasks/<id>.output` path.

That runs at once on `task_started`, then again 1 s and 3 s later while the child is not
there yet, one call per Claude process however many shells are due. The group goes on the
Thread's `BackgroundShell.PGID` (with `ClaudePID`, both daemon-only). The runner's pid is
read at `task_started`, so an effort restart's new process maps its own shells.

### Ports (`internal/procscan/listen.go`)

`ListeningIn(ctx, pgids)` is one `lsof -w -nP -iTCP -sTCP:LISTEN -a -g <pgid,…> -Fpgtn` for
every running shell of every thread, parsed by `parseListen` (table-tested: families, a
forked worker repeating its parent's socket, names without a port). `Ports` keeps the
distinct ports in order: `*:p`, `127.0.0.1:p` and `[::1]:p` are all `localhost:p`. lsof's
exit 1 is "nothing matched" (or a process went away), never a failure.

### The watch

`serverWatch` is one goroutine for the daemon. It reconciles the running shells from the
snapshot whenever the runner publishes a change (`publishBgShells`, `detach`), so it needs
no started/ended plumbing. Cadence: nothing while no shell runs; a burst at +1 s, +3 s and
+10 s after any shell starts; then every 10 s from the last probe. A shell's end drops it at
once (the runner publishes the list without it, ports and all). Only changed ports are
published. lsof missing or failing (anything but exit 1) logs one warning and turns the
watch off until the daemon restarts; the stop still tries a mapping of its own.

### Publish

`Thread.background_shells` (`BackgroundShell` { task_id, description, command, started_at,
ports }), oldest first; `background_shells_running` stays as it is. Not persisted: shells
die with the process. The runner publishes the whole list on every start or end
(`shellSet.list`), carrying the group and ports the watch found from the list before.
`thread get` prints a line per shell: `background shell <task>: <command> (localhost:<port>, …)`.

### Stop

`ThreadService.StopShell` / `thread.shell.stop <task> [--id]` (NoPalette, NoKeybinding):
the shell's group (mapped then if not yet) gets SIGTERM, then SIGKILL after
`ShellStopGrace` (3 s), in the background (`procscan.StopGroups`, which never signals group
≤ 1 or the daemon's own). A note "Stopped background shell: <command>" goes into the
timeline first; Claude then reports the shell killed like any end. NOT_FOUND for an unknown
task, FAILED_PRECONDITION when its process cannot be found. Not in the guide (it is near its
byte cap): `leftOut` lists it.

## Card (`components/threadinfo/ShellsGroup.tsx`)

* The group reads `ThreadView.backgroundShells` (one narrow selector over JSON-encoded
  shells), no longer the item log.
* A shell with a port is a tall row above the fold: globe icon, `localhost:<first port>` in
  `text-code`, then a muted line `command · runtime · uptime` where only the command
  truncates. `shellRuntime`: node (node, npm, npx, pnpm, yarn), python (python, python3,
  python3.12) or go from the first word after any `VAR=value`; else none. Several ports:
  a muted `+N` in the value column and every address in the hover card (with the
  description and the whole command).
* A click runs `view.open.url` with `http://localhost:<port>` (`openUrl`). The stop square
  (error colour) is the row's sibling laid over the value column, as in the lineage group:
  hover or keyboard focus shows it, Enter stops without opening. It runs
  `thread.shell.stop` (`stopShell` in `stores/threadActions.ts`).
* Shells without a port stay in the "N shells · running" fold, "N more shells" below server
  rows.
* `sameThread` compares the shells by value (each Updated event carries new objects).

## Mock and tests

* `POST /__mock/thread-info?scenario=servers`: s-ti-srv with the "servers" state (mock/shells.ts
  `scriptServers`): `pnpm --dir web dev` on 5173 and 24678, `python3 -m http.server 9399`,
  and the "shells" state's two shells. The mock's `thread.shell.stop` adds the note and ends
  the shell.
* Go: `parseListen`, `Ports`, a live `ListeningIn`/`Children`/`Stdouts` over a python
  listener; `taskOfOutput`; the watch's schedule on a fake clock (map retries, burst,
  cadence, one call for all groups, only changes published, give-up after the last retry);
  lsof failing turns it off; through the fake Claude stream: group and ports on the Thread,
  stop ends a real process group and writes the note, the end drops the shell; the API
  mapper; the command and `thread get` lines.
* GUI: `shellRuntime`, `shellCount(n, more)`; e2e `servers`: two rows, line 2, `+1` and the
  hover, "2 more shells", click opens `http://localhost:9399`, stop by click and by Enter.

## Measured

On the live run below: one probe call (`lsof … -g <pgid>`) takes
about 30 ms wall, 20 ms CPU (10 user + 10 sys), 1.5 MB peak RSS and ~200 M instructions;
the mapping call (`lsof -d 1 -p <children>`) is about the same. With shells running that is
three probes in the first 10 s, then one every 10 s: roughly 0.2% of one core, and nothing
at all while no shell runs. The port showed 1.03 s after `task_started` (the burst's first
probe).

## Verified

* `make check` green.
* End to end on a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-srv`, scratch repo
  `~/cf-srv-scratch`), Sonnet 5.5 medium told to run `python3 -m http.server 9399` in the
  background: `thread get` showed `background shell bzee8qzwx: python3 -m http.server 9399
  (localhost:9399)` 1 s after the shell started; the process was zsh (pid = pgid, child of
  claude) with python in its group listening on `*:9399` (IPv6, dual stack).
  `thread shell stop bzee8qzwx` closed the port within 250 ms, the note landed, the shell
  left `thread get`.
* The built app on the isolated home: a server row and "1 more shell", dark and light
  (shots in the PR body). The card toggle was put back afterwards (shared WebKit storage).

## Gotchas

* lsof exits 1 both for "no match" and for a pid that went away; only other failures count.
* The task's process is the zsh Claude wraps the command in; the server is its child in the
  same group, which is why the probe selects by group (`-g`), not pid.
* Claude does not see daemon notes: after a stop it reads the shell's exit (code 144 for
  zsh under SIGTERM) and may say its server died. Follow-up below.

## Follow-ups

* Tell Claude a stop was the user's (the resume note path, as for interrupts) so it does not
  report the stopped server as a crash.
* Shells a subagent started (owned_by_subagent) are not listed, so their servers are not
  either.
