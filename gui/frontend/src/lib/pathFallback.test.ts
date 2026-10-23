import { describe, expect, it } from "vitest";
import { fallbackQuery, uniqueSuffixMatch } from "./pathFallback";

describe("fallbackQuery", () => {
  it.each([
    ["src/a.ts", "a.ts"],
    ["a.ts", "a.ts"],
    ["docs/", "docs"],
    ["gui/frontend/src/lib/x.test.ts", "x.test.ts"],
    ["", null],
    [".", null],
    ["../a.ts", null],
    ["src/../a.ts", null],
    ["/abs/a.ts", null],
  ])("%s → %s", (rel, want) => {
    expect(fallbackQuery(rel)).toBe(want);
  });
});

const m = (...paths: string[]) => paths.map((path) => ({ path }));

describe("uniqueSuffixMatch", () => {
  it.each<[string, string, ReturnType<typeof m>, boolean, string | null]>([
    ["a path written from a subfolder", "src/a.ts", m("gui/frontend/src/a.ts", "gui/frontend/src/ab.ts"), false, "gui/frontend/src/a.ts"],
    ["a path cut short", "frontend/src/a.ts", m("gui/frontend/src/a.ts", "web/src/a.ts"), false, "gui/frontend/src/a.ts"],
    ["a bare name in one place", "routes.ts", m("src/server/routes.ts", "src/server/routes.test.ts"), false, "src/server/routes.ts"],
    ["a folder", "store/", m("internal/store", "internal/store/a.go"), false, "internal/store"],
    ["two places: ambiguous", "src/a.ts", m("gui/src/a.ts", "web/src/a.ts"), false, null],
    ["a segment boundary only", "a.ts", m("src/xa.ts"), false, null],
    ["the path itself is no fallback", "src/a.ts", m("src/a.ts"), false, null],
    ["no match", "src/a.ts", m("src/b.ts"), false, null],
    ["nothing listed", "src/a.ts", [], false, null],
    ["cut short while still listing that name: maybe a second", "src/a.ts", m("x/src/a.ts", "y/a.ts"), true, null],
    ["cut short after that name's files: all were listed", "src/a.ts", m("x/src/a.ts", "y/a.ts", "y/ab.ts"), true, "x/src/a.ts"],
    ["the name compares case-insensitively for the cut", "src/A.ts", m("x/src/A.ts", "y/a.ts"), true, null],
    ["the suffix is case-sensitive", "src/a.ts", m("x/src/A.ts"), false, null],
  ])("%s", (_name, rel, matches, truncated, want) => {
    expect(uniqueSuffixMatch(rel, matches, truncated)).toBe(want);
  });
});
