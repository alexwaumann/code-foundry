import { describe, expect, it } from "vitest";
import { grammarFor, grammarForPath, highlightLines, markTokens, shellTokens, treeLines } from "./highlight";

describe("grammarFor / grammarForPath", () => {
  it.each([
    ["go", "go"],
    ["TS", "typescript"],
    ["tsx", "typescript"],
    ["sh", "bash"],
    ["toml", "ini"],
    ["nope", ""],
    ["", ""],
  ])("%s → %s", (lang, want) => {
    expect(grammarFor(lang)).toBe(want);
  });
  it.each([
    ["internal/store/pr/fingerprint.go", "go"],
    ["src/App.tsx", "typescript"],
    ["Makefile", "makefile"],
    ["README", ""],
    [".gitignore", ""],
  ])("%s → %s", (path, want) => {
    expect(grammarForPath(path)).toBe(want);
  });
});

describe("highlightLines", () => {
  it("splits tokens at newlines and keeps a multi-line comment's class on each line", () => {
    const lines = highlightLines("/* a\nb */\nfunc f() {}", "go");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ text: "/* a", cls: "hljs-comment" }]);
    expect(lines[1]).toEqual([{ text: "b */", cls: "hljs-comment" }]);
    expect(lines[2]?.find((t) => t.text === "func")?.cls).toContain("hljs-keyword");
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual(["/* a", "b */", "func f() {}"]);
  });
  it("is plain text without a grammar, empty lines included", () => {
    expect(highlightLines("a\n\nb", "")).toEqual([[{ text: "a", cls: "" }], [], [{ text: "b", cls: "" }]]);
  });
  it("nests classes", () => {
    expect(treeLines({ type: "root", children: [{ type: "element", properties: { className: ["a"] }, children: [{ type: "element", properties: { className: ["b"] }, children: [{ type: "text", value: "x" }] }] }] })).toEqual([
      [{ text: "x", cls: "a b" }],
    ]);
  });
});

describe("shellTokens", () => {
  const show = (c: string) => shellTokens(c).map((t) => (t.cls ? `${t.cls}:${t.text}` : t.text));
  it("colours the command of each segment, flags and strings", () => {
    expect(show("go test ./internal/store/pr/ -run TestFingerprint")).toEqual(["sh-cmd:go", " test ./internal/store/pr/ ", "sh-flag:-run", " TestFingerprint"]);
    expect(show(`git push --force-with-lease origin cf/x && echo "done ok" | wc -l`)).toEqual([
      "sh-cmd:git",
      " push ",
      "sh-flag:--force-with-lease",
      " origin cf/x && ",
      "sh-cmd:echo",
      " ",
      'sh-str:"done ok"',
      " | ",
      "sh-cmd:wc",
      " ",
      "sh-flag:-l",
    ]);
    expect(show("FOO=1 make build")).toEqual(["FOO=1 ", "sh-cmd:make", " build"]);
    expect(shellTokens("").length).toBe(0);
  });
});

describe("markTokens", () => {
  it("cuts tokens at the span's edges", () => {
    const toks = [
      { text: "HeadOid", cls: "a" },
      { text: " string", cls: "b" },
    ];
    expect(markTokens(toks, [4, 10]).map((t) => `${t.marked ? "[" : ""}${t.text}${t.marked ? "]" : ""}`)).toEqual(["Head", "[Oid]", "[ st]", "ring"]);
    expect(markTokens(toks, undefined).every((t) => !t.marked)).toBe(true);
    expect(markTokens(toks, [3, 3]).map((t) => t.text)).toEqual(["HeadOid", " string"]);
  });
});
