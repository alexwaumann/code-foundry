/**
 * The Find dialog's preview, the parts that are not components
 * (docs/notes/search-4-find-dialog.md): the match count and caption, and painting the
 * query's matches in the rendered message.
 */
import type { ThreadItemView } from "@/api/thread";
import { highlightsSupported, lineRects, paintAll, rangeOf } from "@/components/thread/cite/citeDom";
import { findText } from "@/components/thread/find/findDom";
import { locateQuote } from "@/lib/citation";
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

/**
 * Marks an agent search hit's quote in the preview's message as a citation is marked
 * (cf-search-quote, the cite layer's cf-cite-mark look), found in the rendered text with
 * the citation layer's locateQuote (white space aside), and scrolls it into view.
 */
export function paintQuote(root: HTMLElement | null, quote: string): void {
  const ranges: Range[] = [];
  const rects: DOMRect[] = [];
  const overlay = !highlightsSupported();
  const el = root?.querySelector<HTMLElement>(`[${DOC_ATTR}="hit"]`);
  if (el && quote.trim() !== "") {
    const pt = findText(el);
    const at = locateQuote(pt.text, { text: quote, start: -1, end: -1, prefix: "", suffix: "" });
    const r = at && rangeOf(pt, at.start, at.end);
    if (at && r) {
      ranges.push(r);
      if (overlay) rects.push(...lineRects(pt, at.start, at.end));
    }
  }
  paintAll("cf-search-quote", ranges, rects);
  const first = ranges[0];
  if (root && first) {
    const box = first.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) root.scrollTop += box.top - view.top - Math.min(view.height / 3, 80);
  }
}

/** Clears the preview's paint (the dialog closes). */
export function clearPreviewPaint(): void {
  paintAll("cf-search", []);
  paintAll("cf-search-current", []);
  paintAll("cf-search-quote", []);
}
