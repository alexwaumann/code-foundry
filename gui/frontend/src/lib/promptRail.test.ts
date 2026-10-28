import { describe, expect, it } from "vitest";
import { promptInView, promptPreview, railGap, tickLabel } from "./promptRail";
import type { MessagePiece } from "./userMessage";

describe("railGap", () => {
  it.each<[string, number, number, number | null]>([
    ["no prompts", 0, 500, null],
    ["one prompt", 1, 500, null],
    ["two prompts, room to spare", 2, 500, 6],
    ["exactly fits at 6px (10 x 8)", 10, 80, 6],
    ["one px short of 6px: 3px", 10, 79, 3],
    ["exactly fits at 3px (20 x 5)", 20, 100, 3],
    ["one px short of 3px: 2px", 20, 99, 2],
    ["exactly fits at 2px (50 x 4)", 50, 200, 2],
    ["does not fit at all: hidden", 50, 199, null],
    ["no height (not measured yet)", 3, 0, null],
    ["many prompts in a tall body", 120, 900, 3],
  ])("%s", (_name, count, available, want) => {
    expect(railGap(count, available)).toBe(want);
  });
});

describe("promptInView", () => {
  it.each<[string, (number | undefined)[], number, boolean, number]>([
    ["none above the middle", [400, 900], 300, false, -1],
    ["first only", [28, 900], 300, false, 0],
    ["a top exactly at the middle counts", [28, 300], 300, false, 1],
    ["the last above wins", [28, 120, 250, 700], 300, false, 2],
    ["all above", [28, 120, 250], 5000, false, 2],
    ["a row not laid out is skipped", [28, undefined, 250], 300, false, 2],
    ["no prompts", [], 300, false, -1],
    ["at the end: the last, though below the middle", [28, 900], 300, true, 1],
    ["at the end with no prompts", [], 300, true, -1],
  ])("%s", (_name, starts, middle, atEnd, want) => {
    expect(promptInView(starts, middle, atEnd)).toBe(want);
  });
});

describe("promptPreview", () => {
  it.each<[string, MessagePiece[], string]>([
    ["plain text", [{ kind: "text", text: "Fix the badge" }], "Fix the badge"],
    ["whitespace collapsed", [{ kind: "text", text: "  Fix\n\nthe   badge\t " }], "Fix the badge"],
    [
      "tags as their labels",
      [
        { kind: "skill", name: "review" },
        { kind: "text", text: " " },
        { kind: "file", projectId: "p1", path: "internal/store/pr/poller.go" },
        { kind: "text", text: " and " },
        { kind: "pr", slug: "a/b", number: 63 },
        { kind: "text", text: " like " },
        { kind: "thread", id: "s-1", name: "Port renderer" },
      ],
      "/review poller.go and #63 like Port renderer",
    ],
    ["a directory keeps its slash", [{ kind: "file", projectId: "p1", path: "internal/store/" }], "store/"],
    [
      "a citation as its label",
      [
        { kind: "cite", cite: { threadId: "s-1", itemId: "i1", text: "quoted", comment: "why?", start: 0, end: 6, prefix: "", suffix: "" } },
        { kind: "text", text: " explain" },
      ],
      "Assistant quote explain",
    ],
    [
      "attachments left out",
      [
        { kind: "text", text: "See " },
        { kind: "image", name: "shot.png", path: "/a/shot.png" },
        { kind: "pdf", name: "spec.pdf", path: "/a/spec.pdf" },
        { kind: "text", text: " here" },
      ],
      "See here",
    ],
    ["attachments only", [{ kind: "image", name: "shot.png", path: "/a/shot.png" }], ""],
  ])("%s", (_name, pieces, want) => {
    expect(promptPreview(pieces)).toBe(want);
  });
});

describe("tickLabel", () => {
  const long = "a".repeat(59) + " bcdefgh";
  it.each<[string, number, number, string, string]>([
    ["short", 1, 2, "Fix it", "Prompt 1 of 2: Fix it"],
    ["no text", 2, 2, "", "Prompt 2 of 2"],
    ["exactly 60", 3, 9, "b".repeat(60), `Prompt 3 of 9: ${"b".repeat(60)}`],
    ["cut at 60, trailing space trimmed", 4, 9, long, `Prompt 4 of 9: ${"a".repeat(59)}…`],
  ])("%s", (_name, n, total, preview, want) => {
    expect(tickLabel(n, total, preview)).toBe(want);
  });
});
