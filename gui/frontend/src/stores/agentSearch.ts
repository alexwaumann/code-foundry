/**
 * The search dialog's Agent search actions (docs/notes/search-6-agent-gui.md). Each is a
 * command (internal/command search.*), except the start: search.agent waits for the run's
 * end, and the dialog needs the entry at once to watch it (api/search startAgentSearch).
 *
 * Enter on a hit opens its thread and reveals the quote with the citation layer's Go to
 * source (stores/cite requestFlash, held until the next click or key), once the thread's
 * log has the item: a thread not shown yet has no log until its Watch delivers one.
 */
import type { AgentHitView, SearchEntryView } from "@/api/search";
import { startAgentSearch } from "@/api/search";
import type { CitationBody } from "@/lib/citation";
import { requestFlash } from "./cite";
import { runCommandForResult } from "./commands";
import { setRowExpanded, useThreadStore } from "./thread";
import { useThreadsStore } from "./threads";
import { closeQuietly } from "./threadSearch";
import { useUiStore } from "./ui";

/** How long Enter waits for a hit's thread to load (its log) or a promoted thread to be listed. */
export const ARRIVAL_MS = 10_000;

/** Bookkeeping the dialog does on its own: no toast for its success or its failure (an older daemon). */
const BOOKKEEPING = { quiet: true, expected: () => true } as const;

/** Starts an agent search: the RUNNING entry. */
export function startAgent(question: string): Promise<SearchEntryView> {
  return startAgentSearch(question);
}

/** search.stop: the run ends STOPPED with the hits it has. A failure is toasted. */
export async function stopAgent(id: string): Promise<void> {
  await runCommandForResult("search.stop", { id }, { quiet: true });
}

/** search.forget (a Recent row's ×). */
export async function forgetSearch(id: string): Promise<boolean> {
  return (await runCommandForResult("search.forget", { id }, { quiet: true })) !== null;
}

/** search.clear, through its confirm (Recent searches' Clear). True when it ran. */
export async function clearSearches(): Promise<boolean> {
  return (await runCommandForResult("search.clear", {}, { quiet: true })) !== null;
}

/** search.seen: a finished result was shown. */
export function markSearchSeen(id: string): void {
  void runCommandForResult("search.seen", { id }, BOOKKEEPING);
}

/** search.find: a Find result was opened, with the query's result count. */
export function recordFind(query: string, hits: number): void {
  if (query.trim() === "") return;
  void runCommandForResult("search.find", { query, hits: String(hits) }, BOOKKEEPING);
}

/** Resolves true once `ready()` holds (checked on every change of `subscribe`'s store), false after `ms`. */
function when(ready: () => boolean, subscribe: (cb: () => void) => () => void, ms: number): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      stop();
      clearTimeout(timer);
      resolve(ok);
    };
    const stop = subscribe(() => {
      if (ready()) done(true);
    });
    const timer = setTimeout(() => {
      done(false);
    }, ms);
  });
}

/** Whether a thread's log (its Watch's) has the item. */
function logHas(threadId: string, itemId: string): boolean {
  return useThreadStore.getState().logs[threadId]?.byId[itemId] !== undefined;
}

/** The citation a hit's quote reveals as: no offsets or context, so locateQuote finds it by its words. */
export function hitCitation(hit: Pick<AgentHitView, "threadId" | "itemId" | "quote">): CitationBody {
  return { threadId: hit.threadId, itemId: hit.itemId, text: hit.quote, comment: "", start: -1, end: -1, prefix: "", suffix: "" };
}

/**
 * Reveals a hit's quote in its thread (already selected): once its log has the item, a
 * question's row is expanded (its answers hold the text) and the cite layer scrolls to the
 * quote, opens what folds it away and marks it. False when the item never arrived.
 */
export async function revealHit(hit: AgentHitView, ms = ARRIVAL_MS): Promise<boolean> {
  const ok = await when(() => logHas(hit.threadId, hit.itemId), (cb) => useThreadStore.subscribe(cb), ms);
  if (!ok) return false;
  if (hit.speaker === "question") setRowExpanded(hit.threadId, hit.itemId, true);
  requestFlash(hit.threadId, hitCitation(hit), { hold: true });
  return true;
}

/**
 * Enter on a hit: marks it opened (search.open-hit), closes the dialog, selects its thread
 * and reveals the quote there.
 */
export function openAgentHit(entryId: string, hit: AgentHitView): void {
  void runCommandForResult("search.open-hit", { id: entryId, hit: String(hit.n) }, BOOKKEEPING);
  closeQuietly();
  useUiStore.getState().select({ kind: "thread", id: hit.threadId });
  void revealHit(hit);
}

/** The thread id in search.promote's result (PromoteSearchResponse as JSON). */
export function promotedThreadId(resultJson: string): string {
  try {
    const v = JSON.parse(resultJson || "{}") as { threadId?: unknown; thread_id?: unknown };
    const id = v.threadId ?? v.thread_id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** Shows a thread with its prompt focused, once the thread list has it. */
async function showThread(threadId: string): Promise<void> {
  const listed = () => threadId in useThreadsStore.getState().byId;
  await when(listed, (cb) => useThreadsStore.subscribe(cb), ARRIVAL_MS);
  useUiStore.getState().select({ kind: "thread", id: threadId }, { focusPrompt: true });
}

/**
 * ⌘⏎: continues the search as a thread without a project (search.promote) and shows it.
 * Promoted already (its thread still listed): that thread, with no call. Promote is
 * idempotent too, so a second ⌘⏎ before the first answered gets the same thread.
 */
export async function promoteAgent(entry: Pick<SearchEntryView, "id" | "promotedThreadId">): Promise<boolean> {
  const existing = entry.promotedThreadId;
  if (existing && existing in useThreadsStore.getState().byId) {
    closeQuietly();
    await showThread(existing);
    return true;
  }
  const res = await runCommandForResult("search.promote", { id: entry.id }, { quiet: true });
  const id = res ? promotedThreadId(res.resultJson) : "";
  if (!id) return false;
  closeQuietly();
  await showThread(id);
  return true;
}
