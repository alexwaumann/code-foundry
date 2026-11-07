import { describe, expect, it, vi } from "vitest";
import type { BrowserInputView, BrowserMouseView } from "@/api/browser";
import { buttonName, ClickCounter, heldButton, InputQueue, isCopyChord, isPasteChord, keyDown, keyForPage, keyUp, modifiersOf, toPage, wheelPixels } from "./browserInput";

const key = (over: Partial<Parameters<typeof keyDown>[0]> = {}) => ({ key: "a", code: "KeyA", keyCode: 65, location: 0, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

const move = (x: number): BrowserMouseView => ({ kind: "mouse", type: "mouseMoved", button: "none", x, y: 0, buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 0 });
const wheel = (deltaY: number): BrowserMouseView => ({ ...move(1), type: "mouseWheel", deltaY });
const press: BrowserMouseView = { ...move(1), type: "mousePressed", button: "left", buttons: 1, clickCount: 1 };

describe("modifiersOf", () => {
  it("uses the protocol's bits", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(1);
    expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(14);
  });
});

describe("buttonName", () => {
  it.each([
    [0, "left"],
    [1, "middle"],
    [2, "right"],
    [3, "back"],
    [4, "forward"],
    [9, "none"],
  ])("%i is %s", (n, name) => {
    expect(buttonName(n)).toBe(name);
  });
});

describe("heldButton", () => {
  it.each([
    [0, "none"],
    [1, "left"],
    [2, "right"],
    [4, "middle"],
    [3, "left"],
  ])("%i is %s", (n, name) => {
    expect(heldButton(n)).toBe(name);
  });
});

describe("toPage", () => {
  const box = { left: 100, top: 50, width: 400, height: 300 };
  it("is the offset in the view when the page has its size", () => {
    expect(toPage(150, 60, box, { width: 400, height: 300 })).toEqual({ x: 50, y: 10 });
  });
  it("scales while the page still has the size before a resize", () => {
    expect(toPage(300, 200, box, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
  });
  it("is the plain offset before the first frame", () => {
    expect(toPage(150, 60, box, { width: 0, height: 0 })).toEqual({ x: 50, y: 10 });
  });
});

describe("wheelPixels", () => {
  it("reads pixels, lines and pages", () => {
    expect(wheelPixels({ deltaX: 2, deltaY: 3, deltaMode: 0 }, 500)).toEqual({ deltaX: 2, deltaY: 3 });
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toEqual({ deltaX: 0, deltaY: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 500)).toEqual({ deltaX: 0, deltaY: 500 });
  });
});

describe("ClickCounter", () => {
  it("counts quick presses in one place", () => {
    const c = new ClickCounter();
    expect(c.press(0, 10, 10, 0)).toBe(1);
    expect(c.press(100, 11, 10, 0)).toBe(2);
    expect(c.press(200, 11, 10, 0)).toBe(3);
  });
  it("starts over after a pause, a move or another button", () => {
    const c = new ClickCounter();
    c.press(0, 10, 10, 0);
    expect(c.press(1000, 10, 10, 0)).toBe(1);
    expect(c.press(1100, 50, 10, 0)).toBe(1);
    expect(c.press(1200, 50, 10, 2)).toBe(1);
  });
});

describe("keys", () => {
  it("types printable keys and Enter, and sends the rest raw", () => {
    expect(keyDown(key())).toMatchObject({ type: "keyDown", text: "a" });
    expect(keyDown(key({ key: "Enter", code: "Enter" }))).toMatchObject({ type: "keyDown", text: "\r" });
    expect(keyDown(key({ key: "ArrowLeft", code: "ArrowLeft" }))).toMatchObject({ type: "rawKeyDown", text: "" });
    expect(keyDown(key({ metaKey: true }))).toMatchObject({ type: "rawKeyDown", text: "", modifiers: 4 });
    expect(keyDown(key({ ctrlKey: true }))).toMatchObject({ type: "rawKeyDown", text: "" });
  });
  it("types a character that is two code units as one", () => {
    expect(keyDown(key({ key: "😀" }))).toMatchObject({ type: "keyDown", text: "😀" });
  });
  it("releases without text", () => {
    expect(keyUp(key())).toMatchObject({ type: "keyUp", text: "" });
  });
  it("gives the page its editing chords and the app the rest", () => {
    expect(keyForPage({ metaKey: false, code: "KeyK" })).toBe(true);
    expect(keyForPage({ metaKey: true, code: "KeyA" })).toBe(true);
    expect(keyForPage({ metaKey: true, code: "KeyZ" })).toBe(true);
    expect(keyForPage({ metaKey: true, code: "ArrowLeft" })).toBe(true);
    expect(keyForPage({ metaKey: true, code: "KeyK" })).toBe(false);
    expect(keyForPage({ metaKey: true, code: "KeyJ" })).toBe(false);
    expect(keyForPage({ metaKey: true, code: "KeyV" })).toBe(false);
  });
  it("names the clipboard's chords", () => {
    expect(isPasteChord({ metaKey: true, code: "KeyV" })).toBe(true);
    expect(isPasteChord({ metaKey: false, code: "KeyV" })).toBe(false);
    expect(isCopyChord({ metaKey: true, code: "KeyC" })).toBe(true);
    expect(isCopyChord({ metaKey: true, code: "KeyX" })).toBe(true);
    expect(isCopyChord({ metaKey: true, code: "KeyA" })).toBe(false);
  });
});

describe("InputQueue", () => {
  function setup() {
    const batches: (readonly BrowserInputView[])[] = [];
    const release: (() => void)[] = [];
    const q = new InputQueue((events) => {
      batches.push(events);
      return new Promise<void>((r) => release.push(r));
    });
    const next = async () => {
      release.shift()?.();
      await vi.waitFor(() => undefined);
      await Promise.resolve();
    };
    return { q, batches, next };
  }

  it("keeps one call in flight, in order", async () => {
    const { q, batches, next } = setup();
    q.push(press);
    q.push(move(1));
    q.push(move(2));
    expect(batches).toHaveLength(1);
    await next();
    await vi.waitFor(() => {
      expect(batches).toHaveLength(2);
    });
    expect(batches[0]).toEqual([press]);
    expect(batches[1]).toEqual([move(2)]);
  });

  it("merges moves and adds wheels, and never across anything else", async () => {
    const { q, batches, next } = setup();
    q.push(press);
    q.push(wheel(10));
    q.push(wheel(5));
    q.push(move(1));
    q.push(press);
    q.push(move(2));
    await next();
    await vi.waitFor(() => {
      expect(batches).toHaveLength(2);
    });
    expect(batches[1]).toEqual([wheel(15), move(1), press, move(2)]);
  });

  it("drops a batch that failed and goes on", async () => {
    const sent: (readonly BrowserInputView[])[] = [];
    const q = new InputQueue((events) => {
      sent.push(events);
      return sent.length === 1 ? Promise.reject(new Error("gone")) : Promise.resolve();
    });
    q.push(press);
    q.push(move(1));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    await q.drained();
  });
});
