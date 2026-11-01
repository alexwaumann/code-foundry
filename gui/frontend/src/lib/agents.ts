/**
 * Subagent runs' pure helpers (docs/notes/agents-2-gui.md): names, status words, elapsed
 * time, the strip's line above the composer, the daemon's "Agent finished · …" notes, and
 * structural sharing so a progress update re-renders only the row whose run changed.
 */
import type { AgentRunView } from "@/api/agents";
import { formatAgo } from "./thread";

/** The run's name: the Agent call's description, else its type. */
export function agentName(r: Pick<AgentRunView, "description" | "agentType">): string {
  return r.description || r.agentType || "Agent";
}

/** "foreground" or "background". */
export function agentMode(r: Pick<AgentRunView, "background">): string {
  return r.background ? "background" : "foreground";
}

/** "0s", "38s", "1m 03s", "4m 12s", "1h 05m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * How long the run ran: while running, from its start (or its last wake) to now; once
 * ended, Claude's duration, else its start to its end. Null when unknown.
 */
export function agentElapsedMs(r: Pick<AgentRunView, "status" | "startedAtMs" | "resumedAtMs" | "endedAtMs" | "durationMs">, now: number): number | null {
  if (r.status === "running") {
    const from = r.resumedAtMs ?? r.startedAtMs;
    return from !== null ? Math.max(0, now - from) : r.durationMs > 0 ? r.durationMs : null;
  }
  if (r.durationMs > 0) return r.durationMs;
  return r.startedAtMs !== null && r.endedAtMs !== null ? Math.max(0, r.endedAtMs - r.startedAtMs) : null;
}

const STATUS_WORD: Readonly<Record<AgentRunView["status"], string>> = { running: "Running", done: "Done", failed: "Failed", unknown: "Unknown" };

/** The right of the row's first line: "Running", "Done · 5 min ago", "Failed · just now". */
export function agentStatusText(r: Pick<AgentRunView, "status" | "endedAtMs">, now: number): string {
  const word = STATUS_WORD[r.status];
  if (r.status === "running" || r.endedAtMs === null) return word;
  return `${word} · ${formatAgo(r.endedAtMs, now)}`;
}

/**
 * "1 subagent", "3 subagents": the sidebar row's live count (lib/liveCount), background
 * subagent runs and live child threads alike; the user need not know which the model used.
 */
export function agentsLabel(n: number): string {
  return `${String(n)} ${n === 1 ? "subagent" : "subagents"}`;
}

/** The strip's sentence: "1 agent running in the background", "3 agents …"; "" when none runs. */
export function backgroundLabel(agents: number): string {
  return agents > 0 ? `${String(agents)} ${agents === 1 ? "agent" : "agents"} running in the background` : "";
}

/** The running background runs the strip names (the thread's own, spawn depth 1), in spawn order. */
export function stripRuns(runs: readonly AgentRunView[]): AgentRunView[] {
  return runs.filter((r) => r.status === "running" && r.background && r.spawnDepth <= 1);
}

/** The strip's muted line for a run: "name · activity" (the name alone before its first progress). */
export function stripPart(r: Pick<AgentRunView, "description" | "agentType" | "activity">): string {
  const name = agentName(r);
  return r.activity && r.activity !== name ? `${name} · ${r.activity}` : name;
}

/** Structural equality of two runs (every field). */
export function sameAgent(a: AgentRunView, b: AgentRunView): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof AgentRunView)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * `next` with the runs that did not change kept from `prev` by identity (a progress update
 * changes one run), and `prev` itself when nothing changed at all.
 */
export function shareAgents(prev: readonly AgentRunView[], next: readonly AgentRunView[]): readonly AgentRunView[] {
  if (prev === next) return prev;
  const byId = new Map(prev.map((r) => [r.id, r]));
  const runs = next.map((r) => {
    const old = byId.get(r.id);
    return old && sameAgent(old, r) ? old : r;
  });
  return runs.length === prev.length && runs.every((r, i) => r === prev[i]) ? prev : runs;
}

/** A note the daemon adds when a background run ends: "Agent finished · <name> · <report's first line>" or "Agent failed · <name> · <error>". */
export interface AgentNote {
  failed: boolean;
  name: string;
  /** The report's first line or the error; "" when the run said nothing. */
  summary: string;
}

const NOTE_HEADS: readonly [string, boolean][] = [
  ["Agent finished", false],
  ["Agent failed", true],
];

/**
 * The note's parts, or null for another note (a fork's "Forked from …"). The daemon writes
 * plain text joined with " · ", so a name with " · " in it splits wrongly unless `name`
 * (the linked run's description, when the run is known) says where it ends.
 */
export function parseAgentNote(text: string, name = ""): AgentNote | null {
  for (const [head, failed] of NOTE_HEADS) {
    const prefix = `${head} · `;
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length);
    if (name && (rest === name || rest.startsWith(`${name} · `))) return { failed, name, summary: rest.slice(name.length + 3) };
    const i = rest.indexOf(" · ");
    return i < 0 ? { failed, name: rest, summary: "" } : { failed, name: rest.slice(0, i), summary: rest.slice(i + 3) };
  }
  return null;
}
