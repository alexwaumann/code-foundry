import { describe, expect, it } from "vitest";
import { plainLine, plainName, plainPath } from "./plainText";

describe("plainLine", () => {
  it.each([
    ["plain text", "Put the key on line 2.", "Put the key on line 2."],
    ["newlines, tabs and a line separator", "a\n\n\tb c\r\nd", "a b c d"],
    ["sixty newlines", `Code Foundry${"\n".repeat(60)}Session expired`, "Code Foundry Session expired"],
    ["leading and trailing space", "\n  a  \n", "a"],
    ["control characters", "a\u0000\u001b[31mb\u007f", "a[31mb"],
    ["bidi overrides and isolates", "a‮b⁦c‏d", "abcd"],
    ["zero-width and tag characters", "a​b\u{e0041}d", "abd"],
    ["a tower of combining marks", `a${"́".repeat(480)}b`, "á́́b"],
    ["marks a language needs", "Việt ngữ, कि", "Việt ngữ, कि"],
    ["only what goes", "\n‮\n", ""],
  ])("%s", (_name, text, want) => {
    expect(plainLine(text)).toBe(want);
  });
});

describe("plainPath", () => {
  it("leaves a short path", () => {
    expect(plainPath("~/Public/drop.txt")).toBe("~/Public/drop.txt");
  });

  it("cuts a long one from the middle, cleaned, with the end still readable", () => {
    const shown = plainPath(`~/${"x/".repeat(480)}\u202edrop.txt`);
    expect(Array.from(shown)).toHaveLength(72);
    expect(shown.startsWith("~/x/x/")).toBe(true);
    expect(shown).toContain("…");
    expect(shown.endsWith("/drop.txt")).toBe(true);
    expect(shown).not.toContain("\u202e");
  });
});

describe("plainName", () => {
  it("leaves a short name, cleaned", () => {
    expect(plainName("Set‮ up\nbilling")).toBe("Set up billing");
  });

  it("cuts a long one by characters", () => {
    expect(plainName("😀".repeat(60), 3)).toBe("😀😀😀…");
  });
});
