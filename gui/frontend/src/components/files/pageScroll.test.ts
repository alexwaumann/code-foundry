import { afterEach, describe, expect, it } from "vitest";
import { framePath, keepPageScroll, pageScrollKey, pageScrollNote, pageScrollOf, resetPageScroll } from "./pageScroll";

afterEach(resetPageScroll);

describe("pageScroll", () => {
  it("keeps the last place per key, forgets the top, and keys a place and file apart", () => {
    const a = pageScrollKey("tab", "thread:s-1", "/Users/me/a.html");
    const b = pageScrollKey("tab", "thread:s-1", "/Users/me/b.html");
    keepPageScroll(a, { x: 0, y: 120 });
    keepPageScroll(a, { x: 4, y: 300 });
    expect(pageScrollOf(a)).toEqual({ x: 4, y: 300 });
    expect(pageScrollOf(b)).toBeNull();
    keepPageScroll(a, { x: 0, y: 0 });
    expect(pageScrollOf(a)).toBeNull();
  });

  it("forgets the least recently scrolled place past 256", () => {
    for (let i = 0; i < 257; i++) keepPageScroll(`k${String(i)}`, { x: 0, y: i + 1 });
    expect(pageScrollOf("k0")).toBeNull();
    expect(pageScrollOf("k1")).toEqual({ x: 0, y: 2 });
    // Scrolling a place again makes it the newest.
    keepPageScroll("k1", { x: 0, y: 9 });
    keepPageScroll("k300", { x: 0, y: 1 });
    expect(pageScrollOf("k1")).toEqual({ x: 0, y: 9 });
    expect(pageScrollOf("k2")).toBeNull();
  });

  it.each([
    ["a report", { type: "cf:scroll", x: 1.4, y: 250, path: "/p.html" }, { x: 1, y: 250, path: "/p.html" }],
    ["a negative overscroll is the top", { type: "cf:scroll", x: -3, y: -10, path: "/p.html" }, { x: 0, y: 0, path: "/p.html" }],
    ["no path", { type: "cf:scroll", x: 0, y: 1 }, null],
    ["not a number", { type: "cf:scroll", x: "a", y: 1, path: "/p.html" }, null],
    ["another message", { type: "cf:here", seq: 1 }, null],
    ["not an object", "cf:scroll", null],
  ])("reads a document's cf:scroll: %s", (_name, data, want) => {
    expect(pageScrollNote(data)).toEqual(want);
  });

  it("names the path a frame URL loads", () => {
    expect(framePath("http://g1.localhost:4100/docs/a%20b.html?cf-page=1#x")).toBe("/docs/a%20b.html");
    expect(framePath("not a url")).toBe("");
  });
});
