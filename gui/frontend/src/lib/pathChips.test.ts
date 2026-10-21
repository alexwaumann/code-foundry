import { describe, expect, it } from "vitest";
import { chipTarget, isRelativeHref, linkPath, projectPlace, matchPath, rehypePathChips, splitProse, type PathContext } from "./pathChips";

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
    ["main..cf/x", "code"],
    ["origin/main...cf/combine-tally-flag-branches", "code"],
    ["HEAD~3..HEAD/x.ts", "prose"],
  ])("%s (%s)", (token, where) => {
    expect(matchPath(token, where)).toBeNull();
  });
});

describe("matchPath: paths with spaces (a code span, quotes, a line of their own)", () => {
  it.each<[string, PathContext, string, number?]>([
    ["docs/my report.pdf", "code", "docs/my report.pdf"],
    ["shots/screen shot.png", "code", "shots/screen shot.png"],
    ["docs/my report.pdf", "prose", "docs/my report.pdf"],
    ["/Users/a/cf scratch/docs/my report.pdf:3", "code", "/Users/a/cf scratch/docs/my report.pdf", 3],
    ["~/Downloads/report (1).pdf", "code", "~/Downloads/report (1).pdf"],
    ["/Users/a/Desktop/Screenshot 2026-10-18 at 10.42.13\u202fAM.png", "prose", "/Users/a/Desktop/Screenshot 2026-10-18 at 10.42.13\u202fAM.png"],
    ["./my notes/todo list.md", "prose", "./my notes/todo list.md"],
    ["../shared docs/plan v2.md", "code", "../shared docs/plan v2.md"],
  ])("%s (%s) → %s", (token, where, path, line) => {
    expect(matchPath(token, where)).toEqual({ text: token, path, ...(line !== undefined && { line }) });
  });

  it.each<[string, string]>([
    ["npm run build", "a command"],
    ["cat docs/a.md", "a command: a space before the first slash"],
    ["open shots/screen shot.png", "a command on a spaced path"],
    ["My Documents/a.md", "a relative path with a space before its first slash"],
    ["screen shot.png", "a bare name: no slash"],
    ["src/a.ts src/b.ts", "two paths"],
    ["src/a.ts and src/b.ts", "two paths in words"],
    ["/bin/cat /tmp/a b.md", "a later word starts like a path"],
    ["/usr/bin/env -S node.js", "a flag"],
    ["rm -rf ./a b.md", "a command with a flag"],
    ["/usr/bin/env node", "no known extension"],
    ["docs/my reports/", "a folder"],
    ["docs/my  report.pdf", "two spaces in a row"],
    ["docs/report (1.pdf", "unbalanced parentheses"],
    ["docs/my\treport.pdf", "a tab"],
    ["https://x.com/my report.pdf", "a URL"],
  ])("%s: not a chip (%s)", (token) => {
    expect(matchPath(token, "code")).toBeNull();
  });
});

