import { describe, expect, it } from "vitest";
import {
  chipInsertText,
  chipToken,
  formatAttachmentSize,
  isReferenced,
  middleTruncate,
  parsePrompt,
  projectPrompt,
  proseOf,
  referencedIds,
  removeReferences,
  serializePrompt,
} from "./prompt";

const A = chipToken("a1", "shot.png");
const B = chipToken("a2", "logo.webp");

describe("prompt tokens", () => {
  it("round-trips text with chips across lines", () => {
    const text = `Compare ${A} with\n\n${B} and ${A}`;
    const lines = parsePrompt(text);
    expect(lines).toEqual([
      [{ kind: "text", text: "Compare " }, { kind: "chip", id: "a1", name: "shot.png" }, { kind: "text", text: " with" }],
      [],
      [{ kind: "chip", id: "a2", name: "logo.webp" }, { kind: "text", text: " and " }, { kind: "chip", id: "a1", name: "shot.png" }],
    ]);
    expect(serializePrompt(lines)).toBe(text);
    expect(referencedIds(text)).toEqual(["a1", "a2"]);
    expect(isReferenced(text, "a2")).toBe(true);
    expect(isReferenced(text, "a3")).toBe(false);
    expect(proseOf(text)).toBe("Compare  with\n\n and ");
  });

  it("cleans labels that would break the token", () => {
    expect(chipToken("a1", "we[ir]d;\nname.png")).toBe("![we ir d name.png](cf-attachment://a1)");
    expect(chipToken("a1", "")).toBe("![image](cf-attachment://a1)");
  });

  it.each([
    ["the following space goes with it", `Look ${A} here`, "Look here"],
    ["else the preceding one", `Look at ${A}`, "Look at"],
    ["every occurrence", `${A} and ${A} and ${B}`, `and and ${B}`],
    ["trailing whitespace is trimmed", `Fix ${A} \n`, "Fix"],
    ["other text is untouched", `Fix ${B}`, `Fix ${B}`],
  ])("removeReferences: %s", (_name, text, want) => {
    expect(removeReferences(text, "a1")).toBe(want);
  });

  it("projects chips to [Image: name; ref=path] at their position", () => {
    const text = `Match ${A} and ${B}\nthanks`;
    const staged: Record<string, { name: string; ref: string }> = { a1: { name: "shot.png", ref: "/att/1.png" } };
    expect(projectPrompt(text, (id) => staged[id])).toBe("Match [Image: shot.png; ref=/att/1.png] and [Image: logo.webp]\nthanks");
  });
});

describe("chip presentation", () => {
  it.each([
    [0, "1 KB"],
    [300, "1 KB"],
    [58 * 1024, "58 KB"],
    [58 * 1024 + 1, "59 KB"],
    [1024 * 1024, "1.0 MB"],
    [1.44 * 1024 * 1024, "1.4 MB"],
  ])("formatAttachmentSize(%d) = %s", (bytes, want) => {
    expect(formatAttachmentSize(bytes)).toBe(want);
  });

  it("middle-truncates long names keeping the end", () => {
    expect(middleTruncate("image.png")).toBe("image.png");
    const long = "Screenshot 2026-10-09 at 14.31.07 (2).png";
    const t = middleTruncate(long);
    expect(Array.from(t)).toHaveLength(36);
    expect(t.endsWith(" 14.31.07 (2).png".slice(-14))).toBe(true);
    expect(t).toContain("…");
  });
});

describe("chipInsertText", () => {
  it.each<[string, string[], string, { hasProse: boolean; replacingSelection: boolean }, string | null]>([
    ["nothing into an empty prompt", [A], "", { hasProse: false, replacingSelection: false }, null],
    ["a replaced selection gets one even without prose", [A], "", { hasProse: false, replacingSelection: true }, `${A} `],
    ["a leading space after a word", [A], "Fix", { hasProse: true, replacingSelection: false }, ` ${A} `],
    ["no leading space after whitespace", [A], "Fix ", { hasProse: true, replacingSelection: false }, `${A} `],
    ["several joined by spaces", [A, B], "", { hasProse: true, replacingSelection: false }, `${A} ${B} `],
    ["none to insert", [], "x", { hasProse: true, replacingSelection: false }, null],
  ])("%s", (_name, tokens, before, opts, want) => {
    expect(chipInsertText(tokens, before, opts)).toBe(want);
  });
});
