import { describe, expect, it } from "vitest";
import { dirPart, extOf, fileName, normalizePath, relativeTo, resolvePath } from "./filePath";

describe("normalizePath", () => {
  it.each([
    ["/a/b/../c/./d.ts", "/a/c/d.ts"],
    ["/a//b/", "/a/b"],
    ["/../a", "/a"],
    ["/", "/"],
    ["a/../../b", "../b"],
    ["./", "."],
  ])("%s → %s", (p, want) => {
    expect(normalizePath(p)).toBe(want);
  });
});

describe("resolvePath", () => {
  it.each([
    ["/w", "src/a.ts", "/w/src/a.ts"],
    ["/w/docs", "../README.md", "/w/README.md"],
    ["/w", "/x/y/../z", "/x/z"],
    ["/w", "~/notes.md", "~/notes.md"],
    ["/w", "~", "~"],
    ["", "a.ts", "a.ts"],
  ])("(%s, %s) → %s", (base, p, want) => {
    expect(resolvePath(base, p)).toBe(want);
  });
});

describe("file name parts", () => {
  it("splits name, directory and extension", () => {
    expect(fileName("/w/src/a.test.ts")).toBe("a.test.ts");
    expect(dirPart("/w/src/a.ts")).toBe("/w/src/");
    expect(dirPart("a.ts")).toBe("");
    expect(extOf("README.MD")).toBe("md");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("Makefile")).toBe("");
  });

  it("relativeTo", () => {
    expect(relativeTo("/w/a/b.ts", "/w")).toBe("a/b.ts");
    expect(relativeTo("/w/a/b.ts", "/w/")).toBe("a/b.ts");
    expect(relativeTo("/wx/a.ts", "/w")).toBeNull();
    expect(relativeTo("/w", "/w")).toBeNull();
  });
});
