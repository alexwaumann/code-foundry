import { describe, expect, it } from "vitest";

import { autoSavedSentence, spanWords } from "./autoTidy";

const DAY = 86_400_000;

describe("spanWords", () => {
  it.each([
    [DAY, "1 day"],
    [3 * DAY, "3 days"],
    [7 * DAY, "1 week"],
    [14 * DAY, "2 weeks"],
    [30 * DAY, "1 month"],
    [90 * DAY, "3 months"],
    [2 * 3_600_000, "2 hours"],
    [90_000, "2 minutes"],
  ])("%d ms is %s", (ms, want) => {
    expect(spanWords(ms)).toBe(want);
  });
});

describe("autoSavedSentence", () => {
  it("says how long the thread had been without activity", () => {
    expect(autoSavedSentence(3 * DAY)).toBe("Saved automatically after 3 days without activity");
    expect(autoSavedSentence(7 * DAY)).toBe("Saved automatically after 1 week without activity");
  });
  it.each([null, undefined, 0])("is null for a thread the user saved (%s)", (v) => {
    expect(autoSavedSentence(v)).toBeNull();
  });
});
