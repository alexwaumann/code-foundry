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
