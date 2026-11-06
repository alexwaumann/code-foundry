import { describe, expect, it } from "vitest";
import { MAX_REPEAT_UNITS, XtermRenderer } from "./xterm";

function renderer(): XtermRenderer {
  return new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
}

function write(r: XtermRenderer, s: string): Promise<void> {
  return new Promise((resolve) => {
    r.term.write(s, resolve);
  });
}

/** Runs a key event through the renderer's custom key handler; returns what it sent. */
function press(r: XtermRenderer, init: KeyboardEventInit, type = "keydown"): { handled: boolean; sent: string[]; prevented: boolean } {
  const sent: string[] = [];
  const decoder = new TextDecoder();
  const sub = r.onData((d) => sent.push(decoder.decode(d)));
  const e = new KeyboardEvent(type, { cancelable: true, ...init });
  const handled = (r as unknown as { keyHandler(e: KeyboardEvent): boolean }).keyHandler(e);
  sub.dispose();
  return { handled, sent, prevented: e.defaultPrevented };
}

const shiftEnter = { key: "Enter", code: "Enter", shiftKey: true };

describe("XtermRenderer shift+enter", () => {
  it.each([
    { name: "no protocol", output: "", want: "\n" },
    { name: "kitty flags pushed", output: "\x1b[>5u", want: "\x1b[13;2u" },
    { name: "modifyOtherKeys 2", output: "\x1b[>4;2m", want: "\x1b[27;2;13~" },
  ])("$name", async ({ output, want }) => {
    const r = renderer();
    await write(r, output);
    expect(press(r, shiftEnter)).toEqual({ handled: false, sent: [want], prevented: true });
    // The keypress that follows must not add a "\r".
    expect(press(r, shiftEnter, "keypress")).toEqual({ handled: false, sent: [], prevented: true });
    r.dispose();
  });

  it("leaves enter, ctrl+enter and IME composition to xterm", () => {
    const r = renderer();
    expect(press(r, { key: "Enter", code: "Enter" }).handled).toBe(true);
    expect(press(r, { key: "Enter", code: "Enter", ctrlKey: true }).handled).toBe(true);
    expect(press(r, { ...shiftEnter, isComposing: true }).handled).toBe(true);
    r.dispose();
  });
});

describe("XtermRenderer REP cap", () => {
  const mark = "\u0301";
  // Two cells and two code units, on the Unicode 6 widths of an unmounted renderer too: REP has
  // to look past the spacer cell to see them.
  const wide = "\u{2000B}";
  /** The cursor's row and column once `output` is parsed, on an 80-column grid. */
  async function cursorAfter(output: string): Promise<[number, number]> {
    const r = renderer();
    await write(r, output);
    const buf = r.term.buffer.active;
    const at: [number, number] = [buf.baseY + buf.cursorY, buf.cursorX];
    r.dispose();
    return at;
  }
  /** Where `n` cells of width 1 from the home position leave the cursor. */
  const cells = (n: number): [number, number] => [Math.floor(n / 80), n % 80];

  it.each([
    { name: "an ASCII run", output: "A\x1b[3b", want: cells(4) },
    { name: "no count", output: "A\x1b[b", want: cells(2) },
    { name: "a zero count", output: "A\x1b[0b", want: cells(2) },
    { name: "a wide character", output: "你\x1b[2b", want: cells(6) },
    { name: "a wide surrogate pair", output: `${wide}\x1b[2b`, want: cells(6) },
    { name: "a cluster, repeated whole", output: `e${mark}\x1b[2b`, want: cells(3) },
    { name: "the cap exactly", output: `A\x1b[${String(MAX_REPEAT_UNITS)}b`, want: cells(MAX_REPEAT_UNITS + 1) },
    { name: "the cap in a cluster's code units", output: `e${mark}\x1b[${String(MAX_REPEAT_UNITS / 2)}b`, want: cells(MAX_REPEAT_UNITS / 2 + 1) },
  ])("repeats $name", async ({ output, want }) => {
    expect(await cursorAfter(output)).toEqual(want);
  });

  it.each([
    { name: "one past the cap", output: `A\x1b[${String(MAX_REPEAT_UNITS + 1)}b`, want: cells(1) },
    { name: "one past the cap in code units", output: `${wide}\x1b[${String(MAX_REPEAT_UNITS / 2 + 1)}b`, want: cells(2) },
    { name: "the largest count", output: "A\x1b[2147483647b", want: cells(1) },
    { name: "the largest count on a wide surrogate pair", output: `${wide}\x1b[2147483647b`, want: cells(2) },
    { name: "the largest count on a cluster", output: `e${mark.repeat(3)}\x1b[2147483647b`, want: cells(1) },
    { name: "a sub parameter on the count", output: "A\x1b[2147483647:5b", want: cells(1) },
    { name: "a cell with too many marks for even one", output: `e${mark.repeat(MAX_REPEAT_UNITS)}\x1b[1b`, want: cells(1) },
    { name: "a small count on a long cluster", output: `e${mark.repeat(999)}\x1b[5b`, want: cells(1) },
    { name: "the last column, wrap pending", output: `${"A".repeat(80)}\x1b[2147483647b`, want: [0, 80] as [number, number] },
  ])("swallows $name", async ({ output, want }) => {
    expect(await cursorAfter(output)).toEqual(want);
  });

  it("keeps parsing after a swallowed one, and repeats again", async () => {
    const r = renderer();
    await write(r, "e\u0301\u0301\u0301\x1b[2147483647b\r\nB\x1b[2b");
    expect(r.getText().trim().split("\n").at(-1)).toBe("BBB");
    r.dispose();
  });

  it("repeats on the alternate screen and leaves other final-b sequences to xterm", async () => {
    expect(await cursorAfter("\x1b[?1049hA\x1b[3b")).toEqual(cells(4));
    expect(await cursorAfter("A\x1b[?2147483647b")).toEqual(cells(1));
  });
});

