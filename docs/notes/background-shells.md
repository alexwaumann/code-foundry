# Background shells, PR A of 3: track them, count them in the strip

Status: built on branch `cf/background-shells`. `make check` green, `make gui-build` green,
exercised live (isolated daemon, the CLI, the built app, Haiku 5.5). The next PR reads
`Session.background_shells_running` and `Session.BackgroundWork()` (below).

## Wire facts (Claude Code 2.1.300, from the captures)

Captured with a copy of the old stream probe (`/tmp/cf-stream-probe/probe.py`, extended with
timed actions after the turn, a stdin close and a SIGKILL), haiku at low effort,
`bypassPermissions`, in a scratch dir under `$HOME` (removed). Fixtures, trimmed like the
agents ones (no `stream_event` lines, init lists cut to two): `shells.jsonl` (Bash
`run_in_background` `sleep 15 && echo done`, ends after the turn), `shells-fail.jsonl`
(`exit 3`), `shells-stop.jsonl` (TaskStop in the same turn), `shells-monitor.jsonl` (Monitor
`until [ -f ready.txt ]`, the file made from outside), `shells-monitor-events.jsonl` (a
Monitor printing two lines), `shells-close.jsonl` (stdin closed while a shell runs).

* **The thread's own shells get the full task frames.** `task_started` with `task_type:
  local_bash`, `is_backgrounded: true`, no `owned_by_subagent`, no `parent_task_id`;
  `task_id` is the "b…" id, `tool_use_id` the Bash or Monitor call, `description` the call's
  description. No `command` field, and nothing tells Bash from Monitor: only the call does
  (its name and input, joined by tool use id; the assistant frame precedes `task_started`).
* **No `task_progress`** for shells.
* **The launch result** comes right after `task_started`: Bash `tool_use_result:
  {stdout: "", …, backgroundTaskId: "b…"}` with "Command running in background with ID: b…
  …You will be notified when it completes."; Monitor `tool_use_result: {taskId: "b…",
  timeoutMs, persistent}` with "Monitor started (task b…, expires in 30m …)". (TaskStop's
  result has `task_id`, an async Agent's `async_launched`.)
* **The end** is `task_updated` (`patch.status` completed, failed, killed; `end_time`) then
  `task_notification` (`status` completed, failed, stopped; `summary`: `Background command
  "X" completed (exit code 0)`, `… failed with exit code 3`, `Monitor "X" stream ended`, a
  stopped shell's description; `output_file`). On SIGTERM the notification comes first and
  `output_file` is empty.
* **New frame `system/background_tasks_changed`**: the whole list of running background
  tasks (`task_id`, `run_id`, `task_type`, `description`) after each change, `[]` once the
  last ended. Modelled (`claudestream.BackgroundTasks`) so the parse stays total; the
  daemon follows the task frames instead.
* **When a shell ends with the thread idle Claude starts a turn by itself** (init, a
  reply, a result), like a background agent's end. Each **Monitor event** (an output line)
  also starts a turn, with no task frame, while the monitor keeps running.
* **stdin closed with a shell running: claude does not exit** (same as agents). The probe's
  SIGTERM after 30 s made it report the shell stopped and exit 143.
* **SIGKILL, then `--resume`: nothing is reported** about the dead shell (the `sleep` died
  with claude too). Unlike agents, a resumed process does not say "didn't finish".
* **TaskStop**: `task_updated` killed, `task_notification` stopped with the description as
  summary, then the TaskStop result (`{message, task_id, task_type, command}`).

## What was built

* **`internal/claudestream`**: `TaskTypeShell = "local_bash"`, `BackgroundTasks` /
  `BackgroundTask` for the new frame, the `Task` comment says what a shell's frames carry.
  Parse tests on the six captures.
* **Session store** (`bgshells.go`, `bgshells_runner.go`; `shells.go` was taken by the
  terminal shells, so the names say "bg"): a `shellSet` on the runner (in memory only)
  keeps each running `BackgroundShell` (task id, tool use id, description, command,
  `Monitor`, started at). `onTask` hands a frame to it first; a shell's frames never reach
  the agents model, and anything that is not one of the thread's own shells (a subagent's)
  goes on as before (skipped). Ends on whichever terminal frame comes first; the
  notification, which carries the summary, completes the item.
* **Items.** The projector keeps a top-level Bash/Monitor call whose result names a task
  (`isShellLaunch`) running in `projector.async`, the same set as async Agent calls, and
  `agentEnded` completes it: done with the summary as output, or an error with the summary
  (a stopped shell: "stopped", via the agents' `failText`). A subagent's background Bash
  (`parent_tool_use_id` set) is not kept running. No note items.
* **Process end**: `endBgShells(why)` next to `endRuns` in the exit, daemon-stop and
  effort-respawn paths: the call becomes an error "<why> before the shell finished" (the
  agents' reasons: "the thread's process ended", "the daemon stopped", "Claude restarted"),
  the count drops to 0. `finish` also zeroes it.
* **Count**: `Session.BackgroundShellsRunning` (not persisted), set with `m.update(…, false)`
  when it changes, so EventService carries it with the session. Proto
  `Session.background_shells_running = 41`.
* **Effort restart**: `maybeRestart` also waits while a shell runs (the running item already
  blocked it; the count makes it explicit).
* **`Session.BackgroundWork()`**: a running background agent the thread launched itself
  (spawn depth 1) or a running shell. Foreground runs are part of a turn; a nested run
  keeps its background parent running.
* **CLI**: `thread.agents` header ends with " · N shell(s) in the background"
  (`FormatAgents(runs, shells, now)`; also on "no subagent runs in this thread"). It reads
  the session with SessionService.Get, so `RegisterAgents` takes a session backend.
  `session.list` unchanged.
* **GUI**: `SessionView.backgroundShellsRunning`; `lib/agents.ts` `shellsLabel` and
  `backgroundLabel(agents, shells)` ("2 agents and 1 shell running in the background", "1
  agent …", "2 shells …"). `AgentsStrip` shows while either count is above 0 (not archived):
  with agents today's layout with the joint sentence; shells only the sentence behind lucide
  `SquareTerminal`, no activity, no Agents button (`data-kind` agents | shells).
* **Mock**: `mock/shells.ts`; the `agents` state has one shell beside its agents, the new
  `shells` state a Bash and a Monitor running; `POST /__mock/thread/shell-end[?status=failed]`
  ends the oldest; the count is 0 for a disconnected session.

## Decisions and gotchas

* **Frames, not the list.** `background_tasks_changed` would also give a count, but the task
  frames carry the call, the status and the summary, and match how agents work.
* **The count is the Session's, not the item's.** The strip, the CLI and `BackgroundWork()`
  read the count; the running item is the timeline's view of the same shell.
* **Logged at the first terminal frame** ("background shell ended" with an empty output when
  `task_updated` came first); the item gets the summary a moment later from the notification.
* **Close**: the user closing a thread with a shell running makes claude report it stopped
  on the SIGTERM (if the frames are read before the exit), so its call says "stopped";
  otherwise the process-end reason. Both are errors.
* **`node_modules` in a worktree**: a symlink to the main checkout works for tsc, eslint,
  vitest and Playwright, but `make check`'s `frontend-deps` and `make gui-build` run `pnpm
  install`, which refuses it ("workspace hoist directory is not a real directory").
  `pnpm install --frozen-lockfile --offline` into a real directory takes a second (store
  hardlinks). `third_party/ghostty-vt` was copied from the main checkout with the `.pc`
  prefix rewritten (else cgo links another worktree's stale path from the build cache).

## Verification

* `make check` green: Go (gofmt, vet, staticcheck, `go test -race ./...`), typecheck, lint,
  vitest (138 files, 2791 tests). `make gui-build` green.
* Go tests: `claudestream/parse_test.go` (six captures: frames, the launch results, the
  order of end vs result, the lists); `session/bgshells_test.go`: every capture through the
  projector and the shell model (call, command, Monitor flag, running count at each turn
  end, final item status and output, no notes), the call running past its turn, subagent
  shells skipped (agents captures), `isShellLaunch` on captured results, `BackgroundWork`
  table; through the runner and the fake Claude: the lifecycle for Bash, a failure and a
  Monitor (count 1 → 0, `BackgroundWork`), TaskStop in the turn, orphaned by a process exit
  and a daemon stop, the effort restart held until the shell ends.
  `api/thread_agents_test.go` maps the count; `command/commands_agents_test.go` the header.
  The projector branch and the exit path's `endBgShells` were each disabled once: the tests
  failed.
* GUI: `lib/agents.test.ts` (the sentence), `AgentsStrip.test.tsx` (agents+shells, shells
  only, one shell, archived, the hand-over from agents to shells and away),
  `api/agents.test.ts` (mapping). `e2e/agents-panel.spec.ts` (both browsers): the strip
  "2 agents and 1 shell" → "1 agent and 1 shell" → shells-only "1 shell" → gone; the shells
  state (icon, no runs, no button, the calls running then done, 2 → 1 → gone). Screenshots:
  `SHOTS=<dir>` on "strip screenshots" (WebKit).
* Live (2026-10-15, Claude Code 2.1.300): isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-shells-home
  ./bin/code-foundry daemon --dev`), a no-project thread on Haiku 5.5, medium, auto:
  * background `sleep 20 && echo done`: `thread agents` "no subagent runs in this thread · 1
    shell in the background", 20 s later without it; the Bash item DONE `Background command
    "Run sleep 20 then echo done in background" completed (exit code 0)`;
  * Monitor `until [ -f ~/.cf-shells-scratch/live-ready ]`: the session's count 0 → 1
    (`monitor=true` in the log), 0 within 2 s of making the file; the item DONE `Monitor
    "Wait for live-ready" stream ended`; no notes;
  * the built app (`CODE_FOUNDRY_BIN`, `session focus`): a background `sleep 40` showed the
    strip "1 shell running in the background" with the terminal icon, gone once it ended.
* Not verified live: the effort-restart hold and the orphaning (fake Claude tests only), the
  agents+shells strip and light mode in the built app (mock screenshots).

## What the next PR reads

* `Session.background_shells_running` (proto 41, over EventService with the session; no
  Watch) and `background_agents_running`.
* In Go, `Session.BackgroundWork()`: true while the thread has work running after its turn
  (its own background agents or shells).
