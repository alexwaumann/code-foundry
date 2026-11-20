import { describe, expect, it } from "vitest";
import { fileTagTip, tagAttrs, tagOf } from "./tagContext";

describe("a file tag's node attributes", () => {
  it("carry the line as text and read it back", () => {
    const attrs = tagAttrs({ tagKind: "file", projectId: "r1", path: "src/a.ts", line: 24 });
    expect(attrs.line).toBe("24");
    expect(tagOf({ ...attrs })).toEqual({ tagKind: "file", projectId: "r1", path: "src/a.ts", line: 24 });
  });

  it("a node from before lines (no line attribute, or the default \"\") is a file without one", () => {
    expect(tagOf({ kind: "file", projectId: "r1", path: "src/a.ts" })).toEqual({ tagKind: "file", projectId: "r1", path: "src/a.ts" });
    expect(tagOf({ ...tagAttrs({ tagKind: "file", projectId: "r1", path: "src/a.ts" }) })).toEqual({ tagKind: "file", projectId: "r1", path: "src/a.ts" });
    expect(tagOf({ kind: "file", projectId: "r1", path: "a.ts", line: "x" })).toEqual({ tagKind: "file", projectId: "r1", path: "a.ts" });
  });
});

describe("a file tag's tooltip", () => {
  it.each([
    { name: "a nested file shows its path", label: "a.ts", path: "src/a.ts", line: undefined, multi: false, want: "src/a.ts" },
    { name: "a nested file at a line", label: "a.ts:24", path: "src/a.ts", line: 24, multi: false, want: "src/a.ts:24" },
    { name: "a root file repeats its label: none", label: "README.md", path: "README.md", line: undefined, multi: false, want: null },
    { name: "a root file at a line: none", label: "README.md:3", path: "README.md", line: 3, multi: false, want: null },
    { name: "a root folder: none", label: "docs/", path: "docs/", line: undefined, multi: false, want: null },
    { name: "a root file in a multi-project draft names the project", label: "README.md", path: "README.md", line: undefined, multi: true, want: "api/README.md" },
  ])("$name", ({ label, path, line, multi, want }) => {
    expect(fileTagTip({ label, project: "api", path, line, multi })).toBe(want);
  });
});
