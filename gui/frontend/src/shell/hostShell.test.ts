import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApplyView, LayoutOpView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const ops: LayoutOpView[] = [];
/** While set, the daemon's answers wait for it (a call in flight). */
let applyGate: Promise<void> | null = null;
vi.mock("@/api/layout", async (orig) => ({
  ...(await orig<typeof import("@/api/layout")>()),
  applyLayoutOp: (op: LayoutOpView) => {
    ops.push(op);
    // An opened tab lands in p-9.
    return (applyGate ?? Promise.resolve()).then(() => ({ rev: 0, paneId: op.op === "open_surface" ? "p-9" : "" }) as LayoutApplyView);
  },
}));

const host = await import("./host");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, setShellMode, useShellViewStore } = await import("@/stores/shellView");
const { useUiStore } = await import("@/stores/ui");

// A thread's tab beside a pane of its diff and file, an unlinked diff from Projects, and another thread's MCP.
const grid = layoutOf([
  space(
    row("s-r", [
      pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-pj", "projects")]),
      pane("p-2", [tab("t-d", "diff", "s-1", { params: { project: "pj", worktree: "/w" } }), tab("t-f", "file", "s-1", { params: { path: "/w/a.ts" }, title: "a.ts" }), tab("t-u", "diff", "", { params: { project: "pj" } })], "t-f"),
      pane("p-3", [tab("t-m", "mcp", "s-2")]),
    ]),
    "p-2",
  ),
]);

