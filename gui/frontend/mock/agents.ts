/**
 * A thread's subagent runs in the mock daemon (docs/notes/agents-1-daemon.md,
 * docs/notes/agents-2-gui.md): the sketch's five runs (docs/sketches/agents-panel) on the
 * scripted thread's "agents" state (POST /__mock/thread?state=agents, mock/thread.ts):
 * a finished foreground Explore with its report, two background general-purpose runs
 * still running with their activity, a nested run (spawn depth 2) under the first, and a
 * failed background run with its "Agent failed · …" note. The thread's
 * agents_running / background_agents_running follow the list (mock/world.ts threadMsg).
 *
 *   POST /__mock/thread/agent-end?id=s-r1&run=a1[&status=done|failed]   a run ends: its
 *        Agent call's item finishes, a note follows, the list and the counts are published.
 *
 * The commands thread.agents, view.panel.agents and thread.agent.open (any active thread)
 * and thread.agent.up (the subagent view, or the CLI), like the daemon's. "PR 1" and the
 * failed run carry their own items (parent_tool_use_id = their Agent call) for the
 * read-only subagent view; the done Explore has its work and report.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { AgentRunStatus, type AgentRunSchema } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { ThreadAgentStatus, ToolCallStatus, type ThreadAgentRunSchema, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import { launchShell, type ShellCall } from "./shells";
import { panelThreadArgs, runPanelVerb } from "./panelVerbs";
import type { UiIntentInit } from "./world";

export type AgentRunInit = MessageInitShape<typeof ThreadAgentRunSchema>;
type AgentRunListInit = MessageInitShape<typeof AgentRunSchema>;
type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type Over = Partial<ItemInit> & { at?: Date; until?: Date };

/** What the "agents" script needs from MockThreadLogs.load. */
export interface AgentsScript {
  cwd: string;
  it(payload: ItemInit["payload"], over?: Over): ItemInit;
  tool(name: string, input: object, value: { output?: string; isError?: boolean; resultJson?: string; status?: ToolCallStatus }, over?: Over): ItemInit;
  /** Receives the background shells the script launches (mock/shells.ts), if given. */
  shells?: ShellCall[];
}

const ts = (d: Date) => timestampFromDate(d);
const callId = (it: ItemInit) => (it.payload?.case === "toolCall" ? (it.payload.value.toolUseId ?? "") : "");

/** The async launch result Claude gives a background Agent call at once. */
const LAUNCHED = (agentId: string) =>
  JSON.stringify({ status: "async_launched", agentId, description: "", prompt: "", outputFile: `/tmp/claude/tasks/${agentId}.output`, isAsync: true });

export const EXPLORE_REPORT =
  "LinkedPrs in HeaderActions.tsx renders a CommandButton with a count when there are 2+ PRs; the single case is SingleLinkedPr. Both open a panel surface.";
export const FAILED_ERROR = "Stopped: process exited with code 1";
/** What the thread asked "PR 1" to do (its Agent call's prompt): the subagent view's prompt bubble. */
export const PR1_PROMPT =
  "Implement PR 1: the daemon side of the agents panel. Parse the task frames in claudestream, persist runs in session_agent_runs, publish them on the thread snapshot. Commit as you go. Don't touch the GUI.";

/** `n` lines of placeholder Go source (an edit's diff counts come from its line counts). */
function lines(tag: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `\t// ${tag} ${String(i + 1)}`).join("\n");
}
/** What a run reports when POST /__mock/thread/agent-end ends it done. */
export const END_REPORTS: Readonly<Record<string, string>> = {
  a1: "Added task frame handling to the thread store with 14 table tests; make check is green.",
  a1b: "usage_runs.go keeps one record per run; nothing to change.",
  a2: "The Agents surface lists every run in spawn order with its live activity.",
};

/**
 * The sketch's conversation: the prompt, the Explore with its work and report, three
 * background Agent calls (two still running, one failed), Claude's reply, the turn's end
 * and the failed run's note. Returns the runs in spawn order.
 */
