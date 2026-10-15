# Agents panel tab: three sketches

Static sketch of a side-panel **Agents** tab plus three ways a thread shows that
subagents are running. Open `index.html?variant=a|b|c&thread=chip|strip|line&theme=dark|light`;
`node shoot.mjs` renders `shots/<v>-<theme>.png` (+ `-panel.png` crops, thread=chip) and
`shots/thread-<strip|line>-<theme>.png` (variant b). 1440×900 @2x, WebKit.

Data is what the stream already carries and the daemon parses but drops today
(`claudestream.Task`: `task_started` with description, subagent_type, is_backgrounded,
spawn_depth; `task_progress` with the agent's current activity, last tool, tokens, tool
uses, duration; `task_updated` with a status patch; `task_notification` with status and
summary) joined to the Agent tool_use input (model, effort, run_in_background) and the
existing `AgentRun` record (usage). Five runs cover every state: two background runs
in progress, one nested run (spawn depth 2) in progress, one finished foreground Explore
with its report, one failed background run.

Shared: panel header (bot icon, "Agents", "N running · M this thread", a line about
background runs), per run its name (the Agent call's description), type · model · effort
· foreground/background, a live activity line (shimmer + last tool) while running, the
summary or error when not, and stats (elapsed, tool uses, tokens).

* **A: grouped two-line rows.** Running / Finished sections, nested runs indented with ↳,
  stats in the right column. Densest; matches the MCP tab's variant C style.
* **B: cards.** Like the MCP tab (variant B, shipped): status pill, sky border while
  running, red when failed, "Show in thread" on every card, nested runs inset under their
  parent.
* **C: tree by turn.** One list in spawn order under a "Turn N" divider, nested runs
  connected to their parent, an indeterminate bar under running ones.

Thread (all variants): Agent rows gain a `background` chip, the live activity text and
elapsed time, and follow the task lifecycle rather than the tool_result (a background
Agent's result returns at once; the row stays running until the task ends). A background
run that ends after the turn adds a "Agent finished · name · summary" note row. The
sidebar row's line 2 shows "N agents" in sky while any run.

Running-agents signal, three options (`?thread=`):
* **chip** (header): bot icon + count + spinner in the header actions, left of the
  action buttons, like the Linked PRs count; opens the Agents tab.
* **strip** (above the composer): a sky-tinted bar naming the running agents and their
  activity, with an "Agents" link; shown while any background run is open.
* **line** (in the timeline): after the turn's footer, a working line "N agents working
  in the background · Show agents".

## Decisions (Alex, 2026-10-14)

* **No cards.** The panel is a flat list in spawn order, always (status never reorders
  it), with separators that run from border to border. Two densities: **L1** (stats on
  their own last line) and **L2** (stats at the right of the meta line). `shots/l1-*`,
  `shots/l2-*`; A/B/C are superseded.
* **Strip above the composer** is the running-agents signal in the thread. No header chip,
  no timeline line.
* **Sidebar sort unchanged.** A thread with only background agents stays where it is (you
  can still send a message), but its line 2 shows "N agents" in sky.
* **Runs persist.** Claude can wake a finished subagent (SendMessage with its agent id;
  the daemon already sees `resumedAgentId`), so finished runs stay in the list across
  restarts and a resumed one goes back to Running in place.
* **L1** is final (`shots/l1-strip-*.png`). Rows are not clickable in v1 (no "show in
  thread"). The strip shows only while background runs are open after the turn ends;
  foreground runs are covered by their spinning timeline rows.
