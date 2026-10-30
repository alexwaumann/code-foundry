import { describe, expect, it } from "vitest";
import { barHeight, decayLevels, downloadProgress, easeLevels, formatElapsed, gigabytes, LEVEL_BARS, LEVEL_EASE_MS, LEVEL_HALF_LIFE_MS, levelOf, memorySize, phraseAtCaret, pushLevel } from "./dictation";

describe("phraseAtCaret", () => {
  it.each([
    { name: "empty prompt", before: "", after: "", text: "Hello there.", want: "Hello there." },
    { name: "after a word", before: "first.", after: "", text: "Then this.", want: " Then this." },
    { name: "after a space", before: "first. ", after: "", text: "Then this.", want: "Then this." },
    { name: "after a newline-free tab", before: "a\t", after: "", text: "b", want: "b" },
    { name: "trims the engine's spaces", before: "x", after: "", text: "  then  ", want: " then" },
    { name: "keeps capitalisation", before: "and", after: "", text: "Lower stays Upper", want: " Lower stays Upper" },
    { name: "a word straight after", before: "one", after: "two", text: "mid", want: " mid " },
    { name: "punctuation after", before: "one", after: ".", text: "mid", want: " mid" },
    { name: "space after", before: "one", after: " two", text: "mid", want: " mid" },
    { name: "blank phrase", before: "x", after: "", text: "   ", want: "" },
  ])("$name", ({ before, after, text, want }) => {
    expect(phraseAtCaret(text, before, after)).toBe(want);
  });
});

describe("level bars", () => {
  it("pushes a level in on the right and keeps seven bars", () => {
    let bars: number[] = [];
    for (let i = 0; i < 10; i++) bars = pushLevel(bars, 0.1);
    expect(bars).toHaveLength(LEVEL_BARS);
    bars = pushLevel(bars, 0);
    expect(bars.at(-1)).toBe(0);
    expect(bars[0]).toBeGreaterThan(0);
  });

  it("pads a short history with silence", () => {
    expect(pushLevel([], 0.25)).toEqual([0, 0, 0, 0, 0, 0, levelOf(0.25)]);
  });

  it.each([
    { rms: 0, want: 0 },
    { rms: Number.NaN, want: 0 },
    { rms: 0.003, want: 0 }, // a quiet room, below the -50 dBFS floor
    { rms: 0.00316, want: 0 },
    { rms: 0.02, want: 0.46 }, // speech, as PR 3 measured it
    { rms: 0.05, want: 0.69 },
    { rms: 0.178, want: 1 },
    { rms: 1, want: 1 },
  ])("maps rms $rms to $want on the dBFS scale", ({ rms, want }) => {
    expect(levelOf(rms)).toBeCloseTo(want, 2);
  });

  it("eases drawn bars toward their levels", () => {
    const [one] = easeLevels([0], [1], LEVEL_EASE_MS);
    expect(one).toBeCloseTo(1 - Math.exp(-1));
    expect(easeLevels([0.5], [0.2], 0)).toEqual([0.5]);
    expect(easeLevels([0.5], [0.2], LEVEL_EASE_MS * 20)).toEqual([0.2]);
    expect(easeLevels([], [0.3, 0], LEVEL_EASE_MS)[0]).toBeGreaterThan(0);
  });

  it("halves each half-life and drops to zero", () => {
    const [half] = decayLevels([0.8], LEVEL_HALF_LIFE_MS);
    expect(half).toBeCloseTo(0.4);
    expect(decayLevels([0.8], 0)).toEqual([0.8]);
    expect(decayLevels([0.8], LEVEL_HALF_LIFE_MS * 10)).toEqual([0]);
  });

  it("heights run 3 to 14 px", () => {
    expect(barHeight(0)).toBe(3);
    expect(barHeight(1)).toBe(14);
    expect(barHeight(2)).toBe(14);
    expect(barHeight(-1)).toBe(3);
  });
});

describe("formatting", () => {
  it.each([
    [0, "0:00"],
    [4_200, "0:04"],
    [61_000, "1:01"],
    [750_000, "12:30"],
    [-5, "0:00"],
  ])("formatElapsed(%d)", (ms, want) => {
    expect(formatElapsed(ms)).toBe(want);
  });

  it("sizes", () => {
    expect(gigabytes(874_188_075)).toBe("0.9 GB");
    expect(memorySize(48 * 2 ** 30)).toBe("48 GB");
    expect(downloadProgress(557_000_000, 874_188_075, 11_200_000)).toBe("557 MB of 874 MB · 11 MB/s");
    expect(downloadProgress(1_000_000, 874_188_075, 0)).toBe("1 MB of 874 MB");
  });
});
