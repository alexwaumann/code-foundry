# Rendered threads, PR 4: opt-in and polish

Status: done on branch `t3code/rendered-threads-4-optin` (on top of PR 3,
`t3code/rendered-threads-3-interaction`, merged in with its review fixes). Earlier PRs:
`rendered-threads-1-daemon.md`, `rendered-threads-2-gui.md`, `rendered-threads-3-interaction.md`;
design: `rendered-threads-handoff.md` (§3: the setting is the default for new threads only, a
thread's view is fixed for life, no plan mode).

## What landed

* **Composer View picker** (`components/compose/Composer.tsx`, `stores/compose.ts`,
  `lib/compose.ts`). A fourth picker after Permissions, same component and look as the
  others (icon, text, chevron; rows with a hint and a checkmark): Terminal ("Claude Code's
  own interface") | Rendered ("The app draws the conversation"). `Draft.render` is `null`
  until the user picks, like model and effort: the trigger shows the `sessions.render`
  setting (`useSettingValue`) and follows it live; a pick wins for that draft (and moves with
  it to another project). Send always passes `render` to `session.new` (what the composer
  shows is what starts). Tab order: … Permissions → View → attach.
* **Threads not started from the composer** pass no render, so the daemon applies the setting:
  `pr.ask` / `pr.explain` / `pr.fix.findings` (their `CreateSessionRequest` has no `Render`;
  the existing table test compares the whole request), the CLI without `--render`. Fork and
  Reconnect keep the parent's / row's view (daemon rule since PR 1; `TestRenderedControls` forks one); the
  workspace "Run in" flows move an existing thread and create none. New store test case:
  setting rendered + no choice → rendered.
* **Settings**: "Thread view" (Terminal / Rendered) now says what it is for: "View for new
  threads: the composer starts with it, and threads started elsewhere (pull request actions,
  the CLI without --render) get it. …" The e2e settings spec checks the row (title, options
  with "(default)", live, placed right after the naming model).
* **Header**: a rendered thread's header meta says `rendered` after model · effort (plain
  muted text, no tooltip: nothing is hidden). A terminal thread says nothing (the default,
  and its terminal shows itself). Sidebar rows and the Projects page are unchanged.
* **Per-turn cost and model on `turn_end`** (daemon). `TurnEndItem.turn_cost_usd` (optional,
  14) and `model` (15). See "Cost per turn" below. The footer uses them ("… · $0.02 · Haiku
  5.5"); a turn without them (recorded by an older daemon) falls back to the old subtraction
  and the thread's current model. `lib/models.ts canonicalModelName` turns Claude's id into a
  name (registry label if pinned there, else "Haiku 5.5" read from `claude-haiku-5-5`, `[1m]`
  and date suffixes dropped). `thread items` prints "$X, $Y so far, <model>".
* **Which subagent asked.** A permission or question with `agent_id` shows a chip
  "general-purpose · Write the changelog entry" (the Agent call's `subagent_type` and
  `description`) instead of "subagent": the request's tool call (item id = tool_use id) →
  its `parent_tool_use_id` → the Agent call's input (`useAgentInputOf`, a string selector;
  `lib/threadRequest askingAgentLabel`). The chip truncates in a narrow pane (title = the
  label for that case).
* **Edge states.** While the thread is starting the working row says "Starting Claude…"
  (no elapsed time; also during a Reconnect). A connected thread with no items (a fork: its
  history is in Claude's transcript, not `thread_items`) says "Forked from <parent>. Claude
  has the conversation so far; send a follow-up to continue." (or "No messages yet."). A
  claude that died before the handshake shows the daemon's error item ("Claude exited (code
  1) before answering the initialize handshake: <stderr>") above the Reconnect bar
  ("Not connected · crashed (exit code 1)"). A closed thread keeps its conversation above the
  bar.
* **Follow-up placeholder**: already "Send a follow-up…" / "Send a follow-up… Claude picks it
  up mid-turn" with one Interrupt (PR 2/3); now covered by e2e.
* **Palette / help**: `thread.*` titles and the Thread category were already right; e2e checks
  they list for a rendered thread and not for a terminal one. `session.new`'s description says
  what `render` does and that the setting applies without it.
* **Mock**: `session.new` takes `render` (and `composer-prompt`), defaulting to the mock
  setting; a rendered creation has no terminal and sends its prompt as the first message
  once it connects; PR commands use the setting; fork keeps the view and sets `parentId`;
  `lastError`/`parentId` on sessions; turn ends carry `turnCostUsd`/`model`
  (`/__mock/thread/finish?total=&turnCost=&model=`); new thread states `subagent`, `closed`,
  `crashed`; tool items are keyed by their tool_use id like the daemon's.

