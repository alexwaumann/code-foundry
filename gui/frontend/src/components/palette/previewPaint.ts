/**
 * The Text mode's preview, the parts that are not components
 * (docs/notes/file-search-5-text-mode.md): whether the read file can show the selected
 * match or the row's own line stands in for it, and painting the query's matches on the
 * code @pierre/diffs renders (every match tinted, the selected one solid) with the Custom
 * Highlight API under the preview's own names, so they never fight a File tab's find.
 */
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import type { TextLineView } from "@/api/textSearch";
import type { TextRange } from "@/api/threadSearch";
import { lineCount, formatSize } from "@/components/files/fileKind";
import { revealSideways } from "@/components/files/useFileFind";
import { paintAll, plainText, rangeOf } from "@/components/thread/cite/citeDom";
import { paintedMatches } from "@/lib/fileFind";
import { matchRanges } from "@/lib/textSearch";
import { zoomFactor } from "@/lib/zoom";
import type { PreviewRead } from "./useTextSearch";

/** The preview's body: the file as code around the line, or the row's line alone with why. */
export type PreviewView = { kind: "code"; text: string; lines: number } | { kind: "line"; note: string };

/** The line of a file's text (1-based), without its line break; undefined past the end. */
function lineAt(text: string, line: number): string | undefined {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) return undefined;
    start = nl + 1;
  }
  if (start > text.length) return undefined;
  const nl = text.indexOf("\n", start);
  const s = text.slice(start, nl < 0 ? undefined : nl);
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * What the preview shows for a match: the file as code when its read holds the match's line
 * as the search found it; otherwise the row's own line with a quiet note, never an error
 * wall: the read failed, the file is gone, is no text (binary, a folder), was cut by the
 * reader's 1 MiB before the line, or changed since the search (the line no longer holds
 * the text the search found there).
 */
export function previewView(read: PreviewRead, match: Pick<TextLineView, "line" | "text">): PreviewView {
  const f = read.file;
  if (read.error !== null || !f) return { kind: "line", note: `Cannot read the file: ${read.error ?? "no answer"}` };
  if (f.notFound) return { kind: "line", note: "The file is gone since the search." };
  if (f.isDir || f.text === null) return { kind: "line", note: f.isDir ? "This is a folder now." : `Cannot show this file (${formatSize(f.size)}, not text).` };
  const text = f.text;
  const line = lineAt(text, match.line);
  // The reader's last line is cut short with the file: past it the line is not all there.
  const cut = f.truncated && (line === undefined || lineAt(text, match.line + 1) === undefined);
  if (cut) return { kind: "line", note: `The file is ${formatSize(f.size)}: the preview reads its first 1 MiB, which ends before this line.` };
  if (line === undefined || !line.includes(match.text)) return { kind: "line", note: "The file changed since the search: its line no longer reads like this." };
  return { kind: "code", text, lines: lineCount(text) };
}

/** The ranges of the match a row selects, in its whole line: the row's first range, moved by where the row's (maybe cut) text sits in the line. */
function selectedStart(lineText: string, match: Pick<TextLineView, "text" | "ranges">): number {
  const at = lineText.indexOf(match.text);
  const first = match.ranges[0];
  return at < 0 || !first ? -1 : at + first.start;
}

export const PREVIEW_HIGHLIGHT = "cf-text-search";
export const PREVIEW_CURRENT_HIGHLIGHT = "cf-text-search-current";

/**
 * Paints the code's rendered lines under `root` (a CodeBody): the matches of `re` tinted
 * (bounded per line, lib/fileFind paintedMatches), and on the selected line the row's match
 * solid. Without `re` (a regex JavaScript cannot
 * compile) only the selected line is painted, from the daemon's ranges. Returns the solid
 * match's range (null while its line is not rendered, or too long to paint).
 */
export function paintTextPreview(root: HTMLElement | null, re: RegExp | null, match: Pick<TextLineView, "line" | "text" | "ranges">): Range | null {
  const all: Range[] = [];
  const cur: Range[] = [];
  const shadow = root?.querySelector(DIFFS_TAG_NAME)?.shadowRoot ?? null;
  for (const el of Array.from(shadow?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [])) {
    const n = Number(el.dataset.line);
    const pt = plainText(el);
    const selected = n === match.line;
    let spans: TextRange[] = re ? matchRanges(re, pt.text) : [];
    const start = selected ? selectedStart(pt.text, match) : -1;
    if (selected && start >= 0 && !spans.some((s) => s.start === start)) {
      const at = pt.text.indexOf(match.text);
      spans = match.ranges.map((r) => ({ start: r.start + at, end: r.end + at }));
    }
    const solid = selected ? Math.max(0, spans.findIndex((s) => s.start === start)) : -1;
    for (const i of paintedMatches(pt.text.length, spans.length, solid)) {
      const s = spans[i];
      const r = s ? rangeOf(pt, s.start, s.end) : null;
      if (r) (i === solid ? cur : all).push(r);
    }
  }
  paintAll(PREVIEW_HIGHLIGHT, all);
  paintAll(PREVIEW_CURRENT_HIGHLIGHT, cur);
  return cur[0] ?? null;
}

/** Clears the preview's paint (the selection leaves the code, the finder closes). */
export function clearTextPreviewPaint(): void {
  paintAll(PREVIEW_HIGHLIGHT, []);
  paintAll(PREVIEW_CURRENT_HIGHLIGHT, []);
}

/** Brings the solid match into view sideways (CodeBody has scrolled to its line), past the sticky line numbers. */
export function revealMatch(root: HTMLElement | null, range: Range): void {
  const box = root?.querySelector<HTMLElement>('[data-testid="file-code"]');
  if (!box) return;
  const scroller = box.dataset.virtual !== undefined ? box.firstElementChild : box;
  if (!scroller) return;
  const gutter = (root?.querySelector(DIFFS_TAG_NAME)?.shadowRoot?.querySelector("[data-gutter]")?.getBoundingClientRect().width ?? 0) / zoomFactor();
  revealSideways(range, scroller, gutter);
}
