/**
 * When the daemon's word about a page changed, so every File tab showing it reads its grant
 * again (usePreviewGrant), which carries who owns the page and the user's answer
 * (docs/notes/page-ownership-gui.md, page-access-live.md). Three things count:
 *
 * - the daemon's page source (EventService, applyPageEvent): a page's new owner or answer,
 *   from any window, the CLI or a thread; a removed thread, which its pages lost as an owner;
 *   and on (re)connect, every page;
 * - an answer given in this window (answerPage), at once, before the event comes;
 * - a call the daemon refused because the page may not use Code Foundry any more (the bridge
 *   host's `onStale`, which reads that tab's grant again itself).
 *
 * Allow and Don't allow in a File tab run page.allow and page.disallow, as any command runs.
 */
import { create } from "zustand";
import type { PageEventView } from "@/api/page";
import { runCommandForResult } from "./commands";

interface PageAnswersState {
  /** How many times each page (its resolved path) changed. */
  byPath: Readonly<Record<string, number>>;
  /** How many times each thread's pages lost it as an owner (it was removed). */
  byThread: Readonly<Record<string, number>>;
  /** How many times every page may have changed. */
  all: number;
}

export const usePageAnswers = create<PageAnswersState>()(() => ({ byPath: {}, byThread: {}, all: 0 }));

/**
 * The count a grant of the page at `path` owned by `owners` (none: no thread owns it) follows:
 * it grows whenever the daemon's word about that page may have changed.
 */
export function pageChanges(s: PageAnswersState, path: string, owners: readonly string[]): number {
  let n = s.all + (s.byPath[path] ?? 0);
  for (const o of owners) n += s.byThread[o] ?? 0;
  return n;
}

function bump(counts: Readonly<Record<string, number>>, keys: readonly string[]): Readonly<Record<string, number>> {
  const out = { ...counts };
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Counts an answer for the page at `path`: every grant of it is read again. */
export function pageAnswered(path: string): void {
  usePageAnswers.setState((s) => ({ byPath: bump(s.byPath, [path]) }));
}

/** The daemon's page source: the pages it names, a removed thread's, or all, are read again. */
export function applyPageEvent(ev: PageEventView): void {
  usePageAnswers.setState((s) => ({
    all: ev.all ? s.all + 1 : s.all,
    byPath: ev.paths.length > 0 ? bump(s.byPath, ev.paths) : s.byPath,
    byThread: ev.removedThread ? bump(s.byThread, [ev.removedThread]) : s.byThread,
  }));
}

/**
 * Allows the page at `path` (its resolved path, PageAccess.path) to use Code Foundry, or
 * stops allowing it: page.allow or page.disallow. A failure is toasted; true once it took.
 */
export async function answerPage(path: string, allow: boolean): Promise<boolean> {
  const res = await runCommandForResult(allow ? "page.allow" : "page.disallow", { path }, { inView: true });
  if (res === null) return false;
  pageAnswered(path);
  return true;
}
