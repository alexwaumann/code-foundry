import { MessageSquare, PencilLine, ShieldQuestionMark, type LucideIcon } from "lucide-react";
import type { ShellThreadRow } from "@/lib/shellSections";
import type { StatusLine } from "@/lib/statusLine";
import { statusBadge } from "@/lib/statusRegistry";
import { SHELL_GAP } from "@/design/tokens";
import { cn } from "@/lib/utils";

/**
 * The collapsed sidebar's sizes (docs/notes/sidebar-rail.md), in layout px: the page zoom
 * scales them as it scales the expanded sidebar. The sidebar's left gutter (the shell gap),
 * then a column of icons; each icon a 26px tall target 2px from the next (a 28px pitch).
 */
export const RAIL_COLUMN = 28;
export const RAIL_WIDTH = SHELL_GAP + RAIL_COLUMN;
export const RAIL_TILE = 26;
export const RAIL_GAP = 2;
/** Needs you shows at most this many icons; more scroll inside the group. */
export const RAIL_NEEDS_MAX = 4;
/** A Working, Snoozed or Archived card's list is at most this tall, then it scrolls inside the card. */
export const RAIL_CARD_MAX = 300;
/** The height a group of n icons takes. */
export function railGroupHeight(n: number): number {
  return n <= 0 ? 0 : n * RAIL_TILE + (n - 1) * RAIL_GAP;
}

/** What a row's icon on the rail looks like: the glyph, its colour class, and what it stands for (for tests and screen readers' data). */
export interface RailLook {
  icon: LucideIcon;
  tone: string;
  kind: string;
}

const MUTED = "text-cf-sidebar-muted-foreground";

/**
 * A thread row's icon on the rail, from its status line (lib/statusLine, the row's RowStatus and
 * AskKind read the same): a Needs you row shows its ask's icon (permission, question, plan) in
 * the warning colour; an Active row its status icon in its colour (error, interrupted, done, …);
 * a row that would show only a time (an idle thread) the thread surface's icon, muted.
 */
export function railThreadLook(section: ShellThreadRow["section"], line: StatusLine): RailLook {
  const badge = statusBadge(line);
  if (section === "needs") return { icon: badge.icon ?? ShieldQuestionMark, tone: "text-cf-warning-text", kind: line.kind };
  // The thread surface's icon (shell/surfaces/thread.tsx), named here so the sidebar does not import the surface.
  if (badge.icon === null) return { icon: MessageSquare, tone: MUTED, kind: "thread" };
  return { icon: badge.icon, tone: badge.toneClass, kind: line.kind };
}

/** A draft's icon: the expanded row's draft mark, muted, on the row's amber tint. */
export function railDraftLook(): RailLook {
  return { icon: PencilLine, tone: MUTED, kind: "draft" };
}

/** A mask's shown part: only its alpha is read, so its colour is no theme's. */
const OPAQUE = "#000";

/**
 * The fade on a scrolled group's edges (a mask): only on the side that has more to scroll to.
 * Undefined when neither has.
 */
export function edgeMask(top: boolean, bottom: boolean, fade = 20): string | undefined {
  if (!top && !bottom) return undefined;
  const from = top ? `transparent 0, ${OPAQUE} ${String(fade)}px` : `${OPAQUE} 0`;
  const to = bottom ? `${OPAQUE} calc(100% - ${String(fade)}px), transparent 100%` : `${OPAQUE} 100%`;
  return `linear-gradient(to bottom, ${from}, ${to})`;
}

/** An icon's box: the rows' hover and selected fills (a draft's amber tint, as its row's), the listbox's keyboard ring. */
export function railTileClass(selected: boolean, cursor: boolean, draft = false): string {
  return cn(
    "relative flex h-[26px] w-7 shrink-0 cursor-default items-center justify-center rounded-md outline-none select-none",
    draft
      ? selected
        ? "bg-cf-warning/20"
        : "bg-cf-warning-surface hover:bg-cf-warning/15"
      : selected
        ? "bg-cf-sidebar-row-selected"
        : "hover:bg-cf-sidebar-row-hover",
    cursor && "group-focus:ring-1 group-focus:ring-cf-focus group-focus:ring-inset",
  );
}
