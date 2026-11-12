import { useEffect, type RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { zoomFactor } from "@/lib/zoom";
import { topLineCorrection, topLineOf, type LineRow, type TopLine } from "./topLine";

/** How long after a width change the top line is put back while the library lays the rows out again. */
const RESTORE_MS = 600;
/** Frames in a row with the line in place before the restore ends early. */
const STABLE_FRAMES = 3;

function rowOf(el: HTMLElement): LineRow {
  const r = el.getBoundingClientRect();
  return { line: Number(el.dataset.line), top: r.top, height: r.height };
}

/**
 * Keeps the line at the top of a code box where it was when the box's width changes (topLine.ts):
 * the line on top is noted after each scroll, and after a width change it is scrolled back into
 * its place each frame until it stays there. A scroll by the user (wheel, key, press) ends that.
 * `virtual`: the scroller is the box's first child (CodeScroll), not the box.
 */
export function useKeepTopLine(box: RefObject<HTMLDivElement | null>, virtual: boolean): void {
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
      const rows: LineRow[] = [];
      for (const r of shadow()?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? []) {
        const row = rowOf(r);
        rows.push(row);
        if (row.height > 0 && row.top + row.height > rect.top + 1) break;
      }
      anchor = topLineOf(rows, rect.top, rect.bottom, zoomFactor()) ?? anchor;
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
      const row = shadow()?.querySelector<HTMLElement>(`[data-content] [data-line="${String(a.line)}"]`);
      const delta = row ? topLineCorrection(a, [rowOf(row)], root.getBoundingClientRect().top, zoomFactor()) : null;
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
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth;
      if (w === width) return;
      width = w;
      if (!anchor) return;
      if (noted) cancelAnimationFrame(noted);
      noted = 0;
      until = performance.now() + RESTORE_MS;
      stable = 0;
      stop();
      restoring = requestAnimationFrame(restore);
    });
    ro.observe(root);
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) root.addEventListener(ev, onUser, { passive: true });
    return () => {
      ro.disconnect();
      stop();
      if (noted) cancelAnimationFrame(noted);
      root.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) root.removeEventListener(ev, onUser);
    };
  }, [box, virtual]);
}
