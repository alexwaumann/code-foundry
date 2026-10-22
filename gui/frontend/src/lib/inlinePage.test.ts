import { describe, expect, it } from "vitest";
import { DEFAULT_HEIGHT, frameHeight, inlinePage } from "./inlinePage";
import { resizeHeight } from "@/components/files/previewGrant";

describe("frameHeight", () => {
  it.each([
    ["the default without an ask", null, 1000, DEFAULT_HEIGHT],
    ["the page's ask", 230, 1000, 230],
    ["capped at 60% of the pane", 900, 1000, 600],
    ["the default capped too", null, 500, 300],
    ["a tiny ask floors", 3, 1000, 48],
    ["a fractional ask rounds up", 120.2, 1000, 121],
  ])("%s", (_name, asked, pane, want) => {
    expect(frameHeight(asked, pane)).toBe(want);
  });
});

describe("inlinePage", () => {
  it("a path relative to the thread's cwd", () => {
    expect(inlinePage({ path: "docs/usage/week.html", baseDir: "/Users/me/proj", title: "" })).toEqual({
      abs: "/Users/me/proj/docs/usage/week.html",
      name: "week.html",
      dir: "docs/usage",
      baseDir: "/Users/me/proj",
      path: "docs/usage/week.html",
      title: "",
    });
  });
  it("a file in the cwd itself has no directory", () => {
    expect(inlinePage({ path: "hello.html", baseDir: "/Users/me/proj", title: "Hi" })).toMatchObject({ abs: "/Users/me/proj/hello.html", dir: "", title: "Hi" });
  });
});

describe("resizeHeight", () => {
  it.each([
    ["a resize", { type: "cf:resize", height: 300 }, 300],
    ["another message", { type: "cf:theme", height: 300 }, null],
    ["a string height", { type: "cf:resize", height: "300" }, null],
    ["a zero height", { type: "cf:resize", height: 0 }, null],
    ["not an object", "cf:resize", null],
    ["null", null, null],
  ])("%s", (_name, data, want) => {
    expect(resizeHeight(data)).toBe(want);
  });
});