describe("XtermRenderer cursor across reset", () => {
  /** Whether the cursor is hidden once everything queued has been parsed. */
  async function hidden(r: XtermRenderer): Promise<boolean> {
    await write(r, "");
    return (r.term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden;
  }

  const byProgram = (r: XtermRenderer) => {
    r.term.write("\x1b[?25l");
  };
  const byExit = (r: XtermRenderer) => {
    r.hideCursor();
  };

  it.each([
    { name: "a program hid it", hide: byProgram, parsed: true, snapshot: "plain", want: false },
    { name: "an exited terminal's hide already parsed", hide: byExit, parsed: true, snapshot: "plain", want: false },
    { name: "an exited terminal's hide still queued", hide: byExit, parsed: false, snapshot: "plain", want: false },
    { name: "a program's hide still queued", hide: byProgram, parsed: false, snapshot: "plain", want: false },
    { name: "the next snapshot's program hid it", hide: byExit, parsed: false, snapshot: "\x1b[?25lfull screen", want: true },
  ])("$name: hidden is $want", async ({ hide, parsed, snapshot, want }) => {
    const r = renderer();
    hide(r);
    if (parsed) await write(r, "");
    r.reset();
    r.write(new TextEncoder().encode(snapshot));
    expect(await hidden(r)).toBe(want);
    r.dispose();
  });

  it("does not throw behind writes over xterm's 50 MB limit, and shows the cursor on the next reset", async () => {
    const r = renderer();
    r.hideCursor();
    const parsed = new Promise<void>((resolve) => {
      r.write(new Uint8Array(51_000_000), resolve);
    });
    expect(() => {
      r.reset();
    }).not.toThrow();
    await parsed;
    r.reset();
    expect(await hidden(r)).toBe(false);
    r.dispose();
  });

  it("stays hidden for an exited terminal attached again: its exit follows the snapshot", async () => {
    const r = renderer();
    r.reset();
    r.write(new TextEncoder().encode("done"));
    r.hideCursor();
    expect(await hidden(r)).toBe(true);
    r.dispose();
  });
});

describe("XtermRenderer write callback", () => {
  // Past xterm's 50 MB limit while it is pending, and NUL, which is cheap to parse.
  const huge = () => new Uint8Array(50_000_001);
  /** Writes from `parsed`, as AttachController does: xterm refuses, and throws, if it still counts `data`. */
  function writeOnFromParsed(r: XtermRenderer, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      r.write(data, () => {
        try {
          r.write(new TextEncoder().encode("next"), resolve);
        } catch (err) {
          reject(new Error("xterm refused the write", { cause: err }));
        }
      });
    });
  }
  const line = (r: XtermRenderer) => r.term.buffer.active.getLine(0)?.translateToString(true);

  it("may write when xterm parsed the data on its timer", async () => {
    const r = renderer();
    await writeOnFromParsed(r, huge());
    expect(line(r)).toBe("next");
    r.dispose();
  });

  it("may write when xterm parsed the data inside write(), as it does after user input", async () => {
    const r = renderer();
    r.term.input("x");
    await writeOnFromParsed(r, huge());
    expect(line(r)).toBe("next");
    r.dispose();
  });

  it("may write when xterm resumed the data after an async parser handler", async () => {
    const r = renderer();
    r.term.parser.registerOscHandler(7777, () => Promise.resolve(true));
    const osc = new TextEncoder().encode("\x1b]7777;x\x07");
    const data = huge();
    data.set(osc);
    await writeOnFromParsed(r, data);
    expect(line(r)).toBe("next");
    r.dispose();
  });

  it("runs after the data, however many writes share xterm's pass", async () => {
    const r = renderer();
    const seen: (string | undefined)[] = [];
    const done = new Promise<void>((resolve) => {
      r.write(new TextEncoder().encode("a"), () => seen.push(line(r)));
      r.write(new TextEncoder().encode("b"), () => {
        seen.push(line(r));
        resolve();
      });
    });
    await done;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe("ab");
    r.dispose();
  });
});

