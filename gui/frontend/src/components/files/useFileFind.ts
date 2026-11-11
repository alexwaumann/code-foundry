/**
 * The find over a File tab's body (docs/notes/file-find-in-file.md): the matches of the
 * bar's query in the body's text, the current one, and where they are on screen. The bar is
 * FileFind.tsx; the sessions and the presenter are stores/fileFind.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { plainText, rangeOf } from "@/components/thread/cite/citeDom";
import { draftText } from "@/lib/codeEditor";
import { fileMatchIndex, findInFile, pickCurrent, type FileMatch, type FileMatches } from "@/lib/fileFind";
import { matchOffsets, stepIndex } from "@/lib/threadFind";
import { zoomFactor } from "@/lib/zoom";
import { focusEditor, selectInEditor } from "@/stores/fileEdit";
import { fileFindOf, registerFileFindHost, setFileFindCount, setFileFindCurrent, setFileFindDraft, useFileFindCurrent, useFileFindDraft, useFileFindOpen, useFileFindQuery, useFileFindRevealSeq } from "@/stores/fileFind";
import { paintFileFind } from "./fileFindPaint";

/** What a tab body does for its find: where its text is on screen. */
interface FindSurface {
  /** The tab's root (the keyboard in it means this tab). */
  root: () => HTMLElement | null;
  /** The ranges of the matches now rendered: every one, and the current one. */
  paint: (query: string, matches: readonly FileMatch[], index: number) => { all: Range[]; current: Range[] };
  /** Runs `onChange` whenever what is rendered changes; returns the stop. */
  observe: (onChange: () => void) => () => void;
  /** Brings a match into view (rendering it first when it is off screen); returns the cancel. */
  reveal: (match: FileMatch, index: number, query: string) => () => void;
  /** The first line on screen, where a new search starts. */
  topLine: () => number;
  /** The find closed: the keyboard goes back, with the current match selected. */
  finish: (match: FileMatch | undefined, index: number, query: string) => void;
  /** The bar opened over this body. */
  opened?: () => void;
  /** The editor's own find panel is opening: it takes the query. */
  handOff?: (query: string) => void;
}

const NONE: FileMatches = { matches: [], capped: false };
/** How long a reveal keeps trying while a long file renders the line. */
const REVEAL_MS = 3000;
/** components/code/code.css --diffs-line-height. */
const LINE_H = 19;

/**
 * The find over one tab body: counts `text`'s matches, keeps the current one, and paints
 * and reveals them through `surface`. Registered as the tab's find host while it shows
 * (stores/fileFind.ts), bar open or not, so cmd+F knows the tab can search.
 */
