import { useEffect, useMemo, useRef, type RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { CodeFile, type CodeFileEdit } from "@/components/code/CodeFile";
import { CodeScroll } from "@/components/code/CodeDiff";
import { zoomFactor } from "@/lib/zoom";
import { useCodeFind } from "./useFileFind";
import { useKeepTopLine } from "./useKeepTopLine";

/** Above this many lines the file lays out only its visible lines (the library's virtualizer). */
export const VIRTUALIZE_LINES = 400;
/** components/code/code.css --diffs-line-height. */
const LINE_H = 19;
/** How long to wait for the library to render the line (theme and grammar load first). */
const SCROLL_WAIT_MS = 3000;

/**
 * Scrolls the line into view, a third down the box, once the library has rendered it. A
 * virtualized file renders only what is near the viewport, so the box first jumps to where
 * the line would be with unwrapped lines, which makes the library render it, then lands on
 * the rendered row.
 */
function useScrollToLine(box: RefObject<HTMLDivElement | null>, line: number | undefined, virtual: boolean) {
  useEffect(() => {
    const el = box.current;
    if (!el || !line) return;
    const root = virtual ? (el.firstElementChild as HTMLElement | null) : el;
    if (!root) return;
    const until = performance.now() + SCROLL_WAIT_MS;
    let jumped = false;
    let frame = 0;
    const step = () => {
      const row = root.querySelector(DIFFS_TAG_NAME)?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${String(line)}"]`);
      if (row) {
        // Rects are viewport px, scrollTop layout px: under a page zoom the distance is divided back.
        const top = (row.getBoundingClientRect().top - root.getBoundingClientRect().top) / zoomFactor() + root.scrollTop;
        root.scrollTop = Math.max(0, top - root.clientHeight / 3);
        return;
      }
      if (!jumped && virtual) {
        jumped = true;
        root.scrollTop = Math.max(0, (line - 1) * LINE_H - root.clientHeight / 3);
      }
      if (performance.now() < until) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [box, line, virtual]);
}

/**
 * A text file as code: line numbers, the codeView store's wrap, scrolling inside the tab.
 * `line` is marked with the library's selection (controlled, so a click does not move it)
 * and scrolled to; a long file goes through CodeScroll. `edit` is the File tab's editor.
 * `findKey`: the tab's find (FileFind.tsx); the box then takes the keyboard on a click, so
 * cmd+F knows the tab is meant (letters still reach the panel: the box is no text field).
 */
export function CodeBody({ name, text, lines, line, edit, findKey }: { name: string; text: string; lines: number; line?: number | undefined; edit?: CodeFileEdit | undefined; findKey?: string | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = lines > VIRTUALIZE_LINES;
  const selected = useMemo(() => (line ? { start: line, end: line } : null), [line]);
  useScrollToLine(box, line, virtual);
  useKeepTopLine(box, virtual);
  useCodeFind(findKey, box, virtual, text, edit?.active ? edit.stateKey : undefined);
  const focusable = findKey !== undefined ? -1 : undefined;
  const code = edit ? <CodeFile name={name} contents={text} selectedLines={selected} edit={edit} /> : <CodeFile name={name} contents={text} selectedLines={selected} />;
  return virtual ? (
    <div ref={box} tabIndex={focusable} className="flex min-h-0 flex-1 flex-col outline-none" data-testid="file-code" data-virtual="">
      <CodeScroll className="min-h-0 flex-1 overflow-auto">{code}</CodeScroll>
    </div>
  ) : (
    <div ref={box} tabIndex={focusable} className="min-h-0 flex-1 overflow-auto outline-none" data-testid="file-code">
      {code}
    </div>
  );
}
