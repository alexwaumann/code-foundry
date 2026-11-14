/** Pane trees for the shell geometry tests (src/shell/geometry). */
import type { GeoNode, GeoPane, GeoSplit, GeoTab } from "@/shell/geometry/types";

/** A pane whose tabs are `kind` or `kind:thread`; the first is active. Tab ids are `<pane>/<n>`. */
export function pane(id: string, ...tabs: string[]): GeoPane {
  const list: GeoTab[] = tabs.map((spec, i) => {
    const [kind = "", thread] = spec.split(":");
    return { id: `${id}/${String(i)}`, kind, ...(thread ? { thread } : {}) };
  });
  return { t: "pane", id, tabs: list, ...(list[0] ? { active: list[0].id } : {}) };
}

function split(dir: "row" | "col", id: string, sizes: number[], kids: GeoNode[]): GeoSplit {
  return { t: "split", id, dir, kids, sizes };
}

export const row = (id: string, sizes: number[], ...kids: GeoNode[]) => split("row", id, sizes, kids);
export const col = (id: string, sizes: number[], ...kids: GeoNode[]) => split("col", id, sizes, kids);

/** A small seeded random generator (mulberry32), so a failing tree can be found again. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ["thread", "terminal", "diff", "file", "prs", "projects", "compose"];

/** A random tree in normal form: splits alternate direction, sizes are positive and sum to 1. */
export function randomTree(rand: () => number, maxDepth = 3): GeoNode {
  let next = 0;
  const grow = (depth: number, dir: "row" | "col"): GeoNode => {
    if (depth >= maxDepth || rand() < 0.35) {
      const id = `p-${String(next++)}`;
      const tabs = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const kind = KINDS[Math.floor(rand() * KINDS.length)] ?? "thread";
        return kind === "thread" || rand() < 0.5 ? `${kind}:th-${String(Math.floor(rand() * 6))}` : kind;
      });
      return pane(id, ...tabs);
    }
    const n = 2 + Math.floor(rand() * 3);
    const raw = Array.from({ length: n }, () => 0.1 + rand());
    const sum = raw.reduce((s, v) => s + v, 0);
    const other = dir === "row" ? "col" : "row";
    return split(dir, `s-${String(next++)}`, raw.map((v) => v / sum), Array.from({ length: n }, () => grow(depth + 1, other)));
  };
  return grow(0, rand() < 0.5 ? "row" : "col");
}
