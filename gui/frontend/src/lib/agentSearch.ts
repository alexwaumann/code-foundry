/**
 * The search dialog's Agent search, the parts that are not components
 * (docs/notes/search-6-agent-gui.md): folding Watch's events into the entry, the restore
 * rules, the selection after an opened hit, and the texts of rows and summary lines.
 */
import type { AgentHitView, AgentStepView, SearchEntryView, SearchWatchEventView } from "@/api/search";
import { formatUptime } from "./format";
import { relativeAge } from "./promptHistory";

/** How long after the dialog closes it reopens as it was; after that it opens on Recent searches. Fixed, not a setting. */
export const RESTORE_MS = 3 * 60_000;

/** The dialog's two modes. */
export type SearchModeId = "agent" | "find";
export const SEARCH_MODE_IDS: readonly SearchModeId[] = ["agent", "find"];

/**
 * Folds a Watch event into the entry. A snapshot replaces it unless it is older than what
 * is shown (a resync after a dropped event, or a change only a snapshot says: opened,
 * seen, promoted); a change applies when it is newer than the entry: a step is an upsert
 * by index, a hit is added by its n, the answer and the status set their fields. Before a
 * snapshot nothing applies a change (there is nothing to change).
 */
export function reduceSearch(entry: SearchEntryView | null, ev: SearchWatchEventView): SearchEntryView | null {
  if (ev.kind === "snapshot") return entry && ev.version < entry.version ? entry : ev.entry;
  if (!entry || ev.version <= entry.version) return entry;
  const version = ev.version;
  switch (ev.kind) {
    case "step": {
      const steps = entry.steps.some((s) => s.index === ev.step.index) ? entry.steps.map((s) => (s.index === ev.step.index ? ev.step : s)) : [...entry.steps, ev.step].sort((a, b) => a.index - b.index);
      return { ...entry, version, steps, searches: steps.filter((s) => s.kind === "search").length, threadsRead: readCount(steps, entry.threadsRead) };
    }
    case "hit":
      if (entry.hits.some((h) => h.n === ev.hit.n)) return { ...entry, version };
      return { ...entry, version, hits: [...entry.hits, ev.hit].sort((a, b) => a.n - b.n) };
    case "answer":
      return { ...entry, version, answer: ev.text };
    case "status":
      return { ...entry, version, status: ev.status, error: ev.error, finishedAtMs: ev.finishedAtMs, costUsd: ev.costUsd, durationMs: ev.durationMs, unseen: ev.unseen };
  }
}

/** Distinct threads read: steps name threads by name only, so the snapshot's count is kept when it is higher. */
function readCount(steps: readonly AgentStepView[], known: number): number {
  const names = new Set(steps.filter((s) => s.kind === "read" && s.threadName !== "").map((s) => s.threadName));
  return Math.max(known, names.size);
}

/** Whether a search has ended (DONE, FAILED or STOPPED). */
export function searchEnded(e: Pick<SearchEntryView, "status">): boolean {
  return e.status !== "running";
}

/** What the dialog keeps of its last open, to restore when it opens again within RESTORE_MS. */
export interface SearchSession {
  mode: SearchModeId;
  query: string;
  /** The agent search shown; null for none (Find, or the empty state). */
  entryId: string | null;
  /** The selected hit's n (agent results). */
  selectedN: number | null;
  /** The hit Enter opened last; the selection moves on from it on restore. */
  openedN: number | null;
  /** The results' scroll offset. */
  scrollTop: number;
  closedAtMs: number;
}

/** The session to restore when the dialog opens at `now`: the last one within RESTORE_MS, else null. */
export function sessionToRestore(s: SearchSession | null, now: number): SearchSession | null {
  if (!s) return null;
  const age = now - s.closedAtMs;
  return age >= 0 && age < RESTORE_MS ? s : null;
}

/**
 * The finished agent search to restore whatever the timer: the newest whose result the
 * dialog has not shown (unseen); null for none.
 */
export function unseenToRestore(recent: readonly SearchEntryView[]): SearchEntryView | null {
  return recent.find((e) => e.mode === "agent" && e.unseen && searchEnded(e)) ?? null;
}

/**
 * The hit selected on restore: the next unopened hit after the one opened (wrapping to the
 * first unopened one), else the opened one's next, else the first. Without an opened hit,
 * the one selected before (when it is still there), else the first unopened one.
 */
