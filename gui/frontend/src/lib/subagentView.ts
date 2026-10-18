/**
 * The read-only subagent view's pure helpers: which of the thread's items are a run's own
 * (a filter over the same log the thread's timeline shows), its rows, the turn whose
 * Agent call launched it, and its prompt and footer.
 */
import type { AgentRunView } from "@/api/agents";
import { agentElapsedMs, fmtElapsed } from "./agents";
import { buildTurns, workNodes, type TimelineItem, type WorkNode } from "./threadTimeline";
import { fmtTok } from "./usage";

/**
 * A run's own items: the ones whose parent_tool_use_id is its Agent call's tool_use id, in
 * the log's (ordinal) order. Its nested runs' items are not among them (the stream never
 * carries them), so a nested Agent call shows as a row with no children.
 */
export function runItems<T extends Pick<TimelineItem, "parentToolUseId">>(items: readonly T[], toolUseId: string): T[] {
  if (!toolUseId) return [];
  return items.filter((it) => it.parentToolUseId === toolUseId);
}

const NO_CHILDREN: ReadonlyMap<string, TimelineItem[]> = new Map();

/**
 * The tool a subagent hands its report back with (Claude Code's SubagentHandback, its
 * input `message` the report). The daemon makes the report the run's summary, which the
 * view shows as its report block, so the call itself is no row of the view.
 */
export const HANDBACK_TOOL = "SubagentHandback";

/**
 * A run's work rows: its items as the timeline's work nodes (groups, merged thinking, its
 * own Agent calls without children), without its handback call (HANDBACK_TOOL).
 */
export function runNodes(all: readonly TimelineItem[]): WorkNode[] {
  const items = all.filter((it) => !(it.kind === "tool" && it.name === HANDBACK_TOOL));
  const tools = new Set(items.filter((it) => it.kind === "tool").map((it) => it.toolUseId));
  const permissions = new Map<string, TimelineItem>();
  for (const it of items) if (it.kind === "permission" && it.toolUseId && tools.has(it.toolUseId)) permissions.set(it.toolUseId, it);
  return workNodes(items, NO_CHILDREN, permissions);
}

/** The id of a run's last text item (its answer once done), "" when it wrote none. */
export function lastTextId(nodes: readonly WorkNode[]): string {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n?.type === "text") return n.id;
  }
  return "";
}

/**
 * The number of the thread's turn (1 for its first) whose work holds the Agent call
 * `callId` at its top level; 0 when no turn has it. A daemon note's turn of its own is no
 * turn of the conversation and is not counted.
 */
export function turnOfCall(items: readonly TimelineItem[], callId: string): number {
  if (!callId) return 0;
  let n = 0;
  for (const t of buildTurns(items)) {
    if (t.user.length === 0 && t.end === "" && t.body.length === 1 && t.body[0]?.type === "system") continue;
    n++;
    if (t.body.some((b) => b.type === "tool" && b.id === callId)) return n;
  }
  return 0;
}

/** The prompt the parent gave the run: its Agent call's input `prompt` ("" when unreadable). */
export function agentPrompt(inputJson: string): string {
  try {
    const v: unknown = JSON.parse(inputJson);
    if (v && typeof v === "object" && "prompt" in v && typeof v.prompt === "string") return v.prompt;
  } catch {
    // not JSON: no prompt
  }
  return "";
}

/** Whether the report the run handed back is already its last text (shown once, as the text). */
export function reportIsLastText(summary: string, lastText: string): boolean {
  const s = summary.trim();
  return s !== "" && s === lastText.trim();
}

/** "1 tool", "23 tools". */
function toolsLabel(n: number): string {
  return `${String(n)} ${n === 1 ? "tool" : "tools"}`;
}

/**
 * The footer's parts: "Working for 4m 12s · 23 tools · 48.2K tokens · Opus 4.8" while it
 * runs, "Worked for 38s · …" once done (counters left out when Claude reported none); a
 * failed run's line is its error (the footer draws the cross). `model` is the display
 * name, "" to leave it out.
 */
export function footerParts(run: Pick<AgentRunView, "status" | "startedAtMs" | "resumedAtMs" | "endedAtMs" | "durationMs" | "toolUses" | "totalTokens" | "error">, model: string, now: number): string[] {
  if (run.status === "failed") return [run.error || "Failed"];
  const ms = agentElapsedMs(run, now);
  const running = run.status === "running";
  const parts = [ms === null ? (running ? "Working" : "Worked") : `${running ? "Working" : "Worked"} for ${fmtElapsed(ms)}`];
  if (run.toolUses > 0) parts.push(toolsLabel(run.toolUses));
  if (run.totalTokens > 0) parts.push(`${fmtTok(run.totalTokens)} tokens`);
  if (model) parts.push(model);
  return parts;
}