beforeEach(async () => {
  ops.length = 0;
  resetLayout();
  resetShellView();
  setShellMode("shell");
  await seedLayout(grid);
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

afterEach(() => {
  resetShellView();
  resetLayout();
});

describe("the host seam in the shell", () => {
  it("a thread's place is its linked tabs, grouped by pane, with the side panel's kinds", () => {
    const place = host.tabPlace(host.threadTarget("s-1"));
    expect(place.shown).toBe(true);
    // A File tab keeps the side panel's id, its path (kinds.ts seamTab): its edit session's.
    const fileId = host.tabId("files", { path: "/w/a.ts" });
    expect(place.tabs.map((t) => [t.id, t.kind])).toEqual([
      ["t-d", "diff"],
      [fileId, "files"],
    ]);
    expect(place.groups).toHaveLength(1);
    expect(place.groups[0]?.active?.id).toBe(fileId);
    expect(host.tabPlace("current")).toBe(place);
  });

  it("a page's place is the space's unlinked surfaces; a pane's is its tabs", () => {
    expect(host.tabPlace("view:projects").tabs.map((t) => t.id)).toEqual(["t-u"]);
    expect(host.tabPlace("pane:p-1").tabs.map((t) => t.id)).toEqual(["t-th", "t-pj"]);
  });

  it("keeps a place's identity while its tabs read the same", async () => {
    const before = host.tabPlace(host.threadTarget("s-1"));
    await seedLayout({ ...grid, rev: 2 });
    expect(host.tabPlace(host.threadTarget("s-1"))).toBe(before);
  });

  it("finds a tab by its layout id from any target, and by the id a surface made from its kind and params", () => {
    expect(host.findTab("current", "t-m")?.kind).toBe("mcp");
    expect(host.findTab(host.threadTarget("s-1"), host.tabId("files", { path: "/w/a.ts" }))?.params.path).toBe("/w/a.ts");
    expect(host.findTab("current", "t-f")?.params.path).toBe("/w/a.ts");
  });

  // The user's open (a row, a menu, a chip) is shown and takes the focus and the keyboard; a
  // thread's call (focus: false) moves nothing: the daemon placed its tab without the focus.
  const b = host.makeTab("files", "b.ts", { path: "/w/b.ts" });
  const newB = (focus: boolean, behind?: string): LayoutOpView => ({ op: "open_surface", tab: { kind: "file", thread: "s-1", params: { path: "/w/b.ts" }, title: "b.ts" }, focus, ...(behind ? { behind } : {}) });
  const cases: [string, () => void, LayoutOpView[], string][] = [
    ["the user's new tab: opened with the focus, the keyboard into its pane", () => host.openTab(host.threadTarget("s-1"), b), [newB(true)], "p-9"],
    ["a thread's new tab: opened without it", () => host.openTab(host.threadTarget("s-1"), b, { focus: false }), [newB(false)], ""],
    [
      "the user's open tab hidden in its pane: shown and focused, the keyboard into its pane",
      () => host.openTab("current", host.makeTab("diff", "Diff", { project: "pj", worktree: "/w" })),
      // The focus at once; the params through the tab's queue.
      [{ op: "focus_tab", tab: "t-d" }, { op: "set_tab_params", tab: "t-d", params: { project: "pj", worktree: "/w" }, title: "Diff" }],
      "p-2",
    ],
    [
      "a thread's call on an open hidden tab: its params only",
      () => host.openTab("current", host.makeTab("diff", "Diff", { project: "pj", worktree: "/w" }), { focus: false }),
      [{ op: "set_tab_params", tab: "t-d", params: { project: "pj", worktree: "/w" }, title: "Diff" }],
      "",
    ],
    ["the user's open of the tab already shown and focused, as it is: nothing sent, the keyboard stays", () => host.openTab("current", host.makeTab("files", "a.ts", { path: "/w/a.ts" })), [], ""],
    ["the user's open of the tab already shown and focused, at a line: its params only, the keyboard stays", () => host.openTab("current", host.makeTab("files", "a.ts", { path: "/w/a.ts", line: "4" })), [{ op: "set_tab_params", tab: "t-f", params: { path: "/w/a.ts", line: "4" }, title: "a.ts" }], ""],
    // `behind` (a tab the user is typing in) wins over the default: nothing takes the focus or the keyboard.
    ["a thread's request behind the editor being typed in: opened without the focus, behind it", () => host.openTab(host.threadTarget("s-1"), b, { behind: host.tabId("files", { path: "/w/a.ts" }), focus: false }), [newB(false, "t-f")], ""],
    ["an open behind the editor with the default focus: still without it, behind it", () => host.openTab(host.threadTarget("s-1"), b, { behind: host.tabId("files", { path: "/w/a.ts" }) }), [newB(false, "t-f")], ""],
    [
      "an open hidden tab behind the editor with the default focus: its params only",
      () => host.openTab("current", host.makeTab("diff", "Diff", { project: "pj", worktree: "/w" }), { behind: "t-f" }),
      [{ op: "set_tab_params", tab: "t-d", params: { project: "pj", worktree: "/w" }, title: "Diff" }],
      "",
    ],
  ];
  it.each(cases)("%s", async (_name, open, want, keyboard) => {
    open();
    await vi.waitFor(() => {
      expect(ops).toEqual(want);
    });
    if (keyboard) {
      await vi.waitFor(() => {
        expect(useShellViewStore.getState().focusRequest.paneId).toBe(keyboard);
      });
    } else {
      await new Promise((r) => setTimeout(r, 0));
      expect(useShellViewStore.getState().focusRequest.seq).toBe(0);
    }
  });

  it("an open tab takes the new params where it is, through the tab's queue; the same ones send nothing", async () => {
    host.openTab(host.threadTarget("s-1"), host.makeTab("files", "a.ts", { path: "/w/a.ts" }), { behind: "t-d" });
    host.openTab(host.threadTarget("s-1"), host.makeTab("files", "a.ts", { path: "/w/a.ts", line: "3" }), { behind: "t-d" });
    await vi.waitFor(() => {
      expect(ops).toEqual([{ op: "set_tab_params", tab: "t-f", params: { path: "/w/a.ts", line: "3" }, title: "a.ts" }]);
    });
  });

  it("finds an open tab by the daemon's identity: kind, link and key params, whatever else its params hold", () => {
    const own = { project: "pj", worktree: "/w" };
    // The user's diff with a file and sides picked is still the checkout's tab.
    expect(host.findTab(host.threadTarget("s-1"), host.tabId("diff", { ...own, path: "x.go", base: "ref:v1" }))?.id).toBe("t-d");
    // A thread's framed diff (its asker) is a tab of its own, not the user's.
    expect(host.findTab(host.threadTarget("s-1"), host.tabId("diff", { ...own, thread: "s-1" }))).toBeUndefined();
    // Another thread's tabs are not this one's.
    expect(host.findTab(host.threadTarget("s-2"), host.tabId("diff", own))).toBeUndefined();
  });

  it("finds a pull request's tab however its slug is spelled", async () => {
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-pr", "pullrequest", "s-1", { params: { slug: "Acme/Repo", number: "5" } })]), "p-1")], 4));
    expect(host.findTab(host.threadTarget("s-1"), host.pullRequestTabId("acme/REPO", "5"))?.params.slug).toBe("Acme/Repo");
    expect(host.findTab(host.threadTarget("s-1"), host.pullRequestTabId("acme/repo", "6"))).toBeUndefined();
  });

  it("a new tab opened behind a tab names it: the daemon keeps it behind if it lands in that tab's pane", () => {
    host.openTab(host.threadTarget("s-1"), host.makeTab("files", "b.ts", { path: "/w/b.ts" }), { behind: host.tabId("files", { path: "/w/a.ts" }) });
    expect(ops).toEqual([{ op: "open_surface", tab: { kind: "file", thread: "s-1", params: { path: "/w/b.ts" }, title: "b.ts" }, focus: false, behind: "t-f" }]);
  });

  it("sets params and titles by the layout id, and skips a change that changes nothing", async () => {
    host.setTabParams("current", "t-d", { project: "pj", worktree: "/w" });
    host.setTabParams("current", "t-d", (old) => ({ ...old, file: "x.go" }));
    host.retitleTab("current", "t-d", "main vs working");
    await vi.waitFor(() => {
      expect(ops).toEqual([
        { op: "set_tab_params", tab: "t-d", params: { project: "pj", worktree: "/w", file: "x.go" } },
        { op: "set_tab_params", tab: "t-d", params: { project: "pj", worktree: "/w", file: "x.go" }, title: "main vs working" },
      ]);
    });
  });

  // A File tab's save stamps the request (askSaved), then ends it (the ask params gone): the second
  // starts from the first, not from the layout's confirmed params, and is sent after it.
  it("sends a tab's updates in order, each from the one before it", async () => {
    const opened: (() => void)[] = [];
    applyGate = new Promise<undefined>((resolve) => {
      opened.push(() => {
        resolve(undefined);
      });
    }).then(() => undefined);
    const release = () => {
      for (const open of opened) open();
    };
    host.setTabParams("current", "t-d", (old) => ({ ...old, askId: "a-1", askSaved: "v1" }));
    host.setTabParams("current", "t-d", (old) => Object.fromEntries(Object.entries(old).filter(([k]) => !k.startsWith("ask"))));
    await Promise.resolve();
    expect(ops).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(ops.map((o) => (o.op === "set_tab_params" ? o.params : null))).toEqual([
        { project: "pj", worktree: "/w", askId: "a-1", askSaved: "v1" },
        { project: "pj", worktree: "/w" },
      ]);
    });
    applyGate = null;
  });

  it("names targets by selection; a selection of nothing has none, and its place is empty", () => {
    expect(host.targetOf({ kind: "thread", id: "s-1" })).toBe("thread:s-1");
    expect(host.targetOf({ kind: "view", name: "projects" })).toBe("view:projects");
    expect(host.targetOf({ kind: "none" })).toBeNull();
    expect(host.threadOfTarget("current")).toBe("s-1");
    expect(host.threadOfTarget("view:projects")).toBe("");
    const { result } = renderHook(() => host.useTabPlace(null, (p) => p.tabs.length));
    expect(result.current).toBe(0);
    expect(host.tabPlace(host.threadTarget("s-9"))).toMatchObject({ shown: false, tabs: [], focused: 0 });
  });

  it("tells subscribers when a target's tabs change", async () => {
    const seen: string[][] = [];
    const stop = host.subscribeTabs((now) => {
      seen.push(Object.keys(now).sort());
    });
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-d", "diff", "s-1")]), "p-1")], 3));
    stop();
    expect(seen).toEqual([["pane:p-1", "thread:s-1"]]);
  });
});
