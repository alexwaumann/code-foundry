import { describe, expect, it } from "vitest";

import { nameMatch, rankPickerRows, type PickerRow } from "./useProjectRows";

const project = (name: string, path: string): PickerRow => ({ kind: "project", id: name, value: name, name, text: `${name} ${path} Local only` });
const workspace = (name: string, members: string[]): PickerRow => ({ kind: "workspace", id: name, value: `ws:${name}`, name, text: [name, ...members].join(" ") });

// The default order: No project, workspaces, projects.
const rows: PickerRow[] = [
  { kind: "none", value: "home", name: "No project", text: "No project home ~" },
  workspace("demo", ["alpha", "beta"]),
  workspace("beta-tools", ["alpha"]),
  project("alpha", "~/src/alpha"),
  project("beta", "~/src/beta"),
  project("my-beta", "~/src/my-beta"),
  project("notes", "~/src/beta-notes"),
];
const names = (query: string) => rankPickerRows(rows, query).map((r) => r.name);

describe("nameMatch", () => {
  it.each([
    ["beta", "beta", 3],
    ["Beta", "beta", 3],
    ["beta-tools", "beta", 2],
    ["my-beta", "beta", 1],
    ["code foundry", "fou", 1],
    ["demo", "beta", 0],
    ["alphabet", "bet", 0],
  ] as const)("%s for %s: %i", (name, query, want) => {
    expect(nameMatch(name, query)).toBe(want);
  });
});

describe("rankPickerRows", () => {
  it("keeps every row in the default order for an empty query", () => {
    expect(rankPickerRows(rows, "  ")).toBe(rows);
  });

  it("puts the project of that name first, then names that start with it, then a word in a name, then rows found by a keyword", () => {
    expect(names("beta")).toEqual(["beta", "beta-tools", "my-beta", "demo", "notes"]);
  });

  it("a workspace found only by a member comes after the member itself", () => {
    const got = names("alpha");
    expect(got[0]).toBe("alpha");
    expect(got.indexOf("alpha")).toBeLessThan(got.indexOf("demo"));
  });

  it("a workspace named by the query comes first", () => {
    expect(names("demo")[0]).toBe("demo");
  });

  it("hides rows that do not match", () => {
    expect(names("zzz")).toEqual([]);
  });
});
