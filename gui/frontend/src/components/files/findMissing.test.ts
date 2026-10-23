import { describe, expect, it, vi } from "vitest";
import { findMissing, type SearchFn } from "./findMissing";

const listing =
  (...paths: string[]): SearchFn =>
  () =>
    Promise.resolve({ matches: paths.map((path) => ({ path, isDir: false })), truncated: false });

describe("findMissing", () => {
  const signal = new AbortController().signal;

  it.each<[string, string, string, SearchFn, string | null]>([
    ["one file ends with the path", "p1", "/w/src/a.ts", listing("gui/src/a.ts"), "/w/gui/src/a.ts"],
    ["two do", "p1", "/w/src/a.ts", listing("gui/src/a.ts", "web/src/a.ts"), null],
    ["no project: no search", "", "/w/src/a.ts", listing("gui/src/a.ts"), null],
    ["outside the checkout: no search", "p1", "/elsewhere/a.ts", listing("a.ts"), null],
    ["the search fails (an older daemon)", "p1", "/w/src/a.ts", () => Promise.reject(new Error("unimplemented")), null],
  ])("%s", async (_name, project, abs, search, want) => {
    expect(await findMissing(project, "/w", abs, signal, search)).toBe(want);
  });

  it("asks the tab's checkout for the file name, and rethrows an abort", async () => {
    const search = vi.fn<SearchFn>(listing());
    await findMissing("p1", "/w/", "/w/a/b.ts", signal, search);
    expect(search).toHaveBeenCalledWith({ projectId: "p1", path: "/w/", query: "b.ts", limit: 200 }, signal);
    const c = new AbortController();
    c.abort();
    await expect(findMissing("p1", "/w", "/w/a/b.ts", c.signal, () => Promise.reject(new DOMException("aborted", "AbortError")))).rejects.toThrow("aborted");
  });
});
