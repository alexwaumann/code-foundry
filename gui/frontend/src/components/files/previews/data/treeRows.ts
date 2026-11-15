/**
 * The JSON tree's visible rows (JsonTree.tsx): the open containers' children, depth first,
 * flattened so the tree virtualizes like a list. The root is not a row; its children are,
 * at depth 0 (a scalar or empty root is one row of its own). Which containers are open is a
 * set of nodes, so a parse's identity is the tree's state. Pure.
 */
import { childCount, type JsonNode } from "./json";

export interface TreeRow {
  readonly node: JsonNode;
  /** An object member's key, an array item's index, or null for the root shown as a row. */
  readonly key: string | number | null;
  readonly depth: number;
  /** The row of the container this one is in; -1 at depth 0. */
  readonly parent: number;
  /** An object or array with children: it opens and closes. */
  readonly container: boolean;
  readonly open: boolean;
}

function children(node: JsonNode): (readonly [string | number, JsonNode])[] {
  if (node.t === "object") return node.entries.map(([k, v]) => [k, v] as const);
  if (node.t === "array") return node.items.map((v, i) => [i, v] as const);
  return [];
}

export function treeRows(root: JsonNode, open: ReadonlySet<JsonNode>): TreeRow[] {
  if (childCount(root) === 0) return [{ node: root, key: null, depth: 0, parent: -1, container: false, open: false }];
  const rows: TreeRow[] = [];
  const walk = (node: JsonNode, depth: number, parent: number) => {
    for (const [key, child] of children(node)) {
      const container = childCount(child) > 0;
      const isOpen = container && open.has(child);
      const at = rows.length;
      rows.push({ node: child, key, depth, parent, container, open: isOpen });
      if (isOpen) walk(child, depth + 1, at);
    }
  };
  walk(root, 0, -1);
  return rows;
}

/**
 * The containers a tree opens with: breadth first, those whose rows are at most `maxDepth`
 * deep, while the rows shown stay within `budget`. The Tree preview opens the top level
 * (depth 0); an expanded JSON Lines record opens as deep as its budget allows.
 */
export function initialOpen(root: JsonNode, maxDepth: number, budget: number): Set<JsonNode> {
  const open = new Set<JsonNode>();
  let shown = Math.max(1, childCount(root));
  let level: JsonNode[] = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: JsonNode[] = [];
    for (const parent of level) {
      for (const [, child] of children(parent)) {
        const n = childCount(child);
        if (n === 0 || shown + n > budget) continue;
        open.add(child);
        shown += n;
        next.push(child);
      }
    }
    level = next;
  }
  return open;
}
