/**
 * A list's interactive rows (docs/notes/plugin-list-rows.md): the changes shown before the
 * plugin's next view, the pointer drag and the keyboard move that reorder. ListNode puts
 * them together with ListRows.tsx's parts; rows.ts has the arithmetic.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Row } from "@/api/plugin";
import { actOnElement, CHOICE_HOLD_MS, usePluginSurfacesStore, useSurfaceEntry } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import { addPending, applyChanges, dropAt, edgeScroll, keyMove, keysOf, settle, type PendingChange, type RowChange } from "./rows";

/** What a row of an interactive list can do; RowView draws the parts from it. */
export interface RowOps {
  checkable: boolean;
  reorderable: boolean;
  /** Nothing acts (the plugin is down): the parts show, disabled. */
  inert: boolean;
  check: (key: string, checked: boolean) => void;
  edit: (key: string, title: string) => void;
  /** alt+↑ (-1) or alt+↓ (1) on the focused row. */
  moveBy: (key: string, dir: -1 | 1) => void;
  /** A pointer went down on a row's grip. */
  grab: (key: string, e: ReactPointerEvent<HTMLElement>) => void;
  /** The row being dragged (drawn faded in its place), or null. */
  dragging: string | null;
}

let changeSeq = 0;

/** The value a row change's act carries. */
function actValue(c: RowChange): string {
  if (c.kind === "check") return String(c.checked);
  return c.kind === "move" ? c.after : c.title;
}

/**
 * A list's rows as shown (the plugin's, with the user's changes in flight on top) and the
 * function that makes a change: it shows at once, its act goes to the plugin (a row act:
 * the change's kind as the act's action), and it goes when the plugin refuses it (the
 * refusal is toasted) or, once taken, when a view shows it or a newer view comes, at most
 * CHOICE_HOLD_MS later.
 */
export function useRowChanges(rows: readonly Row[]): { rows: readonly Row[]; change: (c: RowChange) => void } {
  const { watchKey, inert } = useViewCtx();
  const version = useSurfaceEntry(watchKey, (e) => e?.version ?? 0);
  const [pending, setPending] = useState<readonly PendingChange[]>([]);
  // Settled against each view as it is drawn; what settles stays in the state until its
  // hold ends (a newer view or the rows showing it settle it for good).
  const live = settle(pending, rows, version);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const ts = timers.current;
    return () => {
      for (const t of ts) clearTimeout(t);
    };
  }, []);
  const change = useCallback(
    (c: RowChange) => {
      if (inert) return;
      const id = ++changeSeq;
      setPending((p) => addPending(p, c, id));
      void actOnElement(watchKey, c.key, { action: c.kind, value: actValue(c) }).then((took) => {
        if (!took) {
          setPending((p) => p.filter((x) => x.id !== id));
          return;
        }
        const at = usePluginSurfacesStore.getState().watches[watchKey]?.version ?? 0;
        setPending((p) => p.map((x) => (x.id === id ? { ...x, answered: true, at } : x)));
        const t = setTimeout(() => {
          timers.current.delete(t);
          setPending((p) => p.filter((x) => x.id !== id));
        }, CHOICE_HOLD_MS);
        timers.current.add(t);
      });
    },
    [watchKey, inert],
  );
  const shown = useMemo(() => applyChanges(rows, live.map((p) => p.change)), [rows, live]);
  return { rows: shown, change };
}

/** The nearest box that scrolls the list: the marked scroll root (the panel's body), else the nearest overflow. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  const marked = el.closest<HTMLElement>("[data-scroll-root]");
  if (marked) return marked;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** A drag in progress, as drawn: the lifted row's box and the drop line's y in the list (null: no line). */
export interface DragView {
  key: string;
  top: number;
  left: number;
  width: number;
  lineY: number | null;
}

/** How far the pointer moves before a press on a grip becomes a drag (the panel tabs' distance). */
const DRAG_DISTANCE = 4;

/**
 * The pointer drag that reorders a list (`box` holds its rows): a press on a grip lifts the
 * row once the pointer moves DRAG_DISTANCE px; the drop line follows the pointer between
 * the rows drawn (a virtualized list draws those around the pointer), the scroll box
 * scrolls while the pointer is near its top or bottom, and the release moves the row
 * there (`onMove`, its new upper neighbour). Escape, a cancel, or a release where it was
 * moves nothing.
 */
export function useRowDrag(keys: readonly string[], box: RefObject<HTMLElement | null>, onMove: (key: string, after: string) => void): { grab: RowOps["grab"]; drag: DragView | null } {
  const [drag, setDrag] = useState<DragView | null>(null);
  const keysRef = useRef(keys);
  const onMoveRef = useRef(onMove);
  useLayoutEffect(() => {
    keysRef.current = keys;
    onMoveRef.current = onMove;
  });
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const grab = useCallback(
    (key: string, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !box.current) return;
      e.preventDefault();
      stop.current?.();
      const row = e.currentTarget.closest<HTMLElement>('[data-testid="plugin-row"]');
      if (!row) return;
      const startY = e.clientY;
      const r = row.getBoundingClientRect();
      const offset = startY - r.top;
      const scroller = scrollerOf(box.current);
      let y = startY;
      let started = false;
      let after: string | null = null;
      let frame = 0;
      const measure = () => {
        const list = box.current;
        if (!list) return;
        const boxes = [...list.querySelectorAll<HTMLElement>('[data-testid="plugin-row"]')].map((el) => {
          const b = el.getBoundingClientRect();
          return { key: el.dataset.key ?? "", top: b.top, bottom: b.bottom };
        });
        const at = dropAt(keysRef.current, boxes, key, y);
        after = at?.after ?? null;
        const top = list.getBoundingClientRect().top;
        setDrag({ key, top: y - offset, left: r.left, width: r.width, lineY: at && at.after !== null ? at.lineY - top : null });
      };
      const tick = () => {
        if (scroller) {
          const s = scroller.getBoundingClientRect();
          const dy = edgeScroll(y, s.top, s.bottom);
          if (dy !== 0) {
            const was = scroller.scrollTop;
            scroller.scrollTop = was + dy;
            if (scroller.scrollTop !== was) measure();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      const move = (ev: PointerEvent) => {
        y = ev.clientY;
        if (!started && Math.abs(y - startY) < DRAG_DISTANCE) return;
        if (!started) {
          started = true;
          document.body.dataset.rowDrag = "";
          frame = requestAnimationFrame(tick);
        }
        measure();
      };
      const end = (drop: boolean) => {
        const moved = drop && started && after !== null ? after : null;
        stop.current?.();
        if (moved !== null) onMoveRef.current(key, moved);
      };
      const up = () => {
        end(true);
      };
      const cancel = () => {
        end(false);
      };
      const esc = (ev: globalThis.KeyboardEvent) => {
        if (ev.key !== "Escape" || !started) return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", esc, true);
      stop.current = () => {
        stop.current = null;
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", esc, true);
        delete document.body.dataset.rowDrag;
        setDrag(null);
      };
    },
    [box],
  );
  return { grab, drag };
}

/** The keyboard move of a row: its new upper neighbour for alt+↑/↓, or nothing at an end. */
export function useKeyMove(rows: readonly Row[], change: (c: RowChange) => void): RowOps["moveBy"] {
  const keys = useMemo(() => keysOf(rows), [rows]);
  return useCallback(
    (key, dir) => {
      const after = keyMove(keys, key, dir);
      if (after !== null) change({ kind: "move", key, after });
    },
    [keys, change],
  );
}

