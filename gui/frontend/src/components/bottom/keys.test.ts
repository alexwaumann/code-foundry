import { describe, expect, it } from "vitest";
import { bottomKeyAction, tabFocusIndex } from "./keys";

describe("bottomKeyAction", () => {
  const cases: [string, string, string | null, ReturnType<typeof bottomKeyAction>][] = [
    ["cmd+w closes the active terminal", "cmd+w", "t1", { kind: "close", terminalId: "t1" }],
    ["cmd+w with no tabs hides the panel", "cmd+w", null, { kind: "hide" }],
    ["escape is the terminal's", "escape", "t1", null],
    ["cmd+j is the registry's", "cmd+j", "t1", null],
    ["a letter is the terminal's", "w", null, null],
  ];
  it.each(cases)("%s", (_name, chord, active, want) => {
    expect(bottomKeyAction(chord, active)).toEqual(want);
  });
});

describe("tabFocusIndex", () => {
  const cases: [string, string, number, number, number | null][] = [
    ["right", "ArrowRight", 0, 3, 1],
    ["right wraps", "ArrowRight", 2, 3, 0],
    ["left", "ArrowLeft", 2, 3, 1],
    ["left wraps", "ArrowLeft", 0, 3, 2],
    ["home", "Home", 2, 3, 0],
    ["end", "End", 0, 3, 2],
    ["other keys", "Enter", 0, 3, null],
    ["no tabs", "ArrowRight", 0, 0, null],
  ];
  it.each(cases)("%s", (_name, key, index, count, want) => {
    expect(tabFocusIndex(key, index, count)).toBe(want);
  });
});
