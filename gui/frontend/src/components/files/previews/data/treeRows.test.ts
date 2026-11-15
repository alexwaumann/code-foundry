import { describe, expect, it } from "vitest";
import { parseJson, type JsonNode } from "./json";
import { initialOpen, treeRows } from "./treeRows";

function parse(text: string): JsonNode {
  const p = parseJson(text);
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
}

const doc = parse('{"name":"x","scripts":{"dev":"vite","build":"tsc"},"deps":{"a":{"b":1}},"tags":[1,2]}');

/** Rows as "depth key [open]". */
const show = (root: JsonNode, open: ReadonlySet<JsonNode>) => treeRows(root, open).map((r) => `${String(r.depth)} ${String(r.key)}${r.container ? (r.open ? " -" : " +") : ""}`);

describe("treeRows", () => {
  it("shows the root's children, open containers' children under them", () => {
    expect(show(doc, new Set())).toEqual(["0 name", "0 scripts +", "0 deps +", "0 tags +"]);
    const open = initialOpen(doc, 0, 400);
    expect(show(doc, open)).toEqual(["0 name", "0 scripts -", "1 dev", "1 build", "0 deps -", "1 a +", "0 tags -", "1 0", "1 1"]);
  });

  it("knows each row's parent", () => {
    const rows = treeRows(doc, initialOpen(doc, 0, 400));
    expect(rows.map((r) => r.parent)).toEqual([-1, -1, 1, 1, -1, 4, -1, 6, 6]);
  });

  it("opens deeper levels when asked, within the budget", () => {
    expect(show(doc, initialOpen(doc, Infinity, 400))).toContain("2 b");
    // 4 rows at the top; scripts (2) fits a budget of 6, deps (1) would not.
    expect(show(doc, initialOpen(doc, 0, 6))).toEqual(["0 name", "0 scripts -", "1 dev", "1 build", "0 deps +", "0 tags +"]);
  });

  it("shows a scalar or empty root as one row", () => {
    expect(treeRows(parse("42"), new Set())).toHaveLength(1);
    expect(treeRows(parse("{}"), new Set())[0]).toMatchObject({ key: null, container: false });
  });

  it("does not open a large array's items one by one", () => {
    const big = parse(`[${Array.from({ length: 5000 }, (_, i) => `{"i":${String(i)}}`).join(",")}]`);
    const open = initialOpen(big, 0, 400);
    expect(open.size).toBeLessThan(400);
    expect(treeRows(big, open).length).toBeLessThanOrEqual(5400);
  });
});
