import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilePreview } from "@/api/files";
import type { PageAccessView } from "@/api/page";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { useThreadStore } from "@/stores/thread";
import { usePageThread, type PageOf } from "./usePageThread";

const PAGE = "/Users/me/p/welcome.html";

function inPanel(key: string) {
  return ({ children }: { children: ReactNode }) => <PanelKeyContext.Provider value={key}>{children}</PanelKeyContext.Provider>;
}

const grant = (pageThread: string, page: PageAccessView | null = null): FilePreview => ({ url: "http://127.0.0.1:1/preview/g/welcome.html", scope: "/Users/me/p", singleFile: false, pageThread, page });

const access = (over: Partial<PageAccessView>): PageAccessView => ({ path: PAGE, ownerThread: "", ownerSource: "", consent: "not-asked", answer: "not-asked", unavailableReason: "", ...over });

afterEach(() => {
  useThreadStore.setState({ logs: {} });
});

describe("usePageThread: a daemon older than page ownership (no page in the grant)", () => {
  const none: PageOf = { thread: null, title: "", actsFor: "", access: null };
  const of = (thread: string, title: string): PageOf => ({ thread, title, actsFor: "", access: null });
  it.each([
    ["a thread's own page (view.panel.page), titled", "thread:s-1", { title: "Welcome" }, of("s-1", "Welcome"), ""],
    ["a thread's own page, untitled", "thread:s-1", { title: "" }, of("s-1", ""), ""],
    ["a file the thread never showed", "thread:s-1", undefined, none, ""],
    ["a page flag outside a thread's panel", "view:projects", { title: "Welcome" }, none, ""],
    ["a page flag outside any panel", "", { title: "Welcome" }, none, ""],
    // No log is loaded in any of these: the daemon's word is enough for the thread's own pages.
    ["a file in the thread's pages directory, its log not loaded", "thread:s-1", undefined, of("s-1", ""), "s-1"],
    ["a file in another thread's pages directory", "thread:s-1", undefined, none, "s-2"],
    ["a file in a thread's pages directory, in an unlinked tab", "", undefined, none, "s-1"],
  ])("%s", (_name, key, own, want, pageThread) => {
    const { result } = renderHook(() => usePageThread(PAGE, own, grant(pageThread)), { wrapper: inPanel(key) });
    expect(result.current).toEqual(want);
  });

  it("a file the tab's thread showed, from its log, with the title it was shown with", () => {
    useThreadStore.setState({ logs: { "s-1": { byId: { h: { kind: "html", id: "h", path: PAGE, baseDir: "", title: "Board" } } } } } as never);
    const { result } = renderHook(() => usePageThread(PAGE, undefined, grant("")), { wrapper: inPanel("thread:s-1") });
    expect(result.current).toEqual(of("s-1", "Board"));
  });
});

describe("usePageThread: the daemon's word (docs/notes/page-ownership-gui.md)", () => {
  it.each([
    ["owned by the tab's thread: its bridge, nobody named", "thread:s-1", access({ consent: "owned", ownerThread: "s-1", ownerSource: "shown" }), { thread: "s-1", actsFor: "" }],
    ["owned by another thread: its bridge, and named", "thread:s-1", access({ consent: "owned", ownerThread: "s-2", ownerSource: "written" }), { thread: "s-2", actsFor: "s-2" }],
    ["owned, in an unlinked tab, its thread's view never opened", "", access({ consent: "owned", ownerThread: "s-2", ownerSource: "pages-directory" }), { thread: "s-2", actsFor: "s-2" }],
    ["allowed: the bridge without a thread, at the resolved path", "thread:s-1", access({ consent: "allowed", answer: "allowed" }), { thread: null, actsFor: "", bridge: { kind: "allowed", path: PAGE } }],
    ["not asked: ask", "", access({}), { thread: null, bridge: { kind: "ask" } }],
    ["refused: every call refused, saying so", "", access({ consent: "refused", answer: "refused" }), { thread: null, bridge: { kind: "refused", error: { code: "unavailable", message: "the user has not allowed this page to use Code Foundry" } } }],
    [
      "unavailable: refused with the daemon's reason",
      "",
      access({ path: "", consent: "unavailable", answer: "unavailable" as never, unavailableReason: "/x/a.html is not under your home folder" }),
      { thread: null, bridge: { kind: "refused", error: { code: "unavailable", message: "Code Foundry gives this page no bridge: /x/a.html is not under your home folder" } } },
    ],
  ])("%s", (_name, key, page, want) => {
    const { result } = renderHook(() => usePageThread(PAGE, undefined, grant("", page)), { wrapper: inPanel(key) });
    expect(result.current).toMatchObject({ ...want, access: page });
    if (!("bridge" in want)) expect(result.current.bridge).toBeUndefined();
  });

  it("the page flag does not make an unowned page the tab's thread's: the daemon decides", () => {
    const { result } = renderHook(() => usePageThread(PAGE, { title: "Welcome" }, grant("", access({}))), { wrapper: inPanel("thread:s-1") });
    expect(result.current).toMatchObject({ thread: null, title: "Welcome", bridge: { kind: "ask" } });
  });

  it("the title comes from the owner's log, not the tab's thread's", () => {
    useThreadStore.setState({ logs: { "s-2": { byId: { h: { kind: "html", id: "h", path: PAGE, baseDir: "", title: "Board" } } } } } as never);
    const { result } = renderHook(() => usePageThread(PAGE, undefined, grant("", access({ consent: "owned", ownerThread: "s-2" }))), { wrapper: inPanel("thread:s-1") });
    expect(result.current).toMatchObject({ thread: "s-2", title: "Board", actsFor: "s-2" });
  });
});
