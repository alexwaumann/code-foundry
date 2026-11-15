import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { zoomFactor } from "@/lib/zoom";
import { topLineCorrection, topLineOf, type LineRow, type TopLine } from "./topLine";

/** How long after a width change the top line is put back while the library lays the rows out again. */
const RESTORE_MS = 600;
/** Frames in a row with the line in place before the restore ends early. */
const STABLE_FRAMES = 3;

/**
 * How a code box's rows are known. A file's by its line number (`data-line`); a diff's by its row
 * index (`data-line-index`, "unified,split": its first part), since a diff's line numbers repeat (an
 * old and a new line 10).
 */
export type TopLineRows = "line" | "index";

function keyOf(el: HTMLElement, rows: TopLineRows): number {
  return rows === "line" ? Number(el.dataset.line) : Number((el.dataset.lineIndex ?? "").split(",")[0]);
}

function rowOf(el: HTMLElement, rows: TopLineRows): LineRow {
  const r = el.getBoundingClientRect();
  return { line: keyOf(el, rows), top: r.top, height: r.height };
}

/** The selector of the row whose key is `key`. */
function rowSelector(key: number, rows: TopLineRows): string {
  const k = String(key);
  return rows === "line" ? `[data-content] [data-line="${k}"]` : `[data-content] [data-line][data-line-index^="${k},"]`;
}

/**
 * Keeps the line at the top of a code box where it was when the box's width changes (topLine.ts):
 * the line on top is noted after each scroll, and after a width change it is scrolled back into
 * its place each frame until it stays there. A scroll by the user (wheel, key, press) ends that.
 * `virtual`: the scroller is the box's first child (CodeScroll), not the box. `rows`: a file's
 * lines or a diff's rows (TopLineRows). `view`: a change of it is kept the same way: the File
 * tab's editor turning on or off, or its document starting over, re-renders the library's rows,
 * and a short file's box, empty for a moment, drops its scrollTop to 0
 * (docs/notes/file-edit-keep-place.md).
 */
export function useKeepTopLine(box: RefObject<HTMLDivElement | null>, virtual: boolean, rows: TopLineRows = "line", view?: string): void {
  const keep = useRef<(() => void) | null>(null);
  // A layout effect: it runs in the commit that re-rendered the rows, before the scroll event
  // that would note line 1 as the top.
  const seen = useRef(view);
  useLayoutEffect(() => {
    if (seen.current === view) return;
    seen.current = view;
    keep.current?.();
  }, [view]);
  useEffect(() => {
    const el = box.current;
    const root = virtual ? (el?.firstElementChild as HTMLElement | null | undefined) : el;
    if (!root) return;
    const shadow = () => root.querySelector(DIFFS_TAG_NAME)?.shadowRoot ?? null;
    let anchor: TopLine | null = null;
    let width = root.clientWidth;
    let until = 0;
    let stable = 0;
    let noted = 0;
    let restoring = 0;

    // Rows come in line order: read rects only down to the first that shows.
    const note = () => {
      noted = 0;
      const rect = root.getBoundingClientRect();
      const seen: LineRow[] = [];
      for (const r of shadow()?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? []) {
        const row = rowOf(r, rows);
        seen.push(row);
        if (row.height > 0 && row.top + row.height > rect.top + 1) break;
      }
      anchor = topLineOf(seen, rect.top, rect.bottom, zoomFactor()) ?? anchor;
    };
    const stop = () => {
      if (restoring) cancelAnimationFrame(restoring);
      restoring = 0;
    };
    const restore = () => {
      restoring = 0;
      const a = anchor;
      if (!a || performance.now() > until) {
        note();
        return;
      }
      const row = shadow()?.querySelector<HTMLElement>(rowSelector(a.line, rows));
      const delta = row ? topLineCorrection(a, [rowOf(row, rows)], root.getBoundingClientRect().top, zoomFactor()) : null;
      if (delta === 0) stable++;
      else stable = 0;
      if (delta) root.scrollTop += delta;
      if (stable >= STABLE_FRAMES) {
        note();
        return;
      }
      restoring = requestAnimationFrame(restore);
    };
    const onScroll = () => {
      if (restoring || noted) return;
      noted = requestAnimationFrame(note);
    };
    const onUser = () => {
      stop();
    };
    const hold = () => {
      if (!anchor) return;
      if (noted) cancelAnimationFrame(noted);
      noted = 0;
      until = performance.now() + RESTORE_MS;
      stable = 0;
      stop();
      restoring = requestAnimationFrame(restore);
    };
    keep.current = hold;
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth;
      if (w === width) return;
      width = w;
      hold();
    });
    ro.observe(root);
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) root.addEventListener(ev, onUser, { passive: true });
    return () => {
      keep.current = null;
      ro.disconnect();
      stop();
      if (noted) cancelAnimationFrame(noted);
      root.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) root.removeEventListener(ev, onUser);
    };
  }, [box, virtual, rows]);
}
