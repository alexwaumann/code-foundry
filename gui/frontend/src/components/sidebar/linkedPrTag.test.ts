import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import { findLinkedPr, fresher, linkedPrCardRows, linkedPrState, linkedPrTag, linkedPrTagText, type LinkedPrFact, type LinkedPrState } from "./linkedPrTag";

const fact = (number: number, state: LinkedPrState, title = ""): LinkedPrFact => ({ number, state, title });
const pr = (o: Partial<PullRequestView>) => ({ repoSlug: "o/r", number: 1, state: "open", draft: false, title: "", updatedAtMs: null, partial: false, ...o }) as PullRequestView;

describe("linkedPrTag", () => {
  it.each<[string, LinkedPrFact[], ReturnType<typeof linkedPrTag>, string]>([
    ["none: no tag", [], null, ""],
    ["all closed: no tag", [fact(1, "closed"), fact(2, "closed")], null, ""],
    ["one open: its number, success", [fact(142, "open")], { kind: "one", number: 142, state: "open", tone: "success" }, "142"],
    ["one draft: draft tone", [fact(145, "draft")], { kind: "one", number: 145, state: "draft", tone: "draft" }, "145"],
    ["one merged: merged tone", [fact(138, "merged")], { kind: "one", number: 138, state: "merged", tone: "merged" }, "138"],
    ["one unknown: neutral", [fact(9, "unknown")], { kind: "one", number: 9, state: "unknown", tone: "neutral" }, "9"],
    ["closed left out: the one left shows as itself", [fact(131, "closed"), fact(138, "merged")], { kind: "one", number: 138, state: "merged", tone: "merged" }, "138"],
    ["any draft: the first draft, +N", [fact(1, "open"), fact(2, "draft"), fact(3, "merged"), fact(4, "draft")], { kind: "many", number: 2, state: "draft", more: 3, tone: "draft" }, "2 +3"],
    ["no draft, any open: the first open, success", [fact(1, "merged"), fact(2, "open"), fact(3, "unknown")], { kind: "many", number: 2, state: "open", more: 2, tone: "success" }, "2 +2"],
    ["all merged: the first, merged", [fact(1, "merged"), fact(2, "merged")], { kind: "many", number: 1, state: "merged", more: 1, tone: "merged" }, "1 +1"],
    ["closed not counted", [fact(1, "merged"), fact(2, "closed"), fact(3, "merged")], { kind: "many", number: 1, state: "merged", more: 1, tone: "merged" }, "1 +1"],
    ["unknown counts; with merged only the first unknown, neutral", [fact(1, "merged"), fact(2, "unknown")], { kind: "many", number: 2, state: "unknown", more: 1, tone: "neutral" }, "2 +1"],
  ])("%s", (_name, facts, want, text) => {
    const tag = linkedPrTag(facts);
    expect(tag).toEqual(want);
    expect(tag === null ? "" : linkedPrTagText(tag)).toBe(text);
  });
});

describe("linkedPrState", () => {
  it.each<[string, Parameters<typeof linkedPrState>[0], LinkedPrState]>([
    ["not read", null, "unknown"],
    ["open", { state: "open", draft: false }, "open"],
    ["draft", { state: "open", draft: true }, "draft"],
    ["merged", { state: "merged", draft: false }, "merged"],
    ["closed", { state: "closed", draft: false }, "closed"],
    ["GitHub did not say", { state: "unknown", draft: false }, "unknown"],
  ])("%s", (_name, p, want) => {
    expect(linkedPrState(p)).toBe(want);
  });
});

describe("fresher and findLinkedPr", () => {
  it("the newer read wins; a tie or unknown time keeps the first", () => {
    const old = pr({ updatedAtMs: 1, title: "old" });
    const now = pr({ updatedAtMs: 2, title: "now" });
    expect(fresher(old, now)).toBe(now);
    expect(fresher(now, old)).toBe(now);
    expect(fresher(old, pr({ updatedAtMs: 1 }))).toBe(old);
    expect(fresher(old, pr({ updatedAtMs: null }))).toBe(old);
    expect(fresher(null, old)).toBe(old);
    expect(fresher(old, null)).toBe(old);
    expect(fresher(null, null)).toBeNull();
  });

  it("matches slug in any case and number, first list first, skipping partial entries", () => {
    const partial = pr({ repoSlug: "O/R", number: 7, partial: true, title: "partial" });
    const first = pr({ repoSlug: "O/R", number: 7, title: "first" });
    const second = pr({ repoSlug: "o/r", number: 7, title: "second" });
    expect(findLinkedPr([[partial], [first], [second]], "o/r#7")).toBe(first);
    expect(findLinkedPr([[first]], "o/r#8")).toBeNull();
    expect(findLinkedPr([], "o/r#7")).toBeNull();
  });
});

describe("linkedPrCardRows", () => {
  it.each<[string, LinkedPrFact[], number[], number]>([
    ["none", [], [], 0],
    ["all closed: no rows", [fact(1, "closed")], [], 0],
    ["closed left out, the order kept", [fact(147, "open"), fact(131, "closed"), fact(145, "draft"), fact(138, "merged")], [147, 145, 138], 0],
    ["unknown ones count", [fact(9, "unknown")], [9], 0],
    ["capped at five, then how many more", [1, 2, 3, 4, 5, 6, 7].map((n) => fact(n, "open")), [1, 2, 3, 4, 5], 2],
    ["a closed one past the cap is not more", [1, 2, 3, 4, 5].map((n) => fact(n, "open")).concat(fact(6, "closed")), [1, 2, 3, 4, 5], 0],
  ])("%s", (_name, facts, numbers, more) => {
    const got = linkedPrCardRows(facts);
    expect(got.rows.map((r) => r.number)).toEqual(numbers);
    expect(got.more).toBe(more);
  });
});
