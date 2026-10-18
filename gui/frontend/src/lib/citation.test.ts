import { describe, expect, it } from "vitest";
import {
  citableItem,
  citeLabel,
  citeLink,
  citeToken,
  locateQuote,
  newCitationId,
  parseCiteLink,
  placeCite,
  quoteAt,
  splitCiteLinks,
  type Box,
  type CitationBody,
} from "./citation";

const body = (over: Partial<CitationBody> = {}): CitationBody => ({
  threadId: "s-0123456789ab",
  itemId: "s-0123456789ab-i42",
  text: "fingerprints each PR by its check counts",
  comment: "",
  start: 12,
  end: 52,
  prefix: "The lag comes ",
  suffix: " and only refetches",
  ...over,
});

describe("tokens", () => {
  it("draft token and ids", () => {
    expect(citeToken("c0a1b2c3d4e5f")).toBe("[Assistant quote](cf-cite://c0a1b2c3d4e5f)");
    expect(newCitationId()).toMatch(/^c[0-9a-f]{12}$/);
    expect(newCitationId()).not.toBe(newCitationId());
  });
});

describe("citeLabel", () => {
  it.each([
    ["four short words, nothing cut", "the branch is pushed", "the branch is pushed"],
    ["more words: the first four and an ellipsis", "fingerprints each PR by its check counts", "fingerprints each PR by…"],
    ["four words over 24 characters: cut at 24", "internationalization considerations notwithstanding everything", "internationalization con…"],
    ["cut on a space: no trailing space before the ellipsis", "abcdefghijklmnopqrstuvw xyz more", "abcdefghijklmnopqrstuvw…"],
    ["whitespace and newlines collapse", "  Fold\n the   head\tsha  ", "Fold the head sha"],
    ["inline code is plain text already", "go test ./internal/store/pr/ passes", "go test ./internal/store…"],
    ["exactly 24 characters", "abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
    ["unicode counts code points", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…"],
    ["empty", "   ", "Quote"],
  ])("%s", (_name, quote, want) => {
    expect(citeLabel(quote)).toBe(want);
  });
});

describe("citeLink / parseCiteLink / splitCiteLinks", () => {
  it("projects the documented format, comment left out when empty", () => {
    expect(citeLink(body())).toBe(
      "[Assistant quote](cf-cite://v1/s-0123456789ab/s-0123456789ab-i42?text=fingerprints%20each%20PR%20by%20its%20check%20counts&start=12&end=52&prefix=The%20lag%20comes%20&suffix=%20and%20only%20refetches)",
    );
    expect(citeLink(body({ comment: "Is 30 s configurable?" }))).toMatch(/&comment=Is%2030%20s%20configurable%3F\)$/);
  });

  it.each([
    ["plain", body()],
    ["a comment", body({ comment: "Do this first.\nIn its own PR." })],
    ["characters that end links and URLs", body({ text: "f(x) = [a](b) & c=d? 100% #1 'q' *s* !", comment: ") ]( & = ?", prefix: "(", suffix: ")" })],
    ["newlines and unicode", body({ text: "line one\n\nline two — ünï 😀", prefix: "", suffix: "" })],
    ["ids with odd characters", body({ threadId: "s-a/b", itemId: "msg_01:0 (x)" })],
    ["zero offsets", body({ start: 0, end: 3, text: "abc" })],
  ])("round trip: %s", (_name, c) => {
    const link = citeLink(c);
    // The URL has no whitespace and no parentheses of its own: nothing ends it early.
    expect(link.slice(link.indexOf("](") + 2, -1)).not.toMatch(/[\s()]/);
    expect(parseCiteLink(link)).toEqual(c);
    expect(splitCiteLinks(`see ${link}, ok`)).toEqual([{ kind: "text", text: "see " }, { kind: "cite", cite: c }, { kind: "text", text: ", ok" }]);
  });

  it("finds several links and keeps text around them", () => {
    const a = body();
    const b = body({ itemId: "i2", text: "Fold the head sha" });
    expect(splitCiteLinks(`${citeLink(a)} ${citeLink(b)}\nthanks`)).toEqual([
      { kind: "cite", cite: a },
      { kind: "text", text: " " },
      { kind: "cite", cite: b },
      { kind: "text", text: "\nthanks" },
    ]);
  });

  it.each([
    ["no text", "[Assistant quote](cf-cite://v1/s-1/i1?start=0&end=3)"],
    ["blank text", "[Assistant quote](cf-cite://v1/s-1/i1?text=%20&start=0&end=3)"],
    ["bad offset", "[Assistant quote](cf-cite://v1/s-1/i1?text=a&start=-1&end=3)"],
    ["end before start", "[Assistant quote](cf-cite://v1/s-1/i1?text=a&start=5&end=3)"],
    ["bad escape", "[Assistant quote](cf-cite://v1/s-1/i1?text=%E0%A4&start=0&end=3)"],
    ["no version", "[Assistant quote](cf-cite://s-1/i1?text=a&start=0&end=3)"],
    ["a draft token", "[Assistant quote](cf-cite://c0123456789ab)"],
    ["no item", "[Assistant quote](cf-cite://v1/s-1?text=a&start=0&end=3)"],
  ])("stays text: %s", (_name, link) => {
    expect(parseCiteLink(link)).toBeNull();
    expect(splitCiteLinks(link)).toEqual([{ kind: "text", text: link }]);
  });

  it("any label parses (Claude or a hand edit may change it)", () => {
    expect(parseCiteLink("[quote](cf-cite://v1/s-1/i1?text=a&start=0&end=1)")).toMatchObject({ text: "a" });
  });
});

describe("quoteAt", () => {
  const plain = "The lag comes from the poller, not the panel.\nTwo ways to close the gap:";
  it("trims the selection and takes up to 32 characters around it", () => {
    const s = plain.indexOf("from");
    expect(quoteAt(plain, s - 1, s + 15)).toEqual({ text: "from the poller", start: s, end: s + 15, prefix: "The lag comes ", suffix: ", not the panel.\nTwo ways to clo" });
  });
  it("reversed offsets and offsets past the end are clamped", () => {
    expect(quoteAt(plain, plain.length + 5, plain.length - 4)).toMatchObject({ text: "gap:", end: plain.length, suffix: "" });
  });
  it("whitespace only is no quote", () => {
    expect(quoteAt(plain, 45, 46)).toBeNull();
  });
});

describe("locateQuote", () => {
  const plain = "Check the counts. The fingerprint changes when the counts move, and the counts are cached.";
  const at = (needle: string, from = 0) => plain.indexOf(needle, from);
  const cite = (needle: string, from = 0) => quoteAt(plain, at(needle, from), at(needle, from) + needle.length) ?? body();
  it.each([
    ["offsets still right", plain, cite("the counts move"), { start: at("the counts move"), end: at("the counts move") + 15 }],
    ["text inserted before: found by its words", `Intro line.\n${plain}`, cite("the counts move"), { start: at("the counts move") + 12, end: at("the counts move") + 27 }],
    [
      "several occurrences: the one whose surroundings agree",
      `Intro line.\n${plain}`,
      cite("the counts", at("the counts", 20)),
      { start: at("the counts", 20) + 12, end: at("the counts", 20) + 22 },
    ],
    ["the right text at the offsets but other surroundings: searched", plain.replace("Check the counts.", "Check xxx counts."), cite("the counts move"), { start: at("the counts move"), end: at("the counts move") + 15 }],
    [
      "whitespace differs (a line break added)",
      plain.replace("counts move", "counts\nmove"),
      cite("the counts move"),
      { start: at("the counts move"), end: at("the counts move") + 15 },
    ],
    ["gone", "Something else entirely.", cite("the counts move"), null],
  ])("%s", (_name, text, c, want) => {
    expect(locateQuote(text, c)).toEqual(want);
  });

  it("equal surroundings: the occurrence nearest the old offsets", () => {
    const text = "x a x a x a";
    expect(locateQuote(text, { text: "a", start: 9, end: 10, prefix: "", suffix: "" })).toEqual({ start: 10, end: 11 });
  });
});

describe("citableItem", () => {
  it.each([
    ["both ends in one answer", "i1", "i1", "some text", "i1"],
    ["ends in two answers", "i1", "i2", "some text", null],
    ["leaves the answer (into a tool row, a bubble, the header)", "i1", null, "some text", null],
    ["starts outside every answer", null, "i1", "some text", null],
    ["outside every answer", null, null, "some text", null],
    ["only whitespace selected", "i1", "i1", " \n ", null],
    ["nothing selected", "i1", "i1", "", null],
  ])("%s", (_name, a, f, sel, want) => {
    expect(citableItem(a, f, sel)).toBe(want);
  });
});

describe("placeCite", () => {
  const pane: Box = { top: 44, bottom: 800, left: 300, right: 1100 };
  const line = (top: number, left = 500, right = 700): Box => ({ top, bottom: top + 20, left, right });
  const base = { width: 80, height: 28, pane, floor: 680 };
  it.each([
    ["6px under the last line, centred on x", { first: line(100), last: line(120), x: 640 }, { left: 600, top: 146, side: "below", visible: true }],
    ["clamped 12px inside the left edge", { first: line(100), last: line(120), x: 310 }, { left: 312, top: 146 }],
    ["clamped 12px inside the right edge", { first: line(100), last: line(120), x: 1095 }, { left: 1008 }],
    ["no room above the composer: above the first line", { first: line(600), last: line(630), x: 640 }, { top: 566, side: "above", visible: true }],
    ["no room either way: stays below", { first: line(50), last: line(640), x: 640, height: 600 }, { side: "below" }],
    ["the line scrolled under the composer: hidden", { first: line(700), last: line(720), x: 640, side: "below" as const }, { visible: false }],
    ["the line scrolled above the pane: hidden", { first: line(-10), last: line(0), x: 640 }, { visible: false }],
    ["a kept side wins", { first: line(600), last: line(630), x: 640, side: "below" as const }, { side: "below", top: 656 }],
  ])("%s", (_name, input, want) => {
    expect(placeCite({ ...base, ...input })).toMatchObject(want);
  });

  it("room: down to the pane's bottom below, up to its top above", () => {
    expect(placeCite({ ...base, first: line(100), last: line(120), x: 640 }).room).toBe(800 - 12 - 146);
    expect(placeCite({ ...base, first: line(600), last: line(630), x: 640 }).room).toBe(600 - 6 - 44 - 12);
  });
});
