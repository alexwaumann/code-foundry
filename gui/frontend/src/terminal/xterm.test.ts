import { describe, expect, it } from "vitest";
import { XtermRenderer } from "./xterm";

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
          reject(err);
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
