import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Keyboard cursor over a page's rows (the Pull Requests page, the worktree overview).
 * The page lists every navigable row in display order; rows render through NavRow.
 * ↑/↓ (or k/j), Home/End move; Enter activates (cmd+Enter: the secondary action); →/←
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
}

export const NavContext = createContext<NavCtx>({ cursorKey: null, setCursor: () => undefined, activate: () => undefined });

export const navId = (key: string): string => `nav-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function useNav(items: readonly NavItem[]) {
  const [cursor, setCursorState] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(items.map((it, i) => [it.key, { it, i }])), [items]);
  // A cursor whose row went away falls back to the first row (no cursor until used).
  const cursorKey = cursor !== null && byKey.has(cursor) ? cursor : null;
  const setCursor = useCallback((key: string) => {
    setCursorState(key);
  }, []);
  const activate = useCallback(
    (key: string) => {
      setCursorState(key);
      byKey.get(key)?.it.activate?.();
    },
    [byKey],
  );
  const move = (to: number) => {
    const it = items[Math.max(0, Math.min(items.length - 1, to))];
    if (it) setCursorState(it.key);
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
  const ctx = useMemo<NavCtx>(() => ({ cursorKey, setCursor, activate }), [cursorKey, setCursor, activate]);
  return { cursorKey, setCursor, onKeyDown, ctx, activeDescendant: cursorKey === null ? undefined : navId(cursorKey) };
}

export function useNavCursor(): string | null {
  return useContext(NavContext).cursorKey;
}
