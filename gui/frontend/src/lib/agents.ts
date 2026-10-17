/**
 * The Agents surface's pure helpers (docs/notes/agents-2-gui.md, docs/sketches/agents-panel
 * variant L1): the list's order and nesting, names, meta and status words, elapsed time,
 * the header's counts, the strip's line, the daemon's "Agent finished · …" notes, and
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

/** The row's second line: type · model · effort · foreground|background (empty parts left out; no model: the thread's). */
export function agentMeta(r: Pick<AgentRunView, "agentType" | "model" | "effort" | "background">): string[] {
  return [r.agentType, r.model, r.effort, agentMode(r)].filter((p) => p !== "");
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

/** The header's figures: running runs (nested ones too, like Session.agents_running and the CLI), all runs, and the thread's own running background runs. */
export function agentCounts(runs: readonly AgentRunView[]): { running: number; total: number; background: number } {
  let running = 0;
  let background = 0;
  for (const r of runs) {
    if (r.status !== "running") continue;
    running++;
    if (r.background && r.spawnDepth <= 1) background++;
  }
  return { running, total: runs.length, background };
}

/** "1 agent", "3 agents". */
export function agentsLabel(n: number): string {
  return `${String(n)} ${n === 1 ? "agent" : "agents"}`;
}

/** "1 shell", "3 shells". */
export function shellsLabel(n: number): string {
  return `${String(n)} ${n === 1 ? "shell" : "shells"}`;
}

/**
 * The strip's sentence: "2 agents and 1 shell running in the background", "1 agent …",
 * "2 shells …"; "" when nothing runs.
 */
export function backgroundLabel(agents: number, shells: number): string {
  const parts = [...(agents > 0 ? [agentsLabel(agents)] : []), ...(shells > 0 ? [shellsLabel(shells)] : [])];
  return parts.length === 0 ? "" : `${parts.join(" and ")} running in the background`;
}

/** The header's second line: why runs keep going after the turn, or that none run. */
export function agentsSubline(c: { running: number; background: number }): string {
  if (c.background > 0) return `${String(c.background)} in the background ${c.background === 1 ? "keeps" : "keep"} running after the turn ends`;
  if (c.running > 0) return `${String(c.running)} in the foreground, part of the turn`;
  return "No agents running";
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

/**
 * The list's rows in order: the runs in spawn order (never by status), each run's nested
 * runs right under it (in spawn order among themselves), with their nesting level (0 for
 * the thread's own). A run whose parent is not in the list stays where it started, at the
 * level its spawn depth says.
 */
export function agentRows(runs: readonly Pick<AgentRunView, "id" | "parentId" | "spawnDepth">[]): { id: string; level: number }[] {
  const ids = new Set(runs.map((r) => r.id));
  const kids = new Map<string, string[]>();
  const roots: { id: string; level: number }[] = [];
  for (const r of runs) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
      const list = kids.get(r.parentId) ?? [];
      list.push(r.id);
      kids.set(r.parentId, list);
    } else roots.push({ id: r.id, level: Math.max(0, r.spawnDepth - 1) });
  }
  const out: { id: string; level: number }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, level: number) => {
    if (seen.has(id)) return; // a cycle (never from the daemon): each run once
    seen.add(id);
    out.push({ id, level });
    for (const k of kids.get(id) ?? []) walk(k, level + 1);
  };
  for (const r of roots) walk(r.id, r.level);
  // Runs only reachable through a cycle: at the end, flat.
  for (const r of runs) if (!seen.has(r.id)) walk(r.id, 0);
  return out;
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
