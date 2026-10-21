import { describe, expect, it } from "vitest";
import { rowItemIds } from "./rowItemIds";

describe("rowItemIds", () => {
  it.each<[string, unknown, string[]]>([
    ["a user row", { type: "user", key: "u", id: "i1" }, ["i1"]],
    ["a group", { type: "group", key: "g", ids: ["a", "b"], names: ["Read", "Grep"] }, ["a", "b"]],
    [
      "a tool with its permission and children",
      { type: "tool", key: "t", id: "t1", name: "Agent", permissionId: "p1", children: [{ type: "text", key: "x", id: "c1" }] },
      ["t1", "p1", "c1"],
    ],
    ["a strip, deduplicated", { type: "strip", key: "s", nodes: [{ type: "tool", id: "a" }], latest: { type: "tool", id: "a" } }, ["a"]],
    ["a live header (empty id)", { type: "header", key: "h", id: "", turn: "" }, []],
    ["not an object", null, []],
  ])("%s", (_, row, want) => {
    expect(rowItemIds(row)).toEqual(want);
  });
});
