import { describe, expect, it } from "vitest";
import { tagAttrs, tagOf } from "./tagContext";

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