function useFindLayer(findKey: string | undefined, text: string, surface: FindSurface): void {
  const key = findKey ?? "";
  const open = useFileFindOpen(key) && findKey !== undefined;
  const query = useFileFindQuery(key) ?? "";
  const current = useFileFindCurrent(key);
  const revealSeq = useFileFindRevealSeq(key);
  const { matches, capped } = useMemo(() => (open ? findInFile(text, query) : NONE), [open, text, query]);
  const index = fileMatchIndex(matches, current);
  const live = useRef({ matches, index, query });
  useLayoutEffect(() => {
    live.current = { matches, index, query };
  });

  // The current match. Opening or typing goes on from the match that was current (or where
  // it was, through a query with none), else from the top of the view, and brings it into
  // view; an edit of the text keeps the nearest one, in place; matches arriving after none
  // take the first from the top, in place.
  const seen = useRef<{ query: string; matches: readonly FileMatch[] } | null>(null);
  const anchor = useRef<{ line: number; start: number } | null>(null);
  useEffect(() => {
    if (!open) {
      seen.current = null;
      anchor.current = null;
      return;
    }
    const was = seen.current;
    seen.current = { query, matches };
    const cur = fileFindOf(key)?.current ?? null;
    const old = was ? was.matches[fileMatchIndex(was.matches, cur)] : undefined;
    if (old) anchor.current = { line: old.line, start: old.start };
    const next = pickCurrent({ first: !was, queryChanged: was !== null && was.query !== query, textChanged: was !== null && was.matches !== matches, matches, current: cur, was: old, anchor: anchor.current, top: surface.topLine });
    if (!next) return;
    const m = matches[next.index];
    setFileFindCurrent(key, m ? { line: m.line, nth: m.nth } : null, next.reveal && m !== undefined);
  }, [open, key, query, matches, surface]);

  useEffect(() => {
    if (open) setFileFindCount(key, index, matches.length, capped);
  }, [open, key, index, matches.length, capped]);

  useEffect(() => {
    if (findKey === undefined) return;
    const root = surface.root();
    if (!root) return;
    return registerFileFindHost(findKey, {
      root,
      step: (dir) => {
        const { matches: ms, index: at } = live.current;
        const i = stepIndex(ms.length, at, dir);
        const m = ms[i];
        if (m) setFileFindCurrent(findKey, { line: m.line, nth: m.nth }, true);
      },
      opened: () => surface.opened?.(),
      handOff: (q) => surface.handOff?.(q),
      finish: () => {
        const { matches: ms, index: at, query: q } = live.current;
        surface.finish(ms[at], at, q);
      },
    });
  }, [findKey, surface]);

  useEffect(() => {
    if (!open || query === "" || matches.length === 0) {
      paintFileFind(key, [], []);
      return;
    }
    let frame = 0;
    const run = () => {
      frame = 0;
      const p = surface.paint(query, matches, index);
      paintFileFind(key, p.all, p.current);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(run);
    };
    run();
    const stop = surface.observe(schedule);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      paintFileFind(key, [], []);
    };
  }, [open, key, query, matches, index, surface]);

  // Only a new request reveals: a body that mounts on an open session stays where it is.
  const shown = useRef(revealSeq);
  useEffect(() => {
    if (revealSeq === shown.current) return;
    shown.current = revealSeq;
    const { matches: ms, index: at, query: q } = live.current;
    const m = ms[at];
    return m ? surface.reveal(m, at, q) : undefined;
  }, [revealSeq, surface]);
}

/** The nearest scrollable ancestor in each direction, crossing shadow roots, up to `stop`. */
function scrollParents(from: Element, stop: Element): Element[] {
  const out: Element[] = [];
  let el: Element | null = from;
  while (el && el !== stop) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth) out.push(el);
    const parent: Element | null = el.parentElement ?? ((el.parentNode as ShadowRoot | null)?.host ?? null);
    el = parent;
  }
  return out;
}

/**
 * Scrolls `scroller` (and any element between it and the range that scrolls sideways) so
 * the range shows: a third down when it was out of view, sideways only as far as needed.
 * Rects are viewport px and scroll offsets layout px, hence the zoom (lib/zoom.ts).
 * `leftInset`: what covers the scroller's left edge (a sticky gutter).
 */
function revealRange(range: Range, scroller: Element, leftInset = 0): void {
  const z = zoomFactor();
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top < box.top || rect.bottom > box.bottom) scroller.scrollTop += (rect.top - box.top) / z - scroller.clientHeight / 3;
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!start) return;
  for (const el of scrollParents(start, scroller)) {
    const r = range.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    const left = e.left + leftInset * z;
    const pad = 24 * z;
    if (r.left < left + pad || r.right > e.right - pad) el.scrollLeft += (r.left - left) / z - Math.max(0, (el.clientWidth - leftInset) / 2);
  }
}

/** A line's DOM text and the ranges of `query` in it. */
function lineRanges(el: Element, query: string): Range[] {
  const pt = plainText(el);
  return matchOffsets(pt.text, query).flatMap((m) => rangeOf(pt, m.start, m.end) ?? []);
}

/** Watches a shadow root that comes and goes under `host` (the library renders it late and replaces it on remount). */
function observeShadow(host: Element, shadow: () => ShadowRoot | null, onChange: () => void): () => void {
  let watched: ShadowRoot | null = null;
  const inner = new MutationObserver(onChange);
  const attach = () => {
    const sr = shadow();
    if (sr === watched) return;
    inner.disconnect();
    watched = sr;
    if (sr) inner.observe(sr, { subtree: true, childList: true, characterData: true });
  };
  const outer = new MutationObserver(() => {
    attach();
    onChange();
  });
  attach();
  outer.observe(host, { subtree: true, childList: true });
  return () => {
    outer.disconnect();
    inner.disconnect();
  };
}

