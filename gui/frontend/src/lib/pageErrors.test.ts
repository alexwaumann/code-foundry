import { describe, expect, it } from "vitest";
import { addPageError, askAboutPageErrors, PAGE_ERRORS_MAX, pageErrorCount, type PageError } from "./pageErrors";

const err = (call: string, atMs = 1, message = "bad"): Omit<PageError, "count"> => ({ call, code: "invalid", message, atMs });

describe("addPageError", () => {
  it("appends a new error", () => {
    expect(addPageError([], err("pr.merge"))).toEqual([{ ...err("pr.merge"), count: 1 }]);
  });
  it("dedupes a repeat: count up, latest time, moved to the end", () => {
    let list = addPageError([], err("pr.merge", 1));
    list = addPageError(list, err("thread.new", 2));
    list = addPageError(list, err("pr.merge", 3));
    expect(list.map((e) => [e.call, e.count, e.atMs])).toEqual([
      ["thread.new", 1, 2],
      ["pr.merge", 2, 3],
    ]);
  });
  it("tells errors apart by message", () => {
    const list = addPageError(addPageError([], err("pr.merge", 1, "a")), err("pr.merge", 2, "b"));
    expect(list).toHaveLength(2);
  });
  it("keeps the latest few", () => {
    let list: PageError[] = [];
    for (let i = 0; i < PAGE_ERRORS_MAX + 2; i++) list = addPageError(list, err(`v${String(i)}`, i));
    expect(list.map((e) => e.call)).toEqual(["v2", "v3", "v4", "v5", "v6"]);
    expect(pageErrorCount(addPageError(list, err("v6", 9)))).toBe(PAGE_ERRORS_MAX + 1);
  });
});

describe("askAboutPageErrors", () => {
  it("names the page and lists each error", () => {
    const list = addPageError(addPageError([], { call: "pr.merge", code: "invalid", message: 'unknown argument "headSha"', atMs: 1 }), {
      call: "pr.merge",
      code: "invalid",
      message: 'unknown argument "headSha"',
      atMs: 2,
    });
    expect(askAboutPageErrors("My PR tracker", list)).toBe('The page My PR tracker got this error from Code Foundry. Please fix the page:\n- pr.merge: invalid: unknown argument "headSha" (2 times)');
  });
});
