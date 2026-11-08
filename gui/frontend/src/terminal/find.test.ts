import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalFind } from "./find";
import type { FindResults } from "./renderer";
import { terminalCountLabel } from "./results";
import { XtermRenderer } from "./xterm";

// xterm's open() watches the display's pixel ratio.
window.matchMedia = (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;

/** The real xterm and addon: what they count, not what they paint (e2e/terminal-find.spec.ts). */
function setup(findLimit?: number) {
  const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false, findLimit });
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
    t.r.dispose();
    t = setup(50);
    await t.write("x ".repeat(60));
    t.r.find("x");
    expect(t.last()).toMatchObject({ total: 50, capped: true });
    t.r.find("xx");
    expect(t.last()).toMatchObject({ total: 0, capped: false });
  });
});

/** TerminalFind on a real xterm and addon, with xterm's backlog scripted: `behind` is what the renderer reports. */
function bare() {
  const term = new Terminal({ allowProposedApi: true, scrollback: 1000 });
  const el = document.createElement("div");
  document.body.append(el);
  term.open(el);
  const state = { behind: false };
  const find = new TerminalFind(term, () => undefined, { busy: () => state.behind });
  const seen: FindResults[] = [];
  find.onResults((x) => seen.push(x));
  const write = (s: string) =>
    new Promise<void>((resolve) => {
      term.write(s, resolve);
    });
  /** After onWriteParsed, which xterm fires once the write's callback has returned. xterm parses on a timer. */
  const parsed = async (s: string) => {
    const done = write(s);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await done;
    await Promise.resolve();
  };
  return { term, find, state, seen, last: () => seen.at(-1), write, parsed, dispose: () => { find.dispose(); term.dispose(); } };
}

describe("the find under a flood", () => {
  let t: ReturnType<typeof bare>;
  beforeEach(() => {
    t = bare();
  });
  afterEach(() => {
    vi.useRealTimers();
    t.dispose();
  });

  it("drops its highlights while xterm is behind and keeps the count; they come back once output pauses", async () => {
    await t.write(LINES);
    t.find.search("resize");
    expect(t.term.markers.length).toBeGreaterThan(0);
    vi.useFakeTimers();
    t.state.behind = true;
    const n = t.seen.length;
    await t.parsed("resize four\r\n");
    // No markers: every line a full scrollback drops would go past each of them.
    expect(t.term.markers).toHaveLength(0);
    expect(t.seen).toHaveLength(n);
    expect(t.last()).toEqual({ index: 2, total: 3, capped: false });
    t.state.behind = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(t.last()).toEqual({ index: 2, total: 4, capped: false });
    expect(t.term.markers.length).toBeGreaterThan(0);
  });

  it("counts a flood that never pauses within a second, without keeping a highlight", async () => {
    await t.write(LINES);
    t.find.search("resize");
    vi.useFakeTimers();
    t.state.behind = true;
    for (let i = 0; i < 12; i++) {
      await t.parsed("resize again\r\n");
      expect(t.term.markers).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(t.last()?.total).toBeGreaterThan(3);
  });

  it("searches before a step taken while dropped, so the step counts what is there", async () => {
    await t.write(LINES);
    t.find.search("resize");
    t.state.behind = true;
    await t.parsed("resize four\r\n");
    t.find.step(-1);
    expect(t.last()).toEqual({ index: 1, total: 4, capped: false });
  });

  describe("a replay of the same terminal", () => {
    it("keeps the count and the current match until the replay is parsed, then counts it from there", async () => {
      await t.write(LINES);
      t.find.search("resize");
      t.find.step(1); // the first line's
      expect(t.last()).toEqual({ index: 0, total: 3, capped: false });
      const n = t.seen.length;
      t.find.reset(true);
      t.term.reset();
      t.state.behind = true;
      await t.parsed(LINES.slice(0, 22));
      expect(t.seen).toHaveLength(n);
      // The rest of it, and output from after the reset below it.
      t.state.behind = false;
      await t.parsed(`${LINES.slice(22)}resize four\r\n`);
      expect(t.last()).toEqual({ index: 0, total: 4, capped: false });
      expect(t.term.getSelectionPosition()?.start.y).toBe(0);
    });

    it("puts the viewport back where the user had scrolled to the match", async () => {
      await t.write(`${"filler\r\n".repeat(60)}resize here\r\n${"filler\r\n".repeat(60)}`);
      t.find.search("resize");
      t.term.scrollToLine(50);
      const row = 60 - t.term.buffer.active.viewportY;
      t.find.reset(true);
      t.term.reset();
      await t.parsed(`${"filler\r\n".repeat(60)}resize here\r\n${"filler\r\n".repeat(60)}`);
      expect(t.term.getSelectionPosition()?.start.y).toBe(60);
      expect(60 - t.term.buffer.active.viewportY).toBe(row);
    });

    it("starts from the newest match when the replay no longer has the current one", async () => {
      await t.write(LINES);
      t.find.search("resize");
      t.find.step(1);
      t.find.reset(true);
      t.term.reset();
      await t.parsed("resize five\r\nresize six\r\n");
      expect(t.last()).toEqual({ index: 1, total: 2, capped: false });
    });

    it("counts another terminal's from nothing", async () => {
      await t.write(LINES);
      t.find.search("resize");
      t.find.reset();
      expect(t.last()).toEqual({ index: -1, total: 0, capped: false });
    });
  });
});

describe("the renderer's reset right after a key", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // xterm parses the first write after user input at once, so reset()'s own write is parsed
  // inside it, before the snapshot is written.
  it("waits for the snapshot before it counts: the reset screen is not the replay", async () => {
    const { r, seen, write } = setup();
    await write(LINES);
    r.find("resize");
    r.term.input("x");
    const n = seen.length;
    r.reset(true);
    expect(seen).toHaveLength(n);
    await new Promise<void>((resolve) => {
      r.write(new TextEncoder().encode(LINES), resolve);
    });
    expect(seen.slice(n)).toEqual([{ index: 2, total: 3, capped: false }]);
    r.dispose();
  });
});