/** The code's FindSurface: lines in @pierre/diffs' shadow root, in a box that scrolls (a long file's inner CodeScroll). */
function codeSurface(findKey: string | undefined, box: RefObject<HTMLDivElement | null>, virtual: boolean, editing: string | undefined): FindSurface {
  const shadow = () => box.current?.querySelector(DIFFS_TAG_NAME)?.shadowRoot ?? null;
  const scroller = () => (virtual ? (box.current?.firstElementChild ?? null) : box.current);
  const lines = () => Array.from(shadow()?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? []);
  const lineEl = (line: number) => shadow()?.querySelector(`[data-content] [data-line="${String(line + 1)}"]`) ?? null;
  const gutter = () => (shadow()?.querySelector("[data-gutter]")?.getBoundingClientRect().width ?? 0) / zoomFactor();
  const rangeFor = (m: FileMatch, query: string) => {
    const el = lineEl(m.line);
    return el ? (lineRanges(el, query)[m.nth] ?? null) : null;
  };
  return {
    root: () => box.current?.closest<HTMLElement>("[data-file-find-box]") ?? box.current,
    paint: (query, matches, index) => {
      const has = new Set(matches.map((m) => m.line));
      const cur = matches[index];
      const all: Range[] = [];
      const current: Range[] = [];
      for (const el of lines()) {
        const line = Number(el.dataset.line) - 1;
        if (!has.has(line)) continue;
        lineRanges(el, query).forEach((r, nth) => {
          (cur?.line === line && cur.nth === nth ? current : all).push(r);
        });
      }
      return { all, current };
    },
    observe: (onChange) => (box.current ? observeShadow(box.current, shadow, onChange) : () => undefined),
    reveal: (m, _index, query) => {
      const until = performance.now() + REVEAL_MS;
      let frame = 0;
      const step = () => {
        frame = 0;
        const sc = scroller();
        if (!sc) return;
        const range = rangeFor(m, query);
        if (range) {
          revealRange(range, sc, gutter());
          return;
        }
        // Not rendered: scroll to where the line must be, from a line that is, and look again.
        const shown = lines();
        const first = shown[0];
        const last = shown[shown.length - 1];
        if (first && last) {
          const ref = m.line + 1 < Number(first.dataset.line) ? first : last;
          const z = zoomFactor();
          const top = (ref.getBoundingClientRect().top - sc.getBoundingClientRect().top) / z;
          sc.scrollTop += top + (m.line + 1 - Number(ref.dataset.line)) * LINE_H - sc.clientHeight / 3;
        } else if (sc.scrollTop === 0 && m.line > 0) sc.scrollTop = m.line * LINE_H - sc.clientHeight / 3;
        // Nothing rendered (the library's virtualizer, scrolled to the end of wrapped lines,
        // once rendered no line until it heard another scroll): a pixel back makes it render.
        else sc.scrollTop += sc.scrollTop > 0 ? -1 : 1;
        if (performance.now() < until) frame = requestAnimationFrame(step);
      };
      step();
      return () => {
        cancelAnimationFrame(frame);
      };
    },
    topLine: () => {
      const sc = scroller();
      if (!sc) return 0;
      const top = sc.getBoundingClientRect().top;
      const first = lines().find((el) => el.getBoundingClientRect().bottom > top + 1);
      return first ? Number(first.dataset.line) - 1 : 0;
    },
    finish: (m, _index, query) => {
      if (editing !== undefined && findKey !== undefined) {
        if (!m || !selectInEditor(findKey, { line: m.line, character: m.start }, { line: m.line, character: m.end })) focusEditor(findKey);
        return;
      }
      box.current?.focus({ preventScroll: true });
      const r = m ? rangeFor(m, query) : null;
      if (r) getSelection()?.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
    },
    // The editor's own find panel (cmd+alt+F's replace) goes when ours opens: one find at a time.
    opened: () => {
      shadow()?.querySelector<HTMLElement>("[data-search-panel] [data-search-close]")?.click();
    },
    // Its panel renders a frame after the chord and selects its field the frame after.
    handOff: (query) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const input = shadow()?.querySelector<HTMLInputElement>("[data-search-panel] input[data-search]");
          if (!input) return;
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.select();
        });
      });
    },
  };
}

