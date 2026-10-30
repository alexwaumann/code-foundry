import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import { findLinkedPr, fresher, linkedPrCardRows, linkedPrState, linkedPrTag, linkedPrTagText, linkedPrTip, type LinkedPrFact, type LinkedPrState } from "./linkedPrTag";

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
    ["any draft: draft", [fact(1, "open"), fact(2, "draft"), fact(3, "merged")], { kind: "many", count: 3, tone: "draft" }, "3 PRs"],
    ["no draft, any open: success", [fact(1, "merged"), fact(2, "open"), fact(3, "unknown")], { kind: "many", count: 3, tone: "success" }, "3 PRs"],
    ["all merged: merged", [fact(1, "merged"), fact(2, "merged")], { kind: "many", count: 2, tone: "merged" }, "2 PRs"],
    ["closed not counted", [fact(1, "merged"), fact(2, "closed"), fact(3, "merged")], { kind: "many", count: 2, tone: "merged" }, "2 PRs"],
    ["unknown counts; with merged only it is neutral", [fact(1, "merged"), fact(2, "unknown")], { kind: "many", count: 2, tone: "neutral" }, "2 PRs"],
  ])("%s", (_name, facts, want, text) => {
    const tag = linkedPrTag(facts);
    expect(tag).toEqual(want);
    expect(tag === null ? "" : linkedPrTagText(tag)).toBe(text);
  });
});

describe("linkedPrTip", () => {
  it.each<[string, LinkedPrFact[], string]>([
    ["one: state and title", [fact(142, "open", "Fix thing")], "Open · Fix thing"],
    ["one without a title: its number", [fact(9, "unknown")], "State unknown · #9"],
    ["one left after closed ones", [fact(1, "closed", "Old"), fact(2, "draft", "New")], "Draft · New"],
    ["several: numbers and states, closed left out", [fact(3, "open"), fact(2, "closed"), fact(1, "merged")], "#3 · Open\n#1 · Merged"],
    [
      "more than five: five, then +N more",
      [1, 2, 3, 4, 5, 6, 7].map((n) => fact(n, "merged")),
      "#1 · Merged\n#2 · Merged\n#3 · Merged\n#4 · Merged\n#5 · Merged\n+2 more",
    ],
    ["all closed: nothing", [fact(1, "closed")], ""],
  ])("%s", (_name, facts, want) => {
    expect(linkedPrTip(facts)).toBe(want);
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
