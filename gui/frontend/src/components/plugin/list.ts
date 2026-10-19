/** How a list of view nodes is spaced (NodeList), shared with the containers that lay out nodes like the list around them. */
import { createContext, useContext } from "react";

/** Whether the list being drawn is inside a section (6 px apart) rather than at a level of its own (12 px). */
export const InnerList = createContext(false);

/**
 * The spacing of the list a node is in: columns and panes lay their nodes out like the
 * list around them, so a stacked columns node reads as one list.
 */
export function useInnerList(): boolean {
  return useContext(InnerList);
}

/** The gap between the nodes of a list: 12 px at the top level, 6 px inside sections and cards. */
export function listGap(inner: boolean): string {
  return inner ? "gap-1.5" : "gap-3";
}

/**
 * Whether the list being drawn is its box's own list (docs/notes/plugins-layout-2-grid-inline.md):
 * the surface's top-level list, or a pane's with a px or fill height. Such a list is at
 * least as tall as its box, so a flex spacer in it pushes the nodes after it to the box's
 * bottom. Any other list (a section's, a column's, a grid item's) is not.
 */
export const BoxList = createContext(false);

/** Whether the node is in its box's own list (a flex spacer grows only there). */
export function useBoxList(): boolean {
  return useContext(BoxList);
}
