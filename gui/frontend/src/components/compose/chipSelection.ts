import type { Selection } from "@tiptap/pm/state";
import { CHIP_NODE } from "./chipContext";

/**
 * The attachment id of the chip the selection is exactly, or null: a NodeSelection of a
 * chip (a click on it), or a text range over just that chip (Shift+Arrow next to it,
 * since the plain arrows step over chips).
 */
export function selectedChipId(sel: Selection): string | null {
  if (sel.empty) return null;
  const { $from, to } = sel;
  const node = $from.nodeAfter;
  if (node?.type.name !== CHIP_NODE || $from.pos + node.nodeSize !== to) return null;
  return String(node.attrs.id ?? "");
}
