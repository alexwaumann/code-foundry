import { describe, expect, it } from "vitest";
import { chordFromEvent, formatChord, normalizeChord, parseChord } from "./chord";

describe("parseChord", () => {
  it.each([
    ["cmd+k", { key: "k", cmd: true, ctrl: false, alt: false, shift: false }],
    ["cmd+shift+p", { key: "p", cmd: true, ctrl: false, alt: false, shift: true }],
    ["Ctrl+Alt+Enter", { key: "enter", cmd: false, ctrl: true, alt: true, shift: false }],
    ["meta+opt+esc", { key: "escape", cmd: true, ctrl: false, alt: true, shift: false }],
    ["⌘⇧+k", null],
    ["⌘+⇧+k", { key: "k", cmd: true, ctrl: false, alt: false, shift: true }],
    ["cmd++", { key: "+", cmd: true, ctrl: false, alt: false, shift: false }],
    ["cmd+=", { key: "=", cmd: true, ctrl: false, alt: false, shift: false }],
    ["option+up", { key: "arrowup", cmd: false, ctrl: false, alt: true, shift: false }],
    ["f5", { key: "f5", cmd: false, ctrl: false, alt: false, shift: false }],
    ["  cmd+1 ", { key: "1", cmd: true, ctrl: false, alt: false, shift: false }],
    ["", null],
    ["cmd+", null],
    ["hyper+k", null],
  ])("%j", (input, want) => {
    expect(parseChord(input)).toEqual(want);
  });
});

describe("normalizeChord", () => {
  it.each([
    ["shift+cmd+P", "cmd+shift+p"],
    ["alt+ctrl+cmd+shift+x", "cmd+ctrl+alt+shift+x"],
    ["control+return", "ctrl+enter"],
    ["cmd+comma", "cmd+,"],
    ["nope+x", null],
  ])("%s -> %s", (input, want) => {
    expect(normalizeChord(input)).toBe(want);
  });
});

function ev(key: string, code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("chordFromEvent", () => {
  it.each([
    ["cmd+k", ev("k", "KeyK", { metaKey: true }), "cmd+k"],
    ["cmd+shift+p (key is uppercase)", ev("P", "KeyP", { metaKey: true, shiftKey: true }), "cmd+shift+p"],
    ["alt+p produces π on macOS", ev("π", "KeyP", { altKey: true }), "alt+p"],
    ["shift+1 produces !", ev("!", "Digit1", { shiftKey: true }), "shift+1"],
    ["cmd+=", ev("=", "Equal", { metaKey: true }), "cmd+="],
    ["cmd+- ", ev("-", "Minus", { metaKey: true }), "cmd+-"],
    ["arrow", ev("ArrowDown", "ArrowDown"), "arrowdown"],
    ["enter", ev("Enter", "Enter", { ctrlKey: true }), "ctrl+enter"],
    ["space", ev(" ", "Space"), "space"],
    ["bare modifier", ev("Meta", "MetaLeft", { metaKey: true }), null],
    ["bare shift", ev("Shift", "ShiftLeft", { shiftKey: true }), null],
  ])("%s", (_name, e, want) => {
    expect(chordFromEvent(e)).toBe(want);
  });
});

describe("formatChord", () => {
  it.each([
    ["cmd+k", "⌘K"],
    ["cmd+shift+p", "⇧⌘P"],
    ["ctrl+alt+enter", "⌃⌥↵"],
    ["cmd+arrowup", "⌘↑"],
    ["f12", "F12"],
    ["garbage+x", "garbage+x"],
  ])("%s -> %s", (input, want) => {
    expect(formatChord(input)).toBe(want);
  });
});
