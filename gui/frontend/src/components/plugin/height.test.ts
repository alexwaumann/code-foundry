import { describe, expect, it } from "vitest";
import { FILL_MIN, fillHeight, terminalAutoHeight } from "./height";

describe("node heights", () => {
  it("fill takes the rest of the scroll box below the node, never under FILL_MIN", () => {
    expect(fillHeight(900, 200)).toBe(684);
    expect(fillHeight(400, 300)).toBe(FILL_MIN);
  });
  it("an auto terminal is its rows (default 16, out of range too) at the font size", () => {
    expect(terminalAutoHeight(undefined, 13)).toBe(16 * 17 + 8);
    expect(terminalAutoHeight(10, 13)).toBe(178);
    expect(terminalAutoHeight(99, 13)).toBe(terminalAutoHeight(16, 13));
    expect(terminalAutoHeight(10, 26)).toBe(348);
  });
});