export function scriptAgents(s: AgentsScript, now = Date.now()): AgentRunInit[] {
  const ago = (sec: number) => new Date(now - sec * 1000);
  const p = (rel: string) => `${s.cwd}/${rel}`;
  s.it(
    {
      case: "userMessage",
      value: {
        text: "Build the agents panel: PR 1 is the daemon side, PR 2 the GUI surface. Fan both out as background agents and look up how the header chips are done first.",
        attachments: [],
      },
    },
    { at: ago(345) },
  );
  const explore = s.tool(
    "Agent",
    { description: "Find the header chip pattern", subagent_type: "Explore", model: "haiku", prompt: "How are the header chips done?" },
    {
      output: EXPLORE_REPORT,
      resultJson: JSON.stringify({ status: "completed", totalToolUseCount: 6, totalDurationMs: 12_000, content: [{ type: "text", text: EXPLORE_REPORT }] }),
    },
    { at: ago(330), until: ago(318) },
  );
  const exploreId = callId(explore);
  s.tool(
    "Grep",
    { pattern: "LinkedPrs|CommandButton", path: p("gui/frontend/src") },
    { output: "HeaderActions.tsx", resultJson: JSON.stringify({ mode: "files_with_matches", numFiles: 3 }) },
    { at: ago(328), parentToolUseId: exploreId },
  );
  s.tool(
    "Read",
    { file_path: p("gui/frontend/src/components/thread/HeaderActions.tsx") },
    { output: "", resultJson: JSON.stringify({ type: "text", file: { numLines: 112, startLine: 1, totalLines: 112 } }) },
    { at: ago(325), parentToolUseId: exploreId },
  );
  s.it({ case: "assistantText", value: { text: EXPLORE_REPORT } }, { at: ago(319), parentToolUseId: exploreId });

  const pr1 = s.tool(
    "Agent",
    { description: "PR 1: daemon task frames", subagent_type: "general-purpose", model: "opus", effort: "high", run_in_background: true, prompt: PR1_PROMPT },
    { status: ToolCallStatus.RUNNING, output: "Async agent launched successfully.", resultJson: LAUNCHED("a1") },
    { at: ago(252) },
  );
  const pr1Id = callId(pr1);
  // PR 1's own work (its items carry the Agent call as their parent), for the read-only
  // subagent view: thinking, a read and a search, a nested Agent call, two edits, a test
  // still running and a reply still streaming.
  s.it({ case: "thinking", value: { text: "The task frames come on the stream: parse them in claudestream first, then persist the runs." } }, { at: ago(250), until: ago(244), parentToolUseId: pr1Id });
  s.tool(
    "Read",
    { file_path: p("internal/claudestream/types.go") },
    { output: "", resultJson: JSON.stringify({ type: "text", file: { numLines: 380, startLine: 1, totalLines: 380 } }) },
    { at: ago(243), parentToolUseId: pr1Id },
  );
  s.tool(
    "Grep",
    { pattern: "task_started|task_progress", path: p("internal") },
    { output: "", resultJson: JSON.stringify({ mode: "content", numLines: 14, numFiles: 3 }) },
    { at: ago(240), parentToolUseId: pr1Id },
  );
  const review = s.tool(
    "Agent",
    { description: "Review usage_runs changes", subagent_type: "Explore", prompt: "Review the usage_runs changes." },
    { status: ToolCallStatus.RUNNING },
    { at: ago(38), parentToolUseId: pr1Id },
  );
  s.tool("Read", { file_path: p("internal/store/thread/usage_runs.go") }, { status: ToolCallStatus.RUNNING }, { at: ago(5), parentToolUseId: callId(review) });
  s.tool(
    "Edit",
    { file_path: p("internal/store/thread/agents.go"), old_string: lines("old", 3), new_string: lines("new", 84) },
    { output: "The file has been updated." },
    { at: ago(36), parentToolUseId: pr1Id },
  );
  s.tool(
    "Write",
    { file_path: p("internal/store/thread/agents_db.go"), content: lines("db", 61) },
    { output: "File created successfully." },
    { at: ago(30), parentToolUseId: pr1Id },
  );
  s.tool("Bash", { command: "go test ./internal/store/thread/... -run TestAgent" }, { status: ToolCallStatus.RUNNING }, { at: ago(20), parentToolUseId: pr1Id });
  s.it(
    { case: "assistantText", value: { text: "Tests for the frame parser pass. Wiring the runner glue next, then the migration" } },
    { at: ago(12), parentToolUseId: pr1Id, streaming: true },
  );
  const pr2 = s.tool(
    "Agent",
    { description: "PR 2: Agents surface in the panel", subagent_type: "general-purpose", model: "opus", effort: "high", run_in_background: true, prompt: "Build PR 2." },
    { status: ToolCallStatus.RUNNING, output: "Async agent launched successfully.", resultJson: LAUNCHED("a2") },
    { at: ago(231) },
  );
  const shot = s.tool(
    "Agent",
    { description: "Screenshot the panel in Wails", subagent_type: "claude", run_in_background: true, prompt: "Screenshot the panel." },
    { status: ToolCallStatus.ERROR, isError: true, output: FAILED_ERROR },
    { at: ago(246), until: ago(183) },
  );
  // Its short log: a build, then the launch that failed.
  s.tool(
    "Bash",
    { command: "make gui-build", description: "Build the GUI" },
    { output: "built bin/Code Foundry", resultJson: JSON.stringify({ stdout: "built bin/Code Foundry", stderr: "", interrupted: false }) },
    { at: ago(244), until: ago(200), parentToolUseId: callId(shot) },
  );
  s.tool(
    "Bash",
    { command: "open -a 'Code Foundry'", description: "Open the app" },
    { isError: true, status: ToolCallStatus.ERROR, output: "LSOpenURLsWithRole() failed with error -10810 for the application Code Foundry." },
    { at: ago(198), until: ago(184), parentToolUseId: callId(shot) },
  );
  const shell = launchShell(s, { taskId: "b7n2x4kq0", command: "pnpm --dir gui/frontend dev:mock", description: "Start the mock daemon's dev server", at: ago(228) });
  s.shells?.push(shell);
  s.it(
    { case: "assistantText", value: { text: "Both PRs are building in the background. The screenshot agent died when the Wails window failed to start; I will retry it once PR 2 lands." } },
    { at: ago(226) },
  );
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 48_000n, numTurns: 4, costUsd: 0.12, turnCostUsd: 0.12, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(225) });
  const note = s.it({ case: "note", value: { text: `Agent failed · Screenshot the panel in Wails · ${FAILED_ERROR}` } }, { at: ago(183) });

  return [
    {
      id: "a0",
      toolUseId: exploreId,
      description: "Find the header chip pattern",
      agentType: "Explore",
      model: "haiku",
      background: false,
      spawnDepth: 1,
      status: ThreadAgentStatus.DONE,
      activity: "Reading HeaderActions.tsx",
      lastTool: "Read",
      totalTokens: 9_400n,
      toolUses: 6n,
      durationMs: 12_000n,
      summary: EXPLORE_REPORT,
      startedAt: ts(ago(330)),
      endedAt: ts(ago(318)),
    },
    {
      id: "a1",
      toolUseId: pr1Id,
      description: "PR 1: daemon task frames",
      agentType: "general-purpose",
      model: "opus",
      effort: "high",
      background: true,
      spawnDepth: 1,
      status: ThreadAgentStatus.RUNNING,
      activity: "Running go test ./internal/store/...",
      lastTool: "Bash",
      totalTokens: 48_200n,
      toolUses: 23n,
      durationMs: 240_000n,
      startedAt: ts(ago(252)),
    },
    {
      id: "a2",
      toolUseId: callId(pr2),
      description: "PR 2: Agents surface in the panel",
      agentType: "general-purpose",
      model: "opus",
      effort: "high",
      background: true,
      spawnDepth: 1,
      status: ThreadAgentStatus.RUNNING,
      activity: "Editing AgentsSurface.tsx",
      lastTool: "Edit",
      totalTokens: 61_700n,
      toolUses: 31n,
      durationMs: 220_000n,
      startedAt: ts(ago(231)),
    },
    {
      id: "a3",
      toolUseId: callId(shot),
      description: "Screenshot the panel in Wails",
      agentType: "claude",
      background: true,
      spawnDepth: 1,
      status: ThreadAgentStatus.FAILED,
      activity: "Running open -a code-foundry",
      lastTool: "Bash",
      totalTokens: 12_000n,
      toolUses: 9n,
      durationMs: 63_000n,
      error: FAILED_ERROR,
      startedAt: ts(ago(246)),
      endedAt: ts(ago(183)),
      noteItemId: note.id ?? "",
    },
    {
      id: "a1b",
      toolUseId: callId(review),
      parentId: "a1",
      description: "Review usage_runs changes",
      agentType: "Explore",
      background: false,
      spawnDepth: 2,
      status: ThreadAgentStatus.RUNNING,
      activity: "Reading usage_runs.go",
      lastTool: "Read",
      totalTokens: 6_100n,
      toolUses: 4n,
      durationMs: 36_000n,
      startedAt: ts(ago(38)),
    },
  ];
}

