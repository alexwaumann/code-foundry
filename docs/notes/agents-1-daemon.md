# Agents, PR 1 of 2: the daemon

Status: built on branch `t3code/agents-panel-1-daemon` (design and decisions:
`docs/sketches/agents-panel/DESIGN.md`, kept out of the repo; PR 2 is the GUI: the
Agents panel tab, the strip above the composer, the sidebar's "N agents"). `make check`
green; exercised live with an isolated daemon, the CLI and haiku (below).

## What was built

* **`internal/claudestream`**: `Task` models the task frames fully (run id, task type,
  background, spawn depth, parent task, prompt, last tool, `usage`, task_updated's
  `patch`, the handed-back report; `Report()`). Fixtures from Claude Code 2.1.299:
  `agents.jsonl` (a background run, a nested foreground pair, the background run woken by
  SendMessage), `agents-stop.jsonl` (TaskStop), `agents-resume.jsonl` (a resumed process
  reporting the run its predecessor left).
* **Session store**: one record per run. `AgentRun` (usage_runs.go) gains its lifecycle:
  `ParentID`, `Status` (running, done, failed), `Activity`, `LastTool`, `TotalTokens`,
  `ToolUses`, `DurationMS`, `Summary`, `Error`, `ResumedAt`, `EndedAt`, `NoteItemID`,
  persisted in `session_agent_runs` (migration 0019; older rows: open ones failed "the
  daemon restarted before the agent finished", closed ones done). `agents.go` applies the
  frames to the same `runUsage` the transcript folds use, on the runner goroutine;
  `agents_runner.go` is the runner glue (items, notes, publication, orphaning, the rescan
  merge); `agents_db.go` the persistence helpers. `ItemsSnapshot.Agents` and the
  `AgentsChanged` thread event carry the list; `Session.AgentsRunning()` counts.
* **Proto**: `ThreadAgentRun` + `ThreadAgentStatus` (thread.proto),
  `ThreadItemsSnapshot.agents = 7`, `ThreadEvent.agents = 10` (`ThreadAgentsChange`,
  Watch only, the whole list), `Session.agents_running = 39`,
  `Session.background_agents_running = 40`. `AgentRun` (session.proto) is unchanged
  except that OPEN/CLOSED now mean running or not. Handlers: `internal/api/thread_agents.go`.
* **Commands** (`commands_agents.go`): `thread.agents` (ListItems' snapshot, a table
  NAME, TYPE, MODEL, MODE, STATUS, ELAPSED, TOOLS, TOKENS under "Agents: N running (M in
  the background) · K this thread", then each running run's activity with its last tool
  and each finished one's report or error; nested runs are `↳` under their parent) and
  `view.panel.agents` "Show Agents" (ShowView `panel.agents`). Both `hasSession`
  (`hasRenderedThread` no longer exists: every thread is rendered).

## Wire facts (2.1.299, from the captures)

* `task_started` has `task_type`: `local_agent` for an Agent call (task_id = the agent
  id = `agent-<id>.jsonl`), `local_bash` for a shell a subagent started
  (`owned_by_subagent`, `parent_task_id`). Shell tasks share all four frames; they are
  skipped (task_started by type, the others because their id is no run).
* A nested run's `task_started` has `spawn_depth: 2` and `parent_task_id`; its meta file
  has `parentAgentId` (read too, for runs met on disk).
* SendMessage waking a finished run: `task_started` again with the **same task_id**, a new
  run_id, and the **SendMessage's** tool_use_id (and as prompt the message). Its
  progress and notification carry that tool use id too. The run's `ToolUseID` stays the
  Agent call's.
* `task_progress.description` is the current activity ("Running Sleep 6 seconds then
  echo three"), the run's description when between tools. `usage.total_tokens` is the
  latest request's size (it does not add up: a woken run starts near its old context),
  `tool_uses` and `duration_ms` count from zero on each wake.
* `task_updated.patch.status` is `completed` or `killed` (TaskStop), with `end_time`;
  `task_notification.status` `completed`, `failed` or `stopped`. With `handback: "send"`
  the report is in `handback_report.text` and `summary` only points at it; a stopped
  run's summary is its description.
* No `<task-notification>` user frame comes on the stream; when the background run ends
  while the thread is idle, Claude starts a turn by itself (system/init, a reply, a
  result) and then a second empty result (`num_turns` 0).
* Closing stdin with a background run open: claude does not exit (the probe's
  SIGTERM after 30 s ended it). `--resume` then reports the run at once:
  `task_notification` `stopped`, "Background agent "X" didn't finish before the previous
  session ended", before the first user message.

## Decisions and gotchas

* **One record, two sources.** The transcripts keep giving a run's identity, `Open` (the
  file is followed) and `Usage`; the frames give its lifecycle. A run met first in a
  frame is created there (the subagents directory of the transcript the conversation is
  in) and joined to its Agent call's input by tool use id through the call's item (the
  assistant frame precedes `task_started`): model, effort, `run_in_background`. A frame
  marks the run `live`: from then the transcript no longer decides its status. A run no
  frame speaks for (an older Claude, a run found only on disk) follows its records:
  open is running, a completed result or notification done, anything else failed
  ("no result from Claude" when the idle safety net closes it).
* **Status mapping**: completed is done; running and pending are running; anything else
  (failed, killed, stopped, a newer word) failed. Error: Claude's report when it says
  more than the run's name, else Claude's word ("stopped"). Summary: the handed-back
  report, else the summary.
* **Wakes** run again in place: status running, `ResumedAt`, activity and the report
  cleared, `StartedAt` (the list's order) kept; tool uses and duration are summed over
  wakes, tokens are the latest. The list is in `StartedAt` order and a run's `StartedAt`
  never changes (the task_started's arrival, else the run's first record).
* **Items.** A background Agent call's result comes at once (`async_launched`): the
  projector keeps that item running (`projector.async`) until the run ends; done sets
  the report as its output (the launch text is internal metadata Claude says not to
  quote), failed makes it an error with the error. The run's notification releases the
  item, so a later wake changes only the run (and the SendMessage call's own item). A
  background run's end adds `KindNote` "Agent finished · <name> · <report's first
  line>" or "Agent failed · <name> · <error>" when its notification arrives (it carries
  the report; task_updated comes just before), ordered there; `NoteItemID` is the latest.
  Only a running-to-ended change in this runner adds one, so an orphaned run that Claude
  later reports stopped gets no second note (its error takes Claude's text).
* **Throttle.** A lifecycle change (a new run, status, report, note) publishes at once;
  progress alone (task_progress comes per tool call) at most once per second
  (`agentPublishGap`), the rest on the runner's next tick. Publication is the existing
  `publishUsage` path: `setUsage` replaces the Session's `AgentRuns` (and persists the
  changed rows), then the thread log's list follows (`setAgents`, skipped when equal).
  While the usage is off (a failed rescan) only the runs' records are published
  (`setAgentRuns`, keeping their saved usage).
* **Restart behaviour (a call made here; the brief said "running until the idle safety
  net").** Subagents run inside the thread's claude process, which never outlives the
  daemon, and Claude's own resume reports them stopped. So a run still running when its
  process ends fails with `<why> before the agent finished`: "the thread's process ended"
  (exit, crash, close), "the daemon stopped" (shutdown), "Claude restarted" (an effort
  restart), "the daemon restarted" (startup fails rows a crash left running), "the thread
  restarted" (a rescan's run that only its transcript says is running). Its end time is
  then, its duration runs to then, its background Agent call becomes an error with that
  text. Showing such a run as running would leave "N agents running in the background"
  on a disconnected thread. The idle safety net no longer closes a run the frames say is
  running (a long tool call writes nothing for a while): the frames are the truth, and
  the process end is the backstop.
* **Rescan merge.** A reconnect rebuilds the folds (`rescan`); `carryRuns` gives each run
  back its saved lifecycle (and the replaced threadUsage's live state), adopting saved
  runs no longer on disk. A resumed thread now polls its transcript when the runner
  starts, so this happens before the first frame (Claude's "stopped" report comes 0.4 s
  after spawn, before the first tick). Gotcha: that made `TestClearRescansEveryTranscript`
  flaky: the test signalled the fake with SIGUSR1 before it had installed its handler
  (Go ignores an un-notified SIGUSR1). `env.exit` now waits for the fake's spawn record,
  written after `signal.Notify`.
* **Counts.** `agents_running` is every running run, nested ones too;
  `background_agents_running` the thread's own background runs (spawn depth 1). The CLI
  header uses the same two numbers.

## What the GUI (PR 2) reads

* The panel and the strip: `ThreadItemsSnapshot.agents` then `ThreadEvent.agents` (the
  whole list each time; share unchanged runs by `id`, like `shareMcp`). Order as given.
  Nest by `parent_id` / `spawn_depth`. Name `description` (fallback `agent_type`); meta
  `agent_type · model (empty: inherited) · effort · background`. Running: `activity` +
  `last_tool`; done: `summary`; failed: `error`. Elapsed: while running, now −
  (`resumed_at` or `started_at`); after, `duration_ms`. Stats: `tool_uses`,
  `total_tokens`.
* The strip shows while a background run is open after the turn: the running runs with
  `background` (and depth 1), with `activity`.
* The sidebar's "N agents" line: `Session.agents_running` (or `background_agents_running`
  for "in the background"); it comes over EventService with the session, no Watch needed.
* Timeline: the background Agent call's item is RUNNING until the run ends; the note
  items are `note` kind; a run's `note_item_id` and `tool_use_id` (its item id) link the
  two.
* Commands: `view.panel.agents` (ShowView `panel.agents`) to open the tab; the mock
  daemon (gui/frontend/mock) has neither command nor agents yet.

## Verification

* `make check`: the Go half green (gofmt, vet, staticcheck, `go test -race ./...`). Its
  `frontend-deps` step cannot run in this worktree (`gui/frontend/node_modules` is a
  symlink to the main checkout; pnpm refuses to install into it), so typecheck, lint and
  vitest were run with the checkout's binaries: green (126 files, 2590 tests).
* Tests: `claudestream/parse_test.go` (the three fixtures); `session/agents_test.go`
  (status and error tables, notes; the captures through the projector and the model:
  join, order, nested parent, the shell skipped, the wake summed in place, two notes, the
  stop; a run the previous process left; orphan and carry; transcript-only runs and the
  idle safety net; publication: a start at once, progress held until the gap and flushed
  on a tick, the end at once with the progress, the note, persistence across a restart;
  the capture through the runner and the fake Claude: the running Agent call past its
  turn, the note, the nested pair, the wake; orphaned by a process exit, a daemon stop
  and a crash); `api/thread_agents_test.go` (mapping, counts, Watch snapshot and event,
  ListItems); `command/commands_agents_test.go` (availability, the table, ShowView,
  `FormatAgents`).
* Live (2026-10-14, Claude Code 2.1.299): an isolated daemon
  (`CODE_FOUNDRY_HOME=/tmp/cf-agents-home code-foundry daemon --dev`), a throwaway repo
  `~/.cf-agents-scratch` (projects must be under home, so /tmp was refused; removed
  afterwards), a haiku thread at medium effort, auto permissions:
  * a background "Slow count" (`sleep 20`): `thread agents` showed it running with "Running
    Sleep 20 seconds then echo three (Bash)", the session `agents_running 1, background
    1`; then done "three", the Agent item DONE with output "three", the note "Agent
    finished · Slow count · three" before Claude's own follow-up turn;
  * a background "Long wait" (a 120 s sleep), daemon stopped: failed "the daemon stopped
    before the agent finished"; after the reconnect Claude's report replaced it ("Background
    agent "Long wait" didn't finish before the previous session ended"), no note. The
    first live run showed the Agent item kept the launch text and a 1 s elapsed (the last
    progress); fixed (`endRuns`), and a second run ("Second wait") then showed 19 s and
    the error as the item's output;
  * SendMessage to the finished "Slow count": running again in place (`resumed_at`,
    elapsed from the wake), then done "four" with 4 tool uses and 35.5 s summed over both
    wakes, the spawn's tool use id kept, a second note.
* Not verified: the GUI (PR 2); a run failing with Claude's `failed` status (none could be
  provoked; mapped like stopped).
