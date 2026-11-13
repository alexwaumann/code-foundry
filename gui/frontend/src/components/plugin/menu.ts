/**
 * Plugin menus (docs/notes/plugin-menu.md): what a row's ⋯ and right-click menu holds, when
 * a row folds its action buttons into it (sketch C), and a menu's items as blocks to draw.
 * Pure: PluginMenu.tsx draws them; a table's rows reuse rowMenuItems and foldRowActions.
 */
import type { KeyboardEvent } from "react";
import type { Row, ViewButton, ViewMenuItem } from "@/api/plugin";

/**
 * The least width (px) a row keeps beside its buttons before they fold: its padding, glyph
 * and a title of about 20 characters. A 420 px pane's row (about 400 px) keeps two short
 * buttons and folds three; an expanded panel's keeps three.
 */
export const ROW_TITLE_MIN = 200;

// PluginButton's size "xs" (components/ui/button.tsx): 24 px tall, 8 px padding each side
// (6 px beside an icon), a 12 px icon 4 px from its label, 12 px medium text; buttons sit
// 6 px apart. A character of the label is about 7 px wide (WebKit draws 6.6 to 7).
const ICON_BUTTON = 24;
const BUTTON_PAD = 16;
const BUTTON_ICON = 14;
const LABEL_CHAR = 7;
const BUTTON_GAP = 6;

/** About how wide (px) PluginButton draws `b`. */
export function buttonWidth(b: ViewButton): number {
  if (b.iconOnly) return ICON_BUTTON;
  return Math.ceil(BUTTON_PAD + (b.icon ? BUTTON_ICON : 0) + b.label.length * LABEL_CHAR);
}

/** About how wide (px) `buttons` are side by side. */
export function buttonsWidth(buttons: readonly ViewButton[]): number {
  return buttons.reduce((w, b) => w + buttonWidth(b), 0) + Math.max(0, buttons.length - 1) * BUTTON_GAP;
}

/**
 * Whether a row `width` px wide folds its action buttons into its ⋯ menu instead of
 * squeezing them: when it is narrower than the buttons need on one line plus ROW_TITLE_MIN. A dense row always folds its labelled buttons (it has no second line
 * to show them on). All of a row's buttons fold, or none. Not measured yet (null): no fold.
 */
export function foldRowActions(width: number | null, actions: readonly ViewButton[] | undefined, dense: boolean): boolean {
  if (!actions || actions.length === 0) return false;
  if (dense && actions.some((b) => !b.iconOnly)) return true;
  if (width === null) return false;
  return width < ROW_TITLE_MIN + buttonsWidth(actions);
}

/** A button as a menu item: its key, label and action; inert while disabled or busy; red when destructive. */
export function buttonItem(b: ViewButton): ViewMenuItem {
  return {
    key: b.key,
    label: b.label,
    ...(b.action ? { action: b.action } : {}),
    ...(b.disabled || b.busy ? { disabled: true } : {}),
    ...(b.style === "destructive" ? { danger: true } : {}),
  };
}

/**
 * The items of a row's ⋯ and right-click menu: when `folded`, its action buttons first,
 * then a separator, then its menu's items. Null when the row has no ⋯ (no menu, and its
 * buttons are on screen).
 */
export function rowMenuItems(row: Pick<Row, "actions" | "menu">, folded: boolean): ViewMenuItem[] | null {
  const own = row.menu?.items ?? [];
  const actions = folded ? (row.actions ?? []).filter((b) => !b.menu).map(buttonItem) : [];
  if (actions.length === 0) return own.length > 0 ? [...own] : null;
  return own.length > 0 ? [...actions, { separator: true }, ...own] : actions;
}

/** A menu's entry to draw: an item, a separator, a submenu (its own blocks), or a run of one group's items (radio style, `value` the checked key or ""). */
export type MenuBlock =
  | { kind: "item"; item: ViewMenuItem & { key: string } }
  | { kind: "separator"; at: number }
  | { kind: "sub"; item: ViewMenuItem & { key: string }; blocks: MenuBlock[] }
  | { kind: "group"; group: string; value: string; items: (ViewMenuItem & { key: string })[] };

/**
 * `items` as blocks: adjacent items of one group become one group block; a submenu's items
 * are its own blocks (one level: a submenu inside one is left out). Separators that would
 * start or end the list or follow another are dropped, as are items without a key (the
 * daemon refuses those views; this keeps a stray one from drawing an empty line).
 */
export function menuBlocks(items: readonly ViewMenuItem[], inSub = false): MenuBlock[] {
  const out: MenuBlock[] = [];
  items.forEach((it, i) => {
    if (it.separator) {
      if (out.length > 0 && out.at(-1)?.kind !== "separator") out.push({ kind: "separator", at: i });
      return;
    }
    if (!it.key) return;
    const item = { ...it, key: it.key };
    if (it.submenu) {
      if (inSub) return;
      const blocks = menuBlocks(it.submenu, true);
      if (blocks.length > 0) out.push({ kind: "sub", item, blocks });
      return;
    }
    const last = out.at(-1);
    if (it.group) {
      if (last?.kind === "group" && last.group === it.group) {
        last.items.push(item);
        if (it.checked && !last.value) last.value = it.key;
      } else {
        out.push({ kind: "group", group: it.group, value: it.checked ? it.key : "", items: [item] });
      }
      return;
    }
    out.push({ kind: "item", item });
  });
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

/** Every key a menu's items act with (submenus' items too): what its trigger spins for while one is pending. */
export function menuKeys(items: readonly ViewMenuItem[]): string[] {
  return items.flatMap((it) => [...(it.key && it.action ? [it.key] : []), ...(it.submenu ? menuKeys(it.submenu) : [])]);
}

/** Whether the key is the keyboard's way to a context menu: the ContextMenu key or Shift+F10 (no other modifier). */
export function isContextMenuKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/**
 * The row's key handler for its context menu: the ContextMenu key or Shift+F10 opens it at
 * the row's start (left + 24 px, its bottom), by the contextmenu event Radix listens for.
 * True when it handled the key.
 */
export function openRowMenuFromKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (!isContextMenuKey(e)) return false;
  e.preventDefault();
  const row = e.currentTarget;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }));
  return true;
}