/** Thread.agents_running (every running run) and background_agents_running (the thread's own background ones). */
export function agentCounts(runs: readonly AgentRunInit[]): { agentsRunning: number; backgroundAgentsRunning: number } {
  const running = runs.filter((r) => r.status === ThreadAgentStatus.RUNNING);
  return { agentsRunning: running.length, backgroundAgentsRunning: running.filter((r) => r.background && (r.spawnDepth ?? 1) <= 1).length };
}

/**
 * The thread list's agent_runs for a thread's runs, like the daemon's Thread.agent_runs:
 * open while running, closed once ended, no usage (the mock prices none per run). The GUI
 * lists the Agents surface only for a thread with some (docs/notes/panel-polish.md).
 */
export function listRuns(runs: readonly AgentRunInit[]): AgentRunListInit[] {
  return runs.map((r) => ({
    id: r.id,
    description: r.description,
    agentType: r.agentType,
    model: r.model,
    effort: r.effort,
    background: r.background,
    status: r.status === ThreadAgentStatus.RUNNING ? AgentRunStatus.OPEN : AgentRunStatus.CLOSED,
    spawnDepth: r.spawnDepth ?? 1,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
  }));
}

/** What MockThreadLogs offers the agent commands and the control. */
export interface AgentThreads {
  /** The thread's runs in spawn order ([] for none). Throws for an unknown thread. */
  agentsOf(id: string): AgentRunInit[];
  /** The thread's running background shells (mock/shells.ts). */
  shellsOf(id: string): number;
  calls: string[];
}

