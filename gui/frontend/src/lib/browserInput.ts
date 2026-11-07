/**
 * Turning the window's pointer and key events into the page's (docs/notes/chrome-surface.md).
 * Pure: the component feeds it events and the queue a send function.
 */
import type { BrowserInputView, BrowserKeyView, BrowserMouseView } from "@/api/browser";

/** The DevTools protocol's modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

interface Modifiers {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function modifiersOf(e: Modifiers): number {
  return (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0);
}

const BUTTONS: readonly BrowserMouseView["button"][] = ["left", "middle", "right", "back", "forward"];

/** A DOM MouseEvent.button as the protocol names it. */
export function buttonName(button: number): BrowserMouseView["button"] {
  return BUTTONS[button] ?? "none";
}

/** The button held during a move: a drag selects text only when the move names it. */
export function heldButton(buttons: number): BrowserMouseView["button"] {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  return buttons & 4 ? "middle" : "none";
}

/** A point in the view as CSS pixels of the page, which may still be the size before a resize. */
export function toPage(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }) {
  const sx = box.width > 0 && page.width > 0 ? page.width / box.width : 1;
  const sy = box.height > 0 && page.height > 0 ? page.height / box.height : 1;
  return { x: (clientX - box.left) * sx, y: (clientY - box.top) * sy };
}

const WHEEL_LINE = 16;

/** A wheel event's deltas in pixels, whatever unit it came in. */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number): { deltaX: number; deltaY: number } {
  const unit = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? pageHeight : 1;
  return { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit };
}

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 4;

/** Counts a press as the first, second or third of a click, as `MouseEvent.detail` would. */
export class ClickCounter {
  private last = { at: -Infinity, x: 0, y: 0, button: -1, count: 0 };

  press(at: number, x: number, y: number, button: number): number {
    const p = this.last;
    const again = button === p.button && at - p.at < DOUBLE_CLICK_MS && Math.abs(x - p.x) <= DOUBLE_CLICK_PX && Math.abs(y - p.y) <= DOUBLE_CLICK_PX;
    this.last = { at, x, y, button, count: again ? p.count + 1 : 1 };
    return this.last.count;
  }
}

/** Cmd chords that belong to the page. Any other reaches the app's own keymap and never the page. */
const PAGE_CMD_KEYS = new Set(["KeyA", "KeyC", "KeyX", "KeyZ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace"]);

/** cmd+v: the window's own paste event carries the text, so the key itself goes nowhere. */
export function isPasteChord(e: Pick<KeyboardEvent, "metaKey" | "code">): boolean {
  return e.metaKey && e.code === "KeyV";
}

/** cmd+c and cmd+x: after the page has them, its clipboard moves to the Mac's. */
export function isCopyChord(e: Pick<KeyboardEvent, "metaKey" | "code">): boolean {
  return e.metaKey && (e.code === "KeyC" || e.code === "KeyX");
}

/** Whether a key press goes to the page. */
export function keyForPage(e: Pick<KeyboardEvent, "metaKey" | "code">): boolean {
  return !e.metaKey || PAGE_CMD_KEYS.has(e.code);
}

type KeyFields = Pick<KeyboardEvent, "key" | "code" | "keyCode" | "location" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/** What typing the key enters: a printable key's character, or Enter's return. */
function keyText(e: KeyFields): string {
  if (e.metaKey || e.ctrlKey) return "";
  if (e.key === "Enter") return "\r";
  return [...e.key].length === 1 ? e.key : "";
}

export function keyDown(e: KeyFields): BrowserKeyView {
  const text = keyText(e);
  return {
    kind: "key",
    type: text ? "keyDown" : "rawKeyDown",
    key: e.key,
    code: e.code,
    text,
    // Deprecated in the DOM, and exactly what the protocol's windowsVirtualKeyCode is.
    // oxlint-disable-next-line typescript/no-deprecated
    keyCode: e.keyCode,
    modifiers: modifiersOf(e),
    location: e.location,
    autoRepeat: e.repeat,
  };
}

export function keyUp(e: KeyFields): BrowserKeyView {
  return { ...keyDown(e), type: "keyUp", text: "" };
}

/** The most one Input call carries (the daemon refuses more). */
const MAX_BATCH = 256;

/**
 * The events on their way to the page: one call in flight, so they arrive in order, and what
 * piles up behind it goes in the next. Only what has no lasting effect merges: a move into the
 * move before it, a wheel into the wheel before it.
 */
export class InputQueue {
  private queue: BrowserInputView[] = [];
  private sending = false;

  constructor(private readonly send: (events: readonly BrowserInputView[]) => Promise<void>) {}

  push(e: BrowserInputView): void {
    const last = this.queue.at(-1);
    if (e.kind === "mouse" && last?.kind === "mouse" && e.type === last.type && e.buttons === last.buttons && e.modifiers === last.modifiers) {
      if (e.type === "mouseMoved") {
        this.queue[this.queue.length - 1] = e;
        return;
      }
      if (e.type === "mouseWheel") {
        this.queue[this.queue.length - 1] = { ...e, deltaX: last.deltaX + e.deltaX, deltaY: last.deltaY + e.deltaY };
        return;
      }
    }
    this.queue.push(e);
    void this.pump();
  }

  /** Resolves once everything pushed so far has been sent: cmd+c must reach the page before its clipboard is read. */
  async drained(): Promise<void> {
    while (this.sending) await new Promise((r) => setTimeout(r, 5));
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH);
        // A failed batch is gone: replaying input into a page that moved on would be worse.
        await this.send(batch).catch(() => undefined);
      }
    } finally {
      this.sending = false;
    }
  }
}
