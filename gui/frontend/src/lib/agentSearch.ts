/**
 * The search dialog's Agent search, the parts that are not components
 * (docs/notes/search-6-agent-gui.md): folding Watch's events into the entry, the restore
 * rules, the selection after an opened hit, and the texts of rows and summary lines.
 */
import type { AgentHitView, AgentStepView, SearchEntryView, SearchWatchEventView } from "@/api/search";
import { answerPieces, withoutRefs } from "./answerMarkdown";
import { formatUptime } from "./format";
import { markdownText } from "./markdownText";
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
  /** The selected row (agent results): a hit's n or ANSWER_ROW; null while a run's selection is only the first hit so far. */
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

/** The cue a restored dialog shows for finished searches it has not shown (unseen): the newest, and how many more. */
export interface UnseenCue {
  entry: SearchEntryView;
  more: number;
}

/** The unseen finished agent searches other than the one shown (`shownId`): the newest and the count of the rest; null for none. */
export function unseenCue(recent: readonly SearchEntryView[] | null, shownId: string | null): UnseenCue | null {
  const all = (recent ?? []).filter((e) => e.mode === "agent" && e.unseen && searchEnded(e) && e.id !== shownId);
  const entry = all[0];
  return entry ? { entry, more: all.length - 1 } : null;
}

/** The Answer row's place in the selection: a hit's n starts at 1, so selectedN says which row with one number. */
export const ANSWER_ROW = 0;

/** A selectable row of the results: the Answer row or a hit. */
export type ResultRow = Pick<AgentHitView, "n" | "opened">;

/** Whether the results start with the Answer row: an ended search with an answer. While it runs, only hits. */
export function hasAnswerRow(e: Pick<SearchEntryView, "status" | "answer">): boolean {
  return searchEnded(e) && e.answer.trim() !== "";
}

/** The rows ↑/↓ move over, top to bottom. */
export function resultRows(e: Pick<SearchEntryView, "status" | "answer" | "hits">): readonly ResultRow[] {
  return hasAnswerRow(e) ? [{ n: ANSWER_ROW, opened: false }, ...e.hits] : e.hits;
}

/** The row selected as the rows change: the Answer row once there is one, unless the user picked a row; else the same row, else the first. */
export function defaultSelection(rows: readonly Pick<ResultRow, "n">[], cur: number | null, picked: boolean): number | null {
  if (!picked && rows[0]?.n === ANSWER_ROW) return ANSWER_ROW;
  return cur !== null && rows.some((r) => r.n === cur) ? cur : (rows[0]?.n ?? null);
}

/**
 * The row selected on restore, over resultRows: the Answer row when it was selected last;
 * after an opened hit, the next unopened hit (wrapping to the first unopened one), else
 * the opened one's next, else the first row. With nothing opened, the row selected before
 * (when it is still there), else the first unopened row, which is the Answer row when
 * there is one.
 */
export function restoreSelection(rows: readonly ResultRow[], openedN: number | null, selectedN: number | null = null): number | null {
  if (rows.length === 0) return null;
  if (selectedN === ANSWER_ROW && rows[0]?.n === ANSWER_ROW) return ANSWER_ROW;
  if (openedN === null) {
    if (selectedN !== null && rows.some((r) => r.n === selectedN)) return selectedN;
    return (rows.find((r) => !r.opened) ?? rows[0])?.n ?? null;
  }
  const hits = rows.filter((r) => r.n !== ANSWER_ROW);
  const after = hits.filter((h) => h.n > openedN);
  const next = after.find((h) => !h.opened) ?? hits.find((h) => !h.opened && h.n !== openedN) ?? after[0] ?? rows[0];
  return next?.n ?? null;
}

/**
 * The selection a search opens on when no earlier selection of it is kept (Recent, the
 * unseen cue, the sidebar's search row): its first row, the Answer row when it has one. A
 * running search has none yet: its first hit is no choice, so its end still selects the
 * Answer row.
 */
export function openingSelection(e: Pick<SearchEntryView, "status" | "answer" | "hits">): number | null {
  return searchEnded(e) ? restoreSelection(resultRows(e), null) : null;
}

/** ↑/↓ over the rows: the next or previous n, wrapping; the first for none selected. */
export function moveHit(rows: readonly Pick<ResultRow, "n">[], cur: number | null, dir: 1 | -1): number | null {
  if (rows.length === 0) return null;
  const i = rows.findIndex((r) => r.n === cur);
  if (i < 0) return rows[dir === 1 ? 0 : rows.length - 1]?.n ?? null;
  return rows[(i + dir + rows.length) % rows.length]?.n ?? null;
}

/** The Answer row's text: the answer as it reads rendered, on one line, without its [n] references (the row clamps it). */
export function answerPreview(answer: string): string {
  return withoutRefs(markdownText(answer)).replace(/\s+/g, " ").trim();
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
  return `${resultsWord(e)} · ${age}`;
}

/** An ended agent search's outcome in a word or two: "3 results", "failed", "stopped", "no results". */
export function resultsWord(e: Pick<SearchEntryView, "status" | "hits">): string {
  const n = e.hits.length;
  return n > 0 ? plural(n, "result") : e.status === "failed" ? "failed" : e.status === "stopped" ? "stopped" : "no results";
}

/** A Find result's count for the history: thread names and message hits. */
export function findHitCount(r: { threads: readonly unknown[]; totalHits: number } | null): number {
  return r ? r.threads.length + r.totalHits : 0;
}

/** How a search that did not finish says so above its results. */
export function endedNote(e: Pick<SearchEntryView, "status" | "error" | "hits" | "answer">): string {
  if (e.status === "failed") return `Agent search failed: ${(e.error || "it ended without an answer").replace(/[.\s]+$/, "")}.`;
  if (e.status === "stopped") return e.hits.length > 0 ? `Stopped. ${plural(e.hits.length, "result")} found before it stopped.` : "Stopped before it found anything.";
  if (e.status === "done" && e.hits.length === 0) {
    if (e.answer.trim() === "") return "No messages answer it.";
    // Its citations point at nothing (it reported none, or none was accepted).
    if (answerPieces(e.answer).some((p) => p.kind === "ref")) return "It reported no messages to open.";
  }
  return "";
}

/** The model in the footer: "claude-sonnet-5-5[1m]" through the registry's labels ("Sonnet 5.5"). */
export function footerModel(model: string, name: (id: string) => string): string {
  const m = model.trim();
  return m ? `Utility model · ${name(m)} · low` : "Utility model · low";
}
