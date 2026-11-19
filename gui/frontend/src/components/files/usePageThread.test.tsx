import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { usePageThread } from "./usePageThread";

const PAGE = "/Users/me/p/welcome.html";

function inPanel(key: string) {
  return ({ children }: { children: ReactNode }) => <PanelKeyContext.Provider value={key}>{children}</PanelKeyContext.Provider>;
}

describe("usePageThread", () => {
  it.each([
    ["a thread's own page (view.panel.page), titled", "thread:s-1", { title: "Welcome" }, { thread: "s-1", title: "Welcome" }, ""],
    ["a thread's own page, untitled", "thread:s-1", { title: "" }, { thread: "s-1", title: "" }, ""],
    ["a file the thread never showed", "thread:s-1", undefined, null, ""],
    ["a page flag outside a thread's panel", "view:projects", { title: "Welcome" }, null, ""],
    ["a page flag outside any panel", "", { title: "Welcome" }, null, ""],
    // No log is loaded in any of these: the daemon's word is enough for the thread's own pages.
    ["a file in the thread's pages directory, its log not loaded", "thread:s-1", undefined, { thread: "s-1", title: "" }, "s-1"],
    ["a file in another thread's pages directory", "thread:s-1", undefined, null, "s-2"],
    ["a file in a thread's pages directory, in an unlinked tab", "", undefined, null, "s-1"],
  ])("%s", (_name, key, own, want, pageThread) => {
    const { result } = renderHook(() => usePageThread(PAGE, own, pageThread), { wrapper: inPanel(key) });
    expect(result.current).toEqual(want);
  });
});
