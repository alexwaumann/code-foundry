# Sidebar inbox 1: Thread.busy_tool

PR 1 of 3 of the sidebar thread-row redesign (three-line inbox rows). Daemon and API
layer only: the working row's line 3 needs the tool Claude is running now ("Bash make
check"), which the thread list record did not carry (the live tool strip reads it from
the thread log, which only a visible thread view streams).

## Decisions

- `Thread.busy_tool = 73` is `"<tool> <argument>"`, the argument being the target the
  live tool strip shows for a step (gui/frontend/src/lib/toolSummary.ts): Bash's command's
  first line (" …" when more follows), a file tool's path relative to the thread's
  directory, Grep/Glob's pattern, Agent's description, WebFetch's URL without the scheme,
  WebSearch's query; TodoWrite is the name alone; an MCP tool reads `<server> <tool>`;
  any other tool takes its input's first string value, in document order. Capped at 160
  runes. One string, not name + argument fields: the row shows it as is.
- Formatted in Go (busytool.go `toolLine`), not in the GUI: the sidebar has no thread log
  and the row should not parse tool input JSON for every thread.
- Tracked by the projector (`projector.busy`, a `busyCalls` list in start order), which
  already sees every top-level tool_use and tool_result: a call enters at its
  content_block_start (name only, the input is still streaming) or at its unstreamed
  assistant frame, gets its input when the block completes, and leaves at its
  tool_result. A result (turn end) and a process restart (effort change) clear it.
- Several in flight (parallel calls): the latest started shows; when it finishes the
  previous one shows again.
- Subagent frames (parent_tool_use_id set) never enter. The Agent call that runs them is
  a top-level call, so a thread waiting on a foreground subagent reads "Agent <description>".
- A background launch (Agent with run_in_background, Bash run_in_background, Monitor)
  leaves at its immediate result even though its item stays running: those are the
  background agents and shells counters, not "running now".
- Published with the status (runner `readStatus` / `publishStatus`, same debounce),
  gated by `busyToolFor`: only while status is BUSY and the reason is not "compacting".
  A permission prompt (NEEDS_ATTENTION) hides it; approving brings it back. A change of
  the tool alone is published without a save (`update(…, false)`): it is not persisted.
- `Thread.setStatus` drops it whenever the new status does not allow one, so any other
  path that moves the status (archive, start failure, a wake limit) cannot leave a stale
  line, and `runner.finish` clears it with the process (a disconnected thread has none).
- Frontend: `ThreadView.busyTool` in src/api/threads.ts only; no component reads it yet
  (PR 3 does).
- Mock: `MockThread.busyTool`, gated the same way (mock `busyToolFor`, and never sent for
  a stopped thread); `POST /__mock/thread/status?…&busyTool=…` sets it. s-1 is seeded with
  "Bash go test ./internal/..." and gets it back each time its 4 s ticker makes it busy
  again; s-k-busy (status-kinds scenario) has "Bash make check".

## Gotchas

- `content_block_start` carries `input: {}`; the real input arrives as input_json_delta
  fragments and then the assistant frame. The line is "Bash" for that short moment, then
  "Bash make check". Partial JSON is never parsed (`toolLine` falls back to the name).
- `projector.finish` now reads the item it completes back from `change` to pick up the
  final input; for a block that stopped without its assistant frame that is the
  streamed JSON.
- `firstString` walks the JSON with a token decoder: a Go map would make "the first
  string argument" random.
- "compacting" now has a constant, `ReasonCompacting`, used by stream_status.go too.