export function restoreSelection(hits: readonly Pick<AgentHitView, "n" | "opened">[], openedN: number | null, selectedN: number | null = null): number | null {
  if (hits.length === 0) return null;
  if (openedN === null) {
    if (selectedN !== null && hits.some((h) => h.n === selectedN)) return selectedN;
    return (hits.find((h) => !h.opened) ?? hits[0])?.n ?? null;
  }
  const after = hits.filter((h) => h.n > openedN);
  const next = after.find((h) => !h.opened) ?? hits.find((h) => !h.opened && h.n !== openedN) ?? after[0] ?? hits[0];
  return next?.n ?? null;
}

/** ↑/↓ over hits: the next or previous n, wrapping; the first for none selected. */
export function moveHit(hits: readonly Pick<AgentHitView, "n">[], cur: number | null, dir: 1 | -1): number | null {
  if (hits.length === 0) return null;
  const i = hits.findIndex((h) => h.n === cur);
  if (i < 0) return hits[dir === 1 ? 0 : hits.length - 1]?.n ?? null;
  return hits[(i + dir + hits.length) % hits.length]?.n ?? null;
}

/** A piece of the answer: plain text, or a reference to hit n ("[n]"). */
export type AnswerPiece = { kind: "text"; text: string } | { kind: "ref"; n: number };

/**
 * The answer as text and its [n] references ("[1]", "[1][2]", "[1, 2]"), for small
 * numbered markers. Everything else stays text: the answer is the model's, never markdown.
 */
export function answerPieces(answer: string): AnswerPiece[] {
  const out: AnswerPiece[] = [];
  const re = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
  let at = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    if (m.index > at) out.push({ kind: "text", text: answer.slice(at, m.index) });
    for (const n of (m[1] ?? "").split(",")) out.push({ kind: "ref", n: Number(n.trim()) });
    at = m.index + m[0].length;
  }
  if (at < answer.length) out.push({ kind: "text", text: answer.slice(at) });
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** A run's time: "21s", "1m 4s". */
export function tookLabel(ms: number): string {
  return formatUptime(Math.round(ms / 1000));
}

/** The line under the answer: "2 searches · read 3 threads · 21s". */
export function summaryLine(e: Pick<SearchEntryView, "searches" | "threadsRead" | "durationMs">): string {
  const parts = [plural(e.searches, "search", "searches"), `read ${plural(e.threadsRead, "thread")}`];
  if (e.durationMs > 0) parts.push(tookLabel(e.durationMs));
  return parts.join(" · ");
}

/** A Recent searches row's right side: "3 results · 1h" (agent), "14 hits · yesterday" (Find), "running · now". */
export function recentMeta(e: SearchEntryView, now: number): string {
  const age = relativeAge(e.createdAtMs, now);
  if (e.mode === "find") return e.findHits > 0 ? `${plural(e.findHits, "hit")} · ${age}` : age;
  if (e.status === "running") return `running · ${age}`;
  const n = e.hits.length;
  const what = n > 0 ? plural(n, "result") : e.status === "failed" ? "failed" : e.status === "stopped" ? "stopped" : "no results";
  return `${what} · ${age}`;
}

/** A Find result's count for the history: thread names and message hits. */
export function findHitCount(r: { threads: readonly unknown[]; totalHits: number } | null): number {
  return r ? r.threads.length + r.totalHits : 0;
}

/** How a search that did not finish says so above its results. */
export function endedNote(e: Pick<SearchEntryView, "status" | "error" | "hits">): string {
  if (e.status === "failed") return `Agent search failed: ${(e.error || "it ended without an answer").replace(/[.\s]+$/, "")}.`;
  if (e.status === "stopped") return e.hits.length > 0 ? `Stopped. ${plural(e.hits.length, "result")} found before it stopped.` : "Stopped before it found anything.";
  if (e.status === "done" && e.hits.length === 0) return "No messages answer it.";
  return "";
}

/** The model in the footer: "claude-sonnet-5-5[1m]" through the registry's labels ("Sonnet 5.5"). */
export function footerModel(model: string, name: (id: string) => string): string {
  const m = model.trim();
  return m ? `Utility model · ${name(m)} · low` : "Utility model · low";
}