type Command = {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

/** The thread.agents header's tail: " · N shell(s) in the background", "" for none. */
function shellsNote(n: number): string {
  if (n <= 0) return "";
  return ` · ${String(n)} ${n === 1 ? "shell" : "shells"} in the background`;
}

/** thread.agents, view.panel.agents, thread.agent.open and thread.agent.up, like the daemon's. */
export function agentsCommands(threads: AgentThreads, emit: (i: UiIntentInit) => number): Command[] {
  const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
  return [
    {
      cmd: {
        name: "thread.agents", noPalette: true,
        title: "Show Thread Agents",
        category: "Thread",
        description: "Print a thread's subagent runs in spawn order, foreground and background, nested ones under their parent.",
        keybindings: [],
        args: [{ name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" }],
      },
      when,
      run: (ctx, a) => {
        const id = a.id || ctx?.activeThreadId || "";
        threads.calls.push(`agents ${id}`);
        const runs = threads.agentsOf(id);
        const shells = shellsNote(threads.shellsOf(id));
        if (runs.length === 0) return Promise.resolve({ message: `no subagent runs in this thread${shells}`, resultJson: JSON.stringify({ threadId: id, agents: [] }) });
        const c = agentCounts(runs);
        return Promise.resolve({
          message: `Agents: ${String(c.agentsRunning)} running (${String(c.backgroundAgentsRunning)} in the background) · ${String(runs.length)} this thread${shells}`,
          resultJson: JSON.stringify({ threadId: id, agents: runs.map((r) => ({ id: r.id, description: r.description })) }),
        });
      },
    },
    {
      cmd: {
        name: "view.panel.agents",
        title: "Show Agents",
        category: "View",
        description: "Open the Agents surface in the selected thread's side panel: its subagent runs with their status, activity and report.",
        keybindings: [],
        args: panelThreadArgs,
      },
      when,
      run: (_ctx, args) => runPanelVerb(emit, "panel.agents", args),
    },
    {
      cmd: {
        name: "thread.agent.open", noPalette: true,
        title: "Open Subagent",
        category: "Thread",
        description: "Show one of a thread's own subagent runs read-only in the GUI: its prompt, work log and report, under the thread.",
        keybindings: [],
        args: [
          { name: "run", type: ArgType.STRING, required: true, description: "Agent run id (or its start)" },
          { name: "id", type: ArgType.STRING, required: true, description: "Thread id" },
        ],
      },
      when,
      run: (ctx, a) => {
        const id = a.id || ctx?.activeThreadId || "";
        threads.calls.push(`agent open ${id} ${a.run ?? ""}`);
        const runs = threads.agentsOf(id);
        const ref = a.run ?? "";
        const exact = runs.find((r) => r.id === ref);
        const match = exact ? [exact] : runs.filter((r) => (r.id ?? "").startsWith(ref));
        if (match.length !== 1) throw new CommandError(match.length === 0 ? "notfound" : "invalid", match.length === 0 ? `thread ${id} has no agent run "${ref}"` : `agent run "${ref}" is ambiguous`);
        const run = match[0];
        if ((run?.spawnDepth ?? 1) > 1) throw new CommandError("invalid", `agent run ${run?.id ?? ""} was spawned by another agent: only a thread's own runs open`);
        emit({ intent: { case: "showAgentRun", value: { threadId: id, runId: run?.id ?? "" } } });
        return Promise.resolve({ message: "", resultJson: JSON.stringify({ delivered: 1 }) });
      },
    },
    {
      cmd: {
        name: "thread.agent.up",
        title: "Back to Parent Thread",
        category: "Thread",
        description: "Leave the subagent view for the thread that ran the subagent.",
        keybindings: ["escape"],
        args: [],
      },
      // Like the daemon's: while the GUI shows a subagent (active view thread.agent), or from the CLI.
      when: (ctx) => ctx?.activeView === "thread.agent" || !ctx?.activeView,
      run: () => `delivered=${String(emit({ intent: { case: "showView", value: { name: "agent.up" } } }))}`,
    },
  ];
}
