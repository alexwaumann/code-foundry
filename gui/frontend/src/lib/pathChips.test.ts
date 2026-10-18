import { describe, expect, it } from "vitest";
import { chipTarget, matchPath, rehypePathChips, splitProse, type PathContext } from "./pathChips";

describe("matchPath: chips", () => {
  it.each<[string, PathContext, string, number?, number?]>([
    ["gui/frontend/src/surfaces/registry.ts:22", "code", "gui/frontend/src/surfaces/registry.ts", 22],
    ["gui/frontend/src/surfaces/registry.ts:22", "prose", "gui/frontend/src/surfaces/registry.ts", 22],
    ["/Users/alex/.code-foundry/config.toml", "prose", "/Users/alex/.code-foundry/config.toml"],
    ["~/notes.md", "prose", "~/notes.md"],
    ["docs/ARCHITECTURE.md", "prose", "docs/ARCHITECTURE.md"],
    ["README.md", "prose", "README.md"],
    ["package.json", "code", "package.json"],
    ["Makefile", "code", "Makefile"],
    [".gitignore", "code", ".gitignore"],
    ["src/a.ts:12:5", "code", "src/a.ts", 12, 5],
    ["src/a.ts:12-30", "code", "src/a.ts", 12],
    ["./scripts/build", "prose", "./scripts/build"],
    ["../other/x", "code", "../other/x"],
    ["/etc/hosts", "prose", "/etc/hosts"],
    ["/config.toml", "code", "/config.toml"],
    ["internal/store/thread", "code", "internal/store/thread"],
    ["internal/store/thread", "prose", "internal/store/thread"],
    ["internal/store", "code", "internal/store"],
    ["src/components/", "code", "src/components/"],
    ["src/components/", "prose", "src/components/"],
    ["docs/", "code", "docs/"],
    ["next.config.js", "prose", "next.config.js"],
    [".github/workflows/ci.yml", "prose", ".github/workflows/ci.yml"],
    ["docs.rs/foo.md", "code", "docs.rs/foo.md"],
    ["node_modules/@types/node/index.d.ts", "code", "node_modules/@types/node/index.d.ts"],
  ])("%s (%s) → %s", (token, where, path, line, col) => {
    const m = matchPath(token, where);
    expect(m).toEqual({ text: token, path, ...(line !== undefined && { line }), ...(col !== undefined && { col }) });
  });
});

describe("matchPath: not chips", () => {
  it.each<[string, PathContext]>([
    ["https://github.com/a/b", "code"],
    ["file:///Users/a.md", "code"],
    ["github.com/a/b", "prose"],
    ["www.example.org/a/b", "code"],
    ["react-markdown", "code"],
    ["@pierre/diffs", "code"],
    ["go test ./...", "code"],
    ["./...", "code"],
    ["-rf", "code"],
    ["src/**/*.ts", "code"],
    ["$HOME/x", "code"],
    ["a && b/c.ts", "code"],
    ["fn(a/b.ts)", "code"],
    ["std::fs", "code"],
    ["and/or", "prose"],
    ["client/server", "prose"],
    ["internal/store", "prose"],
    ["docs/", "prose"],
    ["origin/main", "code"],
    ["cf/file-viewer-4-chips", "code"],
    ["application/json", "code"],
    ["1/2", "code"],
    ["10/17/2026", "prose"],
    ["/compact", "code"],
    ["/", "code"],
    ["~", "code"],
    ["~/", "code"],
    ["..", "code"],
    ["Node.js", "prose"],
    ["console.log", "code"],
    ["v1.5.2", "prose"],
    ["e.g", "prose"],
    ["src/a.ts:0", "code"],
    ["README.md#usage", "code"],
  ])("%s (%s)", (token, where) => {
    expect(matchPath(token, where)).toBeNull();
  });
});

describe("splitProse", () => {
  it("cuts chips out of a sentence, punctuation left in the text", () => {
    expect(splitProse("See (src/a.ts:12), then ~/notes.md.")).toEqual([
      "See (",
      { text: "src/a.ts:12", path: "src/a.ts", line: 12 },
      "), then ",
      { text: "~/notes.md", path: "~/notes.md" },
      ".",
    ]);
  });

  it.each(["Nothing to see here", "Use and/or the client/server split.", "Visit https://example.com/a/b.md now"])("null without chips: %s", (text) => {
    expect(splitProse(text)).toBeNull();
  });

  it("keeps a chip at the very start and end", () => {
    expect(splitProse("README.md and docs/ARCHITECTURE.md")).toEqual([
      { text: "README.md", path: "README.md" },
      " and ",
      { text: "docs/ARCHITECTURE.md", path: "docs/ARCHITECTURE.md" },
    ]);
  });
});

describe("chipTarget", () => {
  const place = { project: "p1", base: "/w" };
  it.each<[string, number | undefined, string]>([
    ["src/a.ts", 12, "/w/src/a.ts"],
    ["../x/b.go", undefined, "/x/b.go"],
    ["/abs/c.md", undefined, "/abs/c.md"],
    ["~/notes.md", undefined, "~/notes.md"],
    ["./docs/", undefined, "/w/docs"],
  ])("%s resolves to %s", (path, line, want) => {
    expect(chipTarget({ path, ...(line !== undefined && { line }) }, place)).toEqual({ project: "p1", base: "/w", path: want, ...(line !== undefined && { line }) });
  });

  it("resolves against home for a thread without a project", () => {
    expect(chipTarget({ path: "notes/todo.md" }, { project: "", base: "/Users/a" })).toEqual({ project: "", base: "/Users/a", path: "/Users/a/notes/todo.md" });
  });
});

describe("rehypePathChips", () => {
  it("marks prose paths, not code or links", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "p", children: [{ type: "text", value: "Edit src/a.ts now" }] },
        { type: "element", tagName: "a", children: [{ type: "text", value: "src/b.ts" }] },
        { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [{ type: "text", value: "src/c.ts" }] }] },
      ],
    };
    rehypePathChips()(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "Edit " },
      { type: "element", tagName: "span", properties: { dataCfPath: "src/a.ts" }, children: [{ type: "text", value: "src/a.ts" }] },
      { type: "text", value: " now" },
    ]);
    expect(tree.children[1]?.children).toEqual([{ type: "text", value: "src/b.ts" }]);
    expect(tree.children[2]?.children[0]).toEqual({ type: "element", tagName: "code", children: [{ type: "text", value: "src/c.ts" }] });
  });
});
