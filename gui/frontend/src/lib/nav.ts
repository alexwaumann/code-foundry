import { createContext, useCallback, useMemo, useRef, useState } from "react";

/**
 * Keyboard cursor over a page's rows (the Pull Requests page, the worktree overview).
 * The page lists every navigable row in display order; rows render through NavRow.
 * ↑/↓ (or k/j), Home/End move; Enter or Space activates (cmd+Enter: the secondary action); →/←
 * expand or collapse. The page's
 * container holds focus and points at the cursor row with aria-activedescendant.
 */
export interface NavItem {
  key: string;
  activate?: () => void;
  /** cmd+Enter on the row (e.g. open a pull request on GitHub instead of in the panel). */
  secondary?: () => void;
  /** For tree rows: expand (true) or collapse (false). Returns false if nothing changed. */
  toggle?: (open: boolean) => boolean;
}

export interface NavCtx {
  cursorKey: string | null;
  setCursor: (key: string) => void;
  activate: (key: string) => void;
  reveal: NavReveal;
}

/**
 * The row owed a scroll into view: owed when something moves the cursor there or a list opens on
 * it, paid by the row when it shows. It tells those from a row that is merely selected as it
 * mounts, which a list scrolled towards it or a live update does, and must not move the list.
 */
export interface NavReveal {
  owe: (key: string) => void;
  owes: (key: string) => boolean;
  /** Whether `key` was owed; it no longer is. */
  pay: (key: string) => boolean;
}

function createReveal(): NavReveal {
  let owed: string | null = null;
  return {
    owe: (key) => {
      owed = key;
    },
    owes: (key) => owed === key,
    pay: (key) => {
      if (owed !== key) return false;
      owed = null;
      return true;
    },
  };
}

export const NavContext = createContext<NavCtx>({ cursorKey: null, setCursor: () => undefined, activate: () => undefined, reveal: createReveal() });

export const navId = (key: string): string => `nav-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function useNav(items: readonly NavItem[]) {
  const [cursor, setCursorState] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(items.map((it, i) => [it.key, { it, i }])), [items]);
  // A cursor whose row went away falls back to the first row (no cursor until used).
  const cursorKey = cursor !== null && byKey.has(cursor) ? cursor : null;
  const [reveal] = useState(createReveal);
  const last = useRef<string | null>(null);
  const setCursor = useCallback((key: string) => {
    // The same key again moves nothing, so no row would answer and it would wait for one to mount.
    if (key !== last.current) reveal.owe(key);
    last.current = key;
    setCursorState(key);
  }, [reveal]);
  const activate = useCallback(
    (key: string) => {
      setCursor(key);
      byKey.get(key)?.it.activate?.();
    },
    [byKey, setCursor],
  );
  const move = (to: number) => {
    const it = items[Math.max(0, Math.min(items.length - 1, to))];
    if (it) setCursor(it.key);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || items.length === 0) return;
    const cur = cursorKey === null ? -1 : (byKey.get(cursorKey)?.i ?? -1);
    const item = cur >= 0 ? items[cur] : undefined;
    if (e.key === "Enter" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && item?.secondary) {
      e.preventDefault();
      item.secondary();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        move(cur + 1);
        break;
      case "ArrowUp":
      case "k":
        move(cur < 0 ? items.length - 1 : cur - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(items.length - 1);
        break;
      case "Enter":
      case " ":
        if (item?.activate) item.activate();
        else if (item?.toggle) item.toggle(true);
        break;
      case "ArrowRight":
        item?.toggle?.(true);
        break;
      case "ArrowLeft":
        item?.toggle?.(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const ctx = useMemo<NavCtx>(() => ({ cursorKey, setCursor, activate, reveal }), [cursorKey, setCursor, activate, reveal]);
  return { cursorKey, setCursor, onKeyDown, ctx, activeDescendant: cursorKey === null ? undefined : navId(cursorKey) };
}
