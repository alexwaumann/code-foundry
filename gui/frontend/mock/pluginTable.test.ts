/** The mock's plugin tables (mock/pluginTable.ts) sort the captured Builds table as the real demo plugin does (plugins/examples/hello/builds_test.go). */
// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sortTable, sortValue, tableParts } from "./pluginTable";

type Node = Record<string, unknown> & { key: string };

function builds(): Node {
  const url = new URL("../../../internal/store/plugin/testdata/hello-demo/run-list.json", import.meta.url);
  const v = JSON.parse(readFileSync(url, "utf8")) as { nodes: Node[] };
  const n = v.nodes.find((x) => x.key === "builds");
  if (!n) throw new Error("no builds table");
  return n;
}

const order = (n: Node) => {
  const keys = (n.table as { rows: { key: string }[] }).rows.map((r) => r.key);
  return `${keys.slice(0, 3).join(" ")} … ${keys[keys.length - 1] ?? ""}`;
};

describe("the mock's tables", () => {
  it("index the sortable headers with the direction a click asks for, and every row", () => {
    const { sorts, rows } = tableParts(builds());
    expect(sorts).toEqual([
      { key: "b-num", node: "builds", next: "asc" },
      { key: "b-branch", node: "builds", next: "asc" },
      { key: "b-dur", node: "builds", next: "desc" },
    ]);
    expect(rows).toHaveLength(30);
  });

  it.each([
    { column: "b-num", dir: "asc", want: "b-1259 b-1260 b-1261 … b-1288" },
    { column: "b-num", dir: "desc", want: "b-1288 b-1287 b-1286 … b-1259" },
    { column: "b-dur", dir: "desc", want: "b-1285 b-1273 b-1280 … b-1270" },
    { column: "b-branch", dir: "asc", want: "b-1262 b-1269 b-1276 … b-1288" },
    { column: "b-branch", dir: "desc", want: "b-1288 b-1287 b-1286 … b-1262" },
  ] as const)("sort $column $dir as the plugin does", ({ column, dir, want }) => {
    const n = builds();
    sortTable(n, column, dir);
    expect(order(n)).toBe(want);
    expect((n.table as { sort: unknown }).sort).toEqual({ column, dir });
  });

  it("checks a sort's value as the daemon does", () => {
    expect(sortValue("", "desc")).toBe("desc");
    expect(sortValue("asc", "desc")).toBe("asc");
    expect(() => sortValue("up", "asc")).toThrow('a sort\'s value is asc or desc, not "up"');
  });
});
