import type { Selection } from "@tiptap/pm/state";
import { TAG_NODE } from "./tagContext";

/**
 * The attachment id of the image chip the selection is exactly, or null: a NodeSelection
 * of a chip (a click on it), or a text range over just that chip (Shift+Arrow next to it,
 * since the plain arrows step over tags). Other tags have no preview: null.
 */
export function selectedChipId(sel: Selection): string | null {
  if (sel.empty) return null;
  const { $from, to } = sel;
  const node = $from.nodeAfter;
  if (node?.type.name !== TAG_NODE || $from.pos + node.nodeSize !== to) return null;
  if (node.attrs.kind !== "image") return null;
  return String(node.attrs.id ?? "");
}