## Cost per turn

Claude's `result` has only running totals for its process: `total_cost_usd` and
`modelUsage` (per model, subagents included); `usage` is the turn's own (top level only).
`turnCosts` (`internal/store/session/turncost.go`) gives each turn the difference from the
previous result of the same process. Across a restart (effort change: `projector.restart`;
Reconnect or daemon restart: a new projector seeded from the log's last turn end) it depends
on Claude:

* Probed (2.1.296, haiku): `--resume` of the conversation Claude last ran in that folder
  **restores** the totals and keeps adding (0.00272 → 0.00306 with `outputTokens` 85 → 90),
  which is the "seen growing across an effort restart" of PR 3. Otherwise (a fork, another
  conversation ran there since) they start from zero.
* So the first result after a restart is "restored" when its process output tokens are at
  least the previous process's plus this turn's own (`ProcessOutputTokens`, stored on the
  turn end, not in the proto); otherwise fresh. Only a first turn whose subagents wrote more
  than the whole previous process could be misread. Without `modelUsage`, the total decides.
* A result with no total (an interrupt can report 0) costs 0 and moves nothing: its spend
  shows in the next turn's. A total going down within a process restarts the count.

Live (scratch daemon): first turn $0.0016; effort restart then a turn $0.0020 ($0.0036 so
far, restored); close + reconnect then a turn $0.0006 ($0.0042 so far, restored).

The turn's model is the last top-level `assistant` frame's `message.model` (a subagent may
run another model; `<synthetic>` error messages are skipped); empty for a turn with no reply.

## Gotchas

* `TestConnRequestCorrelation` (PR 1) flaked in `make check`: it read two out-of-order
  answers from one channel; now one channel per request (`flaky-tests.md`).
* Running the live daemon from a `nohup … &` in a tool call: it was SIGTERMed a minute later
  (the shell's process group); run it as a background task instead. The CLI then auto-starts a
  non-`--dev` daemon on the same home, which looks like the old one is still there.
* The e2e `session.new` args assertions that compare the whole args object gained
  `render: "terminal"`: the composer always sends it now.
* Mock tool items used generated ids; the subagent lookup needs id = tool_use id (the
  daemon's rule), so the mock follows it now.

## Verification

* `make check` green. New Go tests: `TestTurnCosts` (table: one process, restored and fresh
  restarts, seeded from the last turn end, no modelUsage, interrupts, a total going down),
  `TestProjectTurnCostAndModel` (projector over synthesized frames: subagent and synthetic
  models ignored, effort restart, reconnect), `TestDefaultRender` case, API mapping,
  `thread.items` text. Vitest: `canonicalModelName`, `askingAgentLabel`, `threadArgs` render,
  a moved draft keeps its view.
* `make gui-e2e` green on WebKit and Chromium, including `e2e/composer-view.spec.ts` (setting
  default followed until picked; explicit pick wins both ways; the created thread's view, the
  header badge, "Starting Claude…"), settings row, footers (`$1.50 · Sonnet 5` where the
  subtraction would say $0.38; an older turn falls back), the subagent chip, crashed /
  closed / fork states, placeholder, palette.
* Live: scratch daemon from this worktree (`CODE_FOUNDRY_HOME=/tmp/cf-rt4-home … daemon
  --dev`), repo `~/cf-rt4-scratch`, Vite + Playwright WebKit. `sessions.render` set to
  rendered: the composer's picker said Rendered; Enter started a rendered haiku/low thread
  (header "rendered", a markdown table, footer "Worked for 1.0s · <$0.01 · Haiku 5.5"). The
  picker set to Terminal: the next thread opened as a terminal (no thread pane, no badge;
  `render` TERMINAL in `session list --json`). Screenshots in `/tmp/cf-rt4-shots/`:
  `composer-view-picker-{dark,light}[-card].png`, `live-rendered-{dark,light}.png`,
  `live-terminal-dark.png`, `settings-thread-view-{dark,light}[-row].png`, and mock states in
  `mock/` (`subagent-dark`, `crashed`, `starting`, `fork-empty`).

## Daemon restart

Needed: `turn_cost_usd` / `model` and `session.new`'s help are daemon changes. An older
daemon still works with this GUI (the footer falls back; the composer's `render` arg exists
since PR 1).
