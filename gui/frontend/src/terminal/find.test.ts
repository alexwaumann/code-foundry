import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FindResults } from "./renderer";
import { terminalCountLabel } from "./results";
import { FIND_LIMIT } from "./find";
import { XtermRenderer } from "./xterm";

// xterm's open() watches the display's pixel ratio.
window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;

/** The real xterm and addon: what they count, not what they paint (e2e/terminal-find.spec.ts). */
function setup() {
  const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
  // Selecting needs xterm opened; its renderer is not what these tests are about.
  const el = document.createElement("div");
  document.body.append(el);
  r.term.open(el);
  const seen: FindResults[] = [];
  r.onFindResults((x) => seen.push(x));
  const last = () => seen.at(-1);
  const write = (s: string) =>
    new Promise<void>((resolve) => {
      r.term.write(s, resolve);
    });
  return { r, seen, last, write };
}

const LINES = "resize one\r\nnothing\r\nRESIZE two\r\nresize three\r\n";

describe("terminalCountLabel", () => {
  it.each([
    { name: "a current match", results: { index: 3, total: 9, capped: false }, want: "4 of 9" },
    { name: "none current", results: { index: -1, total: 0, capped: false }, want: "0 of 0" },
    { name: "at the limit", results: { index: 3, total: 5000, capped: true }, want: "4 of 5000+" },
    { name: "current past the limit", results: { index: -1, total: 5000, capped: true }, want: "5000+" },
  ])("$name", ({ results, want }) => {
    expect(terminalCountLabel(results)).toBe(want);
  });
});

describe("the renderer's find", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });
  afterEach(() => {
    vi.useRealTimers();
    t.r.dispose();
  });

  it("starts on the last match: what is newest in a terminal is at the end", async () => {
    await t.write(LINES);
    t.r.find("resize");
    expect(t.last()).toEqual({ index: 2, total: 3, capped: false });
  });

  it("is case-sensitive only once the query has a capital", async () => {
    await t.write(LINES);
    t.r.find("RESIZE");
    expect(t.last()).toMatchObject({ total: 1 });
    t.r.find("Resize");
    expect(t.last()).toMatchObject({ index: -1, total: 0 });
  });

  it("steps both ways and wraps", async () => {
    await t.write(LINES);
    t.r.find("resize");
    t.r.findStep(1);
    expect(t.last()?.index).toBe(0);
    t.r.findStep(1);
    expect(t.last()?.index).toBe(1);
    t.r.findStep(-1);
    t.r.findStep(-1);
    expect(t.last()?.index).toBe(2);
  });

  it("keeps the query's current match while the query grows", async () => {
    await t.write(LINES);
    t.r.find("resize");
    t.r.findStep(1); // the first line's
    t.r.find("resize o");
    expect(t.last()).toEqual({ index: 0, total: 1, capped: false });
  });

  it("clears what it matched and its selection; stepping does nothing then", async () => {
    await t.write(LINES);
    t.r.find("resize");
    expect(t.r.term.hasSelection()).toBe(true);
    t.r.clearFind();
    expect(t.last()).toEqual({ index: -1, total: 0, capped: false });
    expect(t.r.term.hasSelection()).toBe(false);
    const n = t.seen.length;
    t.r.findStep(1);
    expect(t.seen).toHaveLength(n);
  });

  it("colours the selection as the current match only while there is a query", async () => {
    await t.write(LINES);
    const before = t.r.term.options.theme?.selectionInactiveBackground;
    t.r.find("resize");
    const during = t.r.term.options.theme?.selectionInactiveBackground;
    expect(during).toMatch(/^#[0-9a-f]{6}$/);
    expect(during).not.toBe(before);
    t.r.clearFind();
    expect(t.r.term.options.theme?.selectionInactiveBackground).toBe(before);
  });

  it("counts new output, once the terminal goes quiet", async () => {
    await t.write(LINES);
    t.r.find("resize");
    vi.useFakeTimers();
    t.r.term.write("resize four\r\n");
    await vi.waitFor(() => {
      vi.advanceTimersByTime(250);
      expect(t.last()?.total).toBe(4);
    });
    // The match that was current stays so, whatever came after it.
    expect(t.last()?.index).toBe(2);
  });

  it("counts new output within a second of a terminal that never goes quiet", async () => {
    await t.write(LINES);
    t.r.find("resize");
    vi.useFakeTimers();
    // Every 100 ms, so the addon's own 200 ms of quiet never comes.
    for (let i = 0; i < 12; i++) {
      t.r.term.write("resize again\r\n");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(t.last()?.total).toBeGreaterThan(3);
  });

  it("forgets a reset buffer's matches at once, and counts the snapshot that follows", async () => {
    await t.write(LINES);
    t.r.find("resize");
    t.r.reset();
    expect(t.last()).toEqual({ index: -1, total: 0, capped: false });
    expect(t.r.term.hasSelection()).toBe(false);
    vi.useFakeTimers();
    t.r.term.write("resize only\r\n");
    await vi.waitFor(() => {
      vi.advanceTimersByTime(250);
      expect(t.last()).toEqual({ index: 0, total: 1, capped: false });
    });
  });

  it("the next terminal's query replaces the last one's across a reset", async () => {
    await t.write(LINES);
    t.r.find("resize");
    t.r.reset();
    t.r.find("nothing");
    vi.useFakeTimers();
    t.r.term.write("nothing here, no resize\r\n");
    await vi.waitFor(() => {
      vi.advanceTimersByTime(250);
      expect(t.last()?.total).toBe(1);
    });
  });

  it("searches only the screen in the alternate screen, and the scrollback again after it", async () => {
    await t.write(LINES);
    t.r.find("resize");
    vi.useFakeTimers();
    t.r.term.write("\x1b[?1049h\x1b[Hresize alt");
    await vi.waitFor(() => {
      vi.advanceTimersByTime(250);
      expect(t.last()?.total).toBe(1);
    });
    t.r.term.write("\x1b[?1049l");
    await vi.waitFor(() => {
      vi.advanceTimersByTime(250);
      expect(t.last()?.total).toBe(3);
    });
  });

  it("marks the count at the limit", async () => {
    await t.write("x ".repeat(FIND_LIMIT + 10));
    t.r.find("x");
    expect(t.last()).toMatchObject({ total: FIND_LIMIT, capped: true });
  });
});
