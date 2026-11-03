import { describe, expect, it } from "vitest";
import { snippetOf } from "./search";

// The mock's snippets follow the daemon's cutSnippet (internal/store/thread
// search_match.go, TestSnippetOf): the same cases, in code points.
const long = "alpha beta gamma ".repeat(20); // 340 characters

function cut(text: string, needle: string) {
  const cps = Array.from(text);
  const n = Array.from(needle);
  const at = cps.findIndex((_, i) => n.every((c, k) => cps[i + k] === c));
  const got = snippetOf(text, [{ start: at, end: at + n.length }]);
  return { ...got, matched: got.ranges.map((r) => Array.from(got.snippet).slice(r.start, r.end).join("")) };
}

describe("snippetOf (the daemon's cut)", () => {
  it("returns a short text whole", () => {
    expect(snippetOf("alpha beta gamma", [{ start: 6, end: 10 }])).toEqual({ snippet: "alpha beta gamma", ranges: [{ start: 6, end: 10 }] });
  });

  it("cuts a match at the start at its end, at a word", () => {
    const got = cut(`needle ${long}`, "needle");
    expect(got.snippet).toBe(`needle ${"alpha beta gamma ".repeat(8)}alpha beta gamma…`);
    expect(got.ranges).toEqual([{ start: 0, end: 6 }]);
  });

  it("cuts a match deep in a long text at both ends, at words, the match at most BEFORE in", () => {
    const got = cut(`${long}the needle is here ${long}`, "needle");
    const cps = Array.from(got.snippet);
    expect(got.snippet.startsWith("…") && got.snippet.endsWith("…")).toBe(true);
    expect(cps.length).toBeLessThanOrEqual(162);
    expect(got.matched).toEqual(["needle"]);
    expect(got.ranges[0]?.start).toBeLessThanOrEqual(50);
    // Starts at a word.
    expect(got.snippet.slice(1)).toMatch(/^(alpha|beta|gamma|the) /);
  });

  it("near the end moves the start back, so the match sits far in (what fitSnippet is for)", () => {
    const got = cut(`${long}the needle`, "needle");
    expect(got.snippet.endsWith("the needle")).toBe(true);
    expect(Array.from(got.snippet)).toHaveLength(161);
    expect(got.ranges[0]?.start).toBe(155);
    expect(got.matched).toEqual(["needle"]);
  });

  it("counts an emoji as one code point", () => {
    const got = cut(`${"🐛 ".repeat(100)}needle ${"🐛 ".repeat(100)}`, "needle");
    expect(got.matched).toEqual(["needle"]);
    expect(Array.from(got.snippet).length).toBeLessThanOrEqual(162);
  });
});
