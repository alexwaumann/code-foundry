import type { PageOf } from "./usePageThread";

/**
 * What the File tab's footer leads with about Code Foundry: what the page in it may do, in
 * every state (docs/notes/page-ownership-gui.md, pages-tab-polish.md). `owner`: the thread is
 * named after the text (a page owned by a thread other than the tab's); `strong`: the page can
 * use Code Foundry or is asking to, so the text is in the text colour, not the footer's.
 *
 * - a page acting for the tab's own thread (owned, or an older daemon's rule): "Can use Code
 *   Foundry for this thread"
 * - for another thread: "Can use Code Foundry for" and its name
 * - no thread, allowed: "Can use Code Foundry"
 * - no thread, the band asking: "Asking to use Code Foundry"
 * - no thread, refused: "Not allowed to use Code Foundry"
 * - anything else (a page not asked about that never loaded the bridge, a file that is no page,
 *   a page with no thread from an older daemon): "Sandboxed from Code Foundry"
 */
export function pageFooterLead(page: Pick<PageOf, "thread" | "actsFor" | "access">, asking: boolean): { text: string; owner: boolean; strong: boolean } {
  if (page.thread) return page.actsFor ? { text: "Can use Code Foundry for", owner: true, strong: true } : { text: "Can use Code Foundry for this thread", owner: false, strong: true };
  const consent = page.access?.consent;
  if (consent === "allowed") return { text: "Can use Code Foundry", owner: false, strong: true };
  if (asking) return { text: "Asking to use Code Foundry", owner: false, strong: true };
  if (consent === "refused") return { text: "Not allowed to use Code Foundry", owner: false, strong: false };
  return { text: "Sandboxed from Code Foundry", owner: false, strong: false };
}