describe("XtermRenderer keyboard modes", () => {
  it("tracks kitty flags and modifyOtherKeys from the output stream", async () => {
    const r = renderer();
    await write(r, "\x1b[>5u");
    expect(r.keyboardModes.kittyFlags).toBe(5);
    await write(r, "\x1b[<u\x1b[>4;2m");
    expect(r.keyboardModes.kittyFlags).toBe(0);
    expect(r.keyboardModes.modifyOtherKeys).toBe(2);
    await write(r, "\x1bc");
    expect(r.keyboardModes.modifyOtherKeys).toBe(0);
    r.dispose();
  });

  it("follows the alternate screen", async () => {
    const r = renderer();
    await write(r, "\x1b[=1;1u\x1b[?1049h");
    expect(r.keyboardModes.kittyFlags).toBe(0);
    await write(r, "\x1b[?1049l");
    expect(r.keyboardModes.kittyFlags).toBe(1);
    r.dispose();
  });
});

describe("XtermRenderer keyup", () => {
  it("an app chord's keyup and cmd's are not xterm's (they would take the keyboard back); other keyups are", () => {
    const r = new XtermRenderer({ fontSize: 12, isGlobalChord: (c) => c === "cmd+t" });
    expect(press(r, { key: "t", code: "KeyT", metaKey: true }, "keyup").handled).toBe(false);
    expect(press(r, { key: "t", code: "KeyT" }, "keyup").handled).toBe(true);
    expect(press(r, { key: "Meta", code: "MetaLeft" }, "keyup").handled).toBe(false);
    expect(press(r, { key: "k", code: "KeyK", metaKey: true }, "keyup").handled).toBe(true);
    r.dispose();
  });
});

describe("XtermRenderer hideCursor", () => {
  it("does not throw behind writes over xterm's 50 MB limit: the exit must still show", async () => {
    const r = renderer();
    const parsed = new Promise<void>((resolve) => {
      r.write(new Uint8Array(51_000_000), resolve);
    });
    expect(() => {
      r.hideCursor();
    }).not.toThrow();
    await parsed;
    r.dispose();
  });

  const hidden = (r: XtermRenderer) => (r.term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden;

  it("hides the cursor after the output written before it, even one that showed it", async () => {
    const r = renderer();
    expect(hidden(r)).toBe(false);
    r.write(new TextEncoder().encode("done\r\n\x1b[?25h"));
    r.hideCursor();
    await write(r, "");
    expect(hidden(r)).toBe(true);
    r.dispose();
  });
});
