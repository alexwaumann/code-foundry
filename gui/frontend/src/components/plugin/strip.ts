/**
 * The view's toolbar and footer (docs/notes/plugins-layout-3-chrome.md): strips pinned
 * around the scrolling body, each one row of up to STRIP_MAX_NODES nodes of STRIP_KINDS that
 * wraps when it does not fit. The numbers and kinds are pluginsdk/ui's (MaxStripNodes,
 * StripKinds; a Go test keeps them equal).
 */
import { createContext, useContext } from "react";
import { nodeKind, type NodeKind, type ViewNode } from "@/api/plugin";

/** How many nodes a toolbar or footer holds (the daemon refuses more; the GUI draws no more). */
export const STRIP_MAX_NODES = 6;

/** The node kinds a strip holds; a form there has inputs, dropdown selects and toggles, a divider no label. */
export const STRIP_KINDS: readonly NodeKind[] = ["text", "chips", "actions", "progress", "form", "divider", "spacer", "group"];

export type StripSlot = "toolbar" | "footer";

/** The strip a node is drawn in, or null in the body: a form lays its fields out in a row there. */
export const InStrip = createContext<StripSlot | null>(null);

export function useInStrip(): StripSlot | null {
  return useContext(InStrip);
}

/**
 * How a node sits in the strip's row: a form (a search field, filters) and a progress bar
 * take the free width, an end-aligned actions bar goes to the row's end, a flex spacer takes
 * the free width (pushing what follows to the end), a group not aligned to the start takes
 * the free width to align in, and text, chips, dividers and fixed spacers are as wide as
 * their content.
 */
export function stripItemClass(n: ViewNode): string {
  switch (nodeKind(n)) {
    case "form":
      return "min-w-40 flex-1";
    case "progress":
      return "min-w-24 flex-1";
    case "actions":
      return n.actions?.align === "end" ? "ml-auto min-w-0" : "min-w-0";
    case "spacer":
      return n.spacer?.flex ? "flex-1" : "shrink-0";
    case "divider":
      return "flex shrink-0 items-center";
    case "group":
      return (n.group?.align ?? "start") === "start" ? "min-w-0" : "min-w-0 flex-1";
    default:
      return "min-w-0";
  }
}
