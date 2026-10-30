import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PanelKeyContext } from "@/components/panel/panelKeyContext";
import { usePageThread } from "./usePageThread";

const PAGE = "/Users/me/p/welcome.html";

function inPanel(key: string) {
  return ({ children }: { children: ReactNode }) => <PanelKeyContext.Provider value={key}>{children}</PanelKeyContext.Provider>;
}

describe("usePageThread", () => {
  it.each([
    ["a thread's own page (view.panel.page), titled", "thread:s-1", { title: "Welcome" }, { thread: "s-1", title: "Welcome" }],
    ["a thread's own page, untitled", "thread:s-1", { title: "" }, { thread: "s-1", title: "" }],
    ["a file the thread never showed", "thread:s-1", undefined, null],
    ["a page flag outside a thread's panel", "view:projects", { title: "Welcome" }, null],
    ["a page flag outside any panel", "", { title: "Welcome" }, null],
  ])("%s", (_name, key, own, want) => {
    const { result } = renderHook(() => usePageThread(PAGE, own), { wrapper: inPanel(key) });
    expect(result.current).toEqual(want);
  });
});