describe("linkPath (relative links in Claude's answers)", () => {
  it.each<[string, { path: string; line?: number; text: string } | null]>([
    ["src/main.go", { path: "src/main.go", text: "src/main.go" }],
    ["./docs/a.md#L3", { path: "./docs/a.md", line: 3, text: "./docs/a.md:3" }],
    ["internal/x.go#L12-L30", { path: "internal/x.go", line: 12, text: "internal/x.go:12" }],
    ["/Users/me/src/a.go:7", { path: "/Users/me/src/a.go", line: 7, text: "/Users/me/src/a.go:7" }],
    ["docs/My%20Notes.md#intro", { path: "docs/My Notes.md", text: "docs/My Notes.md" }],
    ["README.md?plain=1", { path: "README.md", text: "README.md" }],
    // Not a path: plain text.
    ["about", null],
    ["#section", null],
    ["https://example.com/a.go", null],
    ["//cdn.example.com/a.js", null],
    ["mailto:a@b.c", null],
    ["%E0%A4%A", null],
  ])("%s", (href, want) => {
    const m = linkPath(href);
    if (want === null) expect(m).toBeNull();
    else expect(m).toMatchObject(want);
  });

  it("isRelativeHref", () => {
    expect(isRelativeHref("a/b")).toBe(true);
    expect(isRelativeHref("/a/b")).toBe(true);
    expect(isRelativeHref("http://x")).toBe(false);
    expect(isRelativeHref("#x")).toBe(false);
    expect(isRelativeHref("")).toBe(false);
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

  const chip = (path: string) => ({ text: path, path });

  it.each<[string, string, ReturnType<typeof splitProse>]>([
    ["straight quotes", 'Open "docs/my report.pdf" now', ['Open "', chip("docs/my report.pdf"), '" now']],
    ["curly quotes, a stop inside", "See “shots/screen shot.png.”", ["See “", chip("shots/screen shot.png"), ".”"]],
    ["single quotes", "the file 'docs/my report.pdf' has one page", ["the file '", chip("docs/my report.pdf"), "' has one page"]],
    [
      "lines that are only paths",
      "/Users/a/docs/my report.pdf\n/Users/a/shots/screen shot.png\n\nThe PDF is bigger.",
      [chip("/Users/a/docs/my report.pdf"), "\n", chip("/Users/a/shots/screen shot.png"), "\n\nThe PDF is bigger."],
    ],
    ["the rest of a line after a label (a text node after <strong>)", " /Users/a/my report.pdf.", [" ", chip("/Users/a/my report.pdf"), "."]],
    ["a bracketed line", "(docs/my report.pdf)", ["(", chip("docs/my report.pdf"), ")"]],
    // A two-segment folder is no prose chip (the word rules), so these keep the one chip they had.
    ["a folder then a file in a sentence keeps its chips", "the files in src/components like Button.tsx", ["the files in src/components like ", chip("Button.tsx")]],
    ["a folder then a file to add keeps its chips", "in internal/store add thread.go", ["in internal/store add ", chip("thread.go")]],
    ["a deeper folder then a file keeps both chips", "the files in src/components/ui like Button.tsx", ["the files in ", chip("src/components/ui"), " like ", chip("Button.tsx")]],
    ["a deeper folder then a file to add keeps both chips", "in internal/store/thread add stream.go", ["in ", chip("internal/store/thread"), " add ", chip("stream.go")]],
    ["a program then a file keeps both chips", "Run /usr/bin/python3 on main.py today", ["Run ", chip("/usr/bin/python3"), " on ", chip("main.py"), " today"]],
    [
      "a bare spaced path in a sentence is left to the word pass (its pieces, as before)",
      "I saved it to /Users/a/docs/my report.pdf for you.",
      ["I saved it to ", chip("/Users/a/docs/my"), " ", chip("report.pdf"), " for you."],
    ],
    ["a bare relative one: the word pass finds only the name", "Open docs/my report.pdf now", ["Open docs/my ", chip("report.pdf"), " now"]],
    ["quotes around words, not a path", 'He said "hello there" about src/a.ts', ['He said "hello there" about ', chip("src/a.ts")]],
    ["apostrophes are not quotes", "Alex's notes and Sam's docs/my report.pdf", ["Alex's notes and Sam's docs/my ", chip("report.pdf")]],
    ["a run stops at a line break", "/usr/bin/env node\nnpm run build.md", [chip("/usr/bin/env"), " node\nnpm run ", chip("build.md")]],
  ])("%s", (_name, text, want) => {
    expect(splitProse(text)).toEqual(want);
  });

  it("keeps a chip at the very start and end", () => {
    expect(splitProse("README.md and docs/ARCHITECTURE.md")).toEqual([
      { text: "README.md", path: "README.md" },
      " and ",
      { text: "docs/ARCHITECTURE.md", path: "docs/ARCHITECTURE.md" },
    ]);
  });
});

describe("projectPlace", () => {
  const roots = [
    { project: "p1", path: "/Users/a/code/app" },
    { project: "p1", path: "/Users/a/.code-foundry/worktrees/app/cf-x/" },
    { project: "p2", path: "/Users/a/code/app-docs" },
  ];
  it.each<[string, { project: string; base: string } | null]>([
    ["/Users/a/code/app/README.md", { project: "p1", base: "/Users/a/code/app" }],
    ["/Users/a/code/app", { project: "p1", base: "/Users/a/code/app" }],
    ["/Users/a/.code-foundry/worktrees/app/cf-x/src/a.ts", { project: "p1", base: "/Users/a/.code-foundry/worktrees/app/cf-x" }],
    ["/Users/a/code/app-docs/x.md", { project: "p2", base: "/Users/a/code/app-docs" }],
    ["/Users/a/code/other/x.md", null],
    ["README.md", null],
    ["~/code/app/README.md", null],
  ])("%s", (path, want) => {
    expect(projectPlace(roots, path)).toEqual(want);
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

  it("marks a quoted spaced path whole", () => {
    const tree = { type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value: 'It is in "docs/my report.pdf".' }] }] };
    rehypePathChips()(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: 'It is in "' },
      { type: "element", tagName: "span", properties: { dataCfPath: "docs/my report.pdf" }, children: [{ type: "text", value: "docs/my report.pdf" }] },
      { type: "text", value: '".' },
    ]);
  });
});
