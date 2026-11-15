import { describe, expect, it } from "vitest";
import { byteRange, mockLog, tailOf } from "./media";

describe("byteRange", () => {
  it.each([
    [undefined, null],
    ["items=0-1", null],
    ["bytes=0-1,4-5", null],
    ["bytes=0-9", { start: 0, end: 9 }],
    ["bytes=40-49", { start: 40, end: 49 }],
    ["bytes=90-", { start: 90, end: 99 }],
    ["bytes=-5", { start: 95, end: 99 }],
    ["bytes=-500", { start: 0, end: 99 }],
    ["bytes=98-500", { start: 98, end: 99 }],
    ["bytes=100-", "unsatisfiable"],
    ["bytes=5-4", "unsatisfiable"],
    ["bytes=-0", "unsatisfiable"],
    ["bytes=-", "unsatisfiable"],
    ["bytes=x-1", "unsatisfiable"],
  ])("%s of 100 bytes", (header, want) => {
    expect(byteRange(header, 100)).toEqual(want);
  });
});

describe("tailOf, as the daemon's ReadTail", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  it.each([
    ["one\ntwo\n", 100, "one\ntwo\n", 0],
    ["aaaa\nbbbb\ncccc\n", 8, "cccc\n", 10],
    ["aaa\nbbb\n", 4, "bbb\n", 4],
    ["abcdefghij", 4, "ghij", 6],
    ["abcdefghij\n", 4, "hij\n", 7],
    ["line1\r\nline2\r\nline3\r\n", 8, "line3\r\n", 14],
    ["ééééé", 5, "éé", 6],
    ["😀😀😀", 5, "😀", 8],
  ])("%j, last %d bytes", (text, limit, want, offset) => {
    const t = tailOf(enc.encode(text), limit);
    expect([dec.decode(t.contents), t.offset]).toEqual([want, offset]);
  });
});

describe("mockLog", () => {
  it("is at least the size asked, in whole lines, ending on a marked last line", () => {
    const log = mockLog(64 * 1024);
    expect(log.length).toBeGreaterThanOrEqual(64 * 1024);
    expect(log.endsWith(" · the end\n")).toBe(true);
    expect(log).toContain("\u001b[31mERROR\u001b[0m");
  });
});
