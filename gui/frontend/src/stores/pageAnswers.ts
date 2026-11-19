/**
 * The user's answer for a page no thread owns (docs/notes/page-ownership-gui.md): Allow and
 * Don't allow in its File tab run page.allow and page.disallow, as any command runs, and every
 * File tab showing that page reads its grant again after it (usePreviewGrant), which carries
 * the new answer: the daemon sends no event when an answer changes.
 */
import { create } from "zustand";
import { runCommandForResult } from "./commands";

interface PageAnswersState {
  /** How many answers this window gave for each page (its resolved path). */
  byPath: Readonly<Record<string, number>>;
}

export const usePageAnswers = create<PageAnswersState>()(() => ({ byPath: {} }));

/** Counts an answer for the page at `path`: every grant of it is read again. */
export function pageAnswered(path: string): void {
  usePageAnswers.setState((s) => ({ byPath: { ...s.byPath, [path]: (s.byPath[path] ?? 0) + 1 } }));
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
