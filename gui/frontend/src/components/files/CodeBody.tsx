import { useEffect, useMemo, useRef, type RefObject } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, DIFFS_TAG_NAME, type SupportedLanguages } from "@pierre/diffs";
import { CodeFile, type CodeFileEdit } from "@/components/code/CodeFile";
import { CodeScroll } from "@/components/code/CodeDiff";
import { useCodeFind } from "./useFileFind";
import { useKeepTopLine } from "./useKeepTopLine";

/** Above this many lines the file lays out only its visible lines (the library's virtualizer). */
export const VIRTUALIZE_LINES = 400;
/** Where the virtualizer lays out a line it has not measured yet (its 20 px; a drawn row is code.css's 19). */
const LINE_H = DEFAULT_VIRTUAL_FILE_METRICS.lineHeight;
/** Where a File tab puts its line: a third down. */
const LINE_AT = 1 / 3;
/** How long to wait for the library to render the line (theme and grammar load first). */
const SCROLL_WAIT_MS = 3000;

/**
 * Scrolls the line into view, `at` of the way down the box (a third by default), once the library has rendered it. A
 * virtualized file renders only what is near the viewport, so the box first jumps to where
 * the line would be with unwrapped lines, which makes the library render it, then lands on
 * the rendered row. The jump waits for the file's first rows (docs/notes/file-tab-large-file-scroll.md).
 */
function useScrollToLine(box: RefObject<HTMLDivElement | null>, line: number | undefined, virtual: boolean, at: number) {
  useEffect(() => {
    const el = box.current;
    if (!el || !line) return;
    const root = virtual ? (el.firstElementChild as HTMLElement | null) : el;
    if (!root) return;
    const until = performance.now() + SCROLL_WAIT_MS;
    let jumped = false;
    let frame = 0;
    const step = () => {
      const shadow = root.querySelector(DIFFS_TAG_NAME)?.shadowRoot;
      const row = shadow?.querySelector<HTMLElement>(`[data-line="${String(line)}"]`);
      if (row) {
        const top = row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
        // A File tab's line lands with its top a third down; another place puts the line's middle there.
        const middle = at === LINE_AT ? 0 : row.getBoundingClientRect().height / 2;
        root.scrollTop = Math.max(0, top + middle - root.clientHeight * at);
        return;
      }
      // Not before the file has rows: until its highlighter loads it is 0 px tall, and the jump would be clamped to 0.
      if (!jumped && virtual && shadow?.querySelector("[data-line]")) {
        jumped = true;
        root.scrollTop = Math.max(0, (line - 1) * LINE_H - root.clientHeight * at);
      }
      if (performance.now() < until) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [box, line, virtual, at]);
}

/**
 * A text file as code: line numbers, the codeView store's wrap, scrolling inside the tab.
 * `line` is marked with the library's selection (controlled, so a click does not move it)
 * and scrolled to; a long file goes through CodeScroll. `edit` is the File tab's editor.
 * `findKey`: the tab's find (FileFind.tsx); the box then takes the keyboard on a click, so
 * cmd+F knows the tab is meant (letters still reach the panel: the box is no text field).
 * `lineAt`: how far down the box the line lands (a third; the text search preview centres it).
 */
export function CodeBody({ name, text, lang, lines, line, edit, findKey, lineAt = LINE_AT }: { name: string; text: string; lang?: SupportedLanguages | undefined; lines: number; line?: number | undefined; edit?: CodeFileEdit | undefined; findKey?: string | undefined; lineAt?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = lines > VIRTUALIZE_LINES;
  const selected = useMemo(() => (line ? { start: line, end: line } : null), [line]);
  useScrollToLine(box, line, virtual, lineAt);
  useKeepTopLine(box, virtual, "line", edit ? `${String(edit.active)}:${String(edit.revision)}` : undefined);
  useCodeFind(findKey, box, virtual, text, edit?.active ? edit.stateKey : undefined);
  const focusable = findKey !== undefined ? -1 : undefined;
  const code = edit ? <CodeFile name={name} contents={text} lang={lang} selectedLines={selected} edit={edit} /> : <CodeFile name={name} contents={text} lang={lang} selectedLines={selected} />;
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
