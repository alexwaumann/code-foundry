/**
 * The Find dialog's preview, the parts that are not components
 * (docs/notes/search-4-find-dialog.md): the match count and caption, and painting the
 * query's matches in the rendered message.
 */
import type { ThreadItemView } from "@/api/thread";
import { highlightsSupported, lineRects, paintAll, rangeOf } from "@/components/thread/cite/citeDom";
import { findText } from "@/components/thread/find/findDom";
import { findDoc } from "@/lib/threadFind";
import { currentMatchIndex, handoffMatches, handoffQuery, queryMatches } from "@/lib/threadSearch";

/** The attribute on the preview's painted texts: "hit" (the selected message: its matches count, one is current) or "context". */
export const DOC_ATTR = "data-search-doc";

/** What the preview shows: a hit (its message), or a thread whose name matched (its latest text from Claude). */
export interface PreviewSubject {
  kind: "hit" | "thread";
  threadId: string;
  threadName: string;
  archived: boolean;
  /** The hit's time, or the thread's last activity. */
  atMs: number | null;
  speaker?: "user" | "assistant" | "question";
}

/**
 * How many matches the thread's find bar will count in a message: the handed-over term's
 * only (lib/threadSearch handoffMatches), over the text the timeline renders (lib/threadFind
 * findDoc). The paint shows every term; the count is what the bar's "N of M" steps through.
 */
export function messageMatchCount(item: ThreadItemView, query: string): number {
  const doc = findDoc(item);
  return doc ? handoffMatches(doc.text, query).length : 0;
}

/** The footer caption under a hit: "3 matches of “term” · opening keeps it in the thread's find bar". */
export function previewCaption(count: number, query: string): string {
  const term = handoffQuery(query);
  if (term === "") return count === 1 ? "1 match" : `${String(count)} matches`;
  return `${count === 1 ? "1 match" : `${String(count)} matches`} of “${term}” · opening keeps it in the thread's find bar`;
}

/**
 * Paints the query's matches in the preview's texts: tinted, and in the selected message
 * the one the thread's find bar will make current solid (lib/threadSearch
 * currentMatchIndex), which is scrolled into view. The DOM's text is matched again, as the
 * snippet's ranges point into the snippet only.
 */
export function paintPreview(root: HTMLElement | null, query: string): void {
  const all: Range[] = [];
  const cur: Range[] = [];
  const allRects: DOMRect[] = [];
  const curRects: DOMRect[] = [];
  const overlay = !highlightsSupported();
  if (root && query !== "") {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${DOC_ATTR}]`))) {
      const pt = findText(el);
      const matches = queryMatches(pt.text, query);
      const current = el.getAttribute(DOC_ATTR) === "hit" ? currentMatchIndex(pt.text, matches, query) : -1;
      matches.forEach((m, i) => {
        const r = rangeOf(pt, m.start, m.end);
        if (!r) return;
        (i === current ? cur : all).push(r);
        if (overlay) (i === current ? curRects : allRects).push(...lineRects(pt, m.start, m.end));
      });
    }
  }
  paintAll("cf-search", all, allRects);
  paintAll("cf-search-current", cur, curRects);
  const first = cur[0];
  if (root && first) {
    const box = first.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) root.scrollTop += box.top - view.top - view.height / 2 + box.height / 2;
  }
}

/** Clears the preview's paint (the dialog closes). */
export function clearPreviewPaint(): void {
  paintAll("cf-search", []);
  paintAll("cf-search-current", []);
}