/**
 * The find over a CodeBody: the file's text in view mode, the editor's document in edit
 * mode; matches painted on the lines @pierre/diffs has rendered (a long file renders only
 * those near the viewport, and paints more as they come), a match off screen rendered by
 * scrolling to where its line must be first.
 */
export function useCodeFind(findKey: string | undefined, box: RefObject<HTMLDivElement | null>, virtual: boolean, text: string, editing: string | undefined): void {
  const draft = useFileFindDraft(findKey ?? "");
  const open = useFileFindOpen(findKey ?? "");
  // The editor's document: what it holds as the bar opens, then each change (FileTab onDraft).
  useEffect(() => {
    if (findKey === undefined) return;
    setFileFindDraft(findKey, open && editing !== undefined ? draftText(editing) : null);
  }, [findKey, open, editing]);
  const surface = useMemo(() => codeSurface(findKey, box, virtual, editing), [box, virtual, editing, findKey]);
  useFindLayer(findKey, editing !== undefined ? (draft ?? text) : text, surface);
}

/** Text left out of a rendered markdown file's find: an image's chip (MarkdownPreview LocalImage). */
const MD_SKIP = "[data-find-skip]";

/** Rendered markdown's FindSurface: the page's own DOM, all of it rendered. */
function markdownSurface(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>): FindSurface {
  const ranges = (query: string) => {
    const el = content.current;
    if (!el) return [];
    const pt = plainText(el, MD_SKIP);
    return matchOffsets(pt.text, query).map((m) => rangeOf(pt, m.start, m.end));
  };
  return {
    root: () => scroller.current?.closest<HTMLElement>("[data-file-find-box]") ?? scroller.current,
    paint: (query, _matches, index) => {
      const all: Range[] = [];
      const current: Range[] = [];
      ranges(query).forEach((r, i) => {
        if (r) (i === index ? current : all).push(r);
      });
      return { all, current };
    },
    observe: (onChange) => {
      const el = content.current;
      if (!el) return () => undefined;
      const mo = new MutationObserver(onChange);
      mo.observe(el, { subtree: true, childList: true, characterData: true });
      return () => {
        mo.disconnect();
      };
    },
    reveal: (_m, index, query) => {
      const r = ranges(query)[index];
      const sc = scroller.current;
      if (r && sc) revealRange(r, sc);
      return () => undefined;
    },
    topLine: () => {
      const el = content.current;
      const sc = scroller.current;
      if (!el || !sc) return 0;
      const top = sc.getBoundingClientRect().top;
      const pt = plainText(el, MD_SKIP);
      const seg = pt.segments.find((s) => s.node.parentElement && s.node.parentElement.getBoundingClientRect().bottom > top + 1);
      return seg ? (pt.text.slice(0, seg.at).match(/\n/g)?.length ?? 0) : 0;
    },
    finish: (_m, index, query) => {
      scroller.current?.focus({ preventScroll: true });
      const r = index >= 0 ? ranges(query)[index] : null;
      if (r) getSelection()?.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
    },
  };
}

/**
 * The find over rendered markdown: the text as the page shows it (citeDom.plainText, a
 * line per block), read again whenever the page changes (an image loading, a code block
 * highlighting). Not virtualized, so every match is in the DOM.
 */
export function useMarkdownFind(findKey: string | undefined, scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>): void {
  const open = useFileFindOpen(findKey ?? "");
  const [text, setText] = useState("");
  useEffect(() => {
    const el = content.current;
    if (!open || !el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setText(plainText(el, MD_SKIP).text);
    };
    read();
    const mo = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(read);
    });
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, content]);
  const surface = useMemo(() => markdownSurface(scroller, content), [scroller, content]);
  useFindLayer(findKey, text, surface);
}
