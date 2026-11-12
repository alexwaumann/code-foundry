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
    return (applyGate ?? Promise.resolve()).then(() => ({ rev: 0 }) as LayoutApplyView);
  },
}));

const host = await import("./host");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, setShellMode } = await import("@/stores/shellView");
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

  it("opens a new tab through the daemon, linked to the target's thread, without focus", () => {
    host.openTab(host.threadTarget("s-1"), host.makeTab("files", "b.ts", { path: "/w/b.ts" }));
    expect(ops).toEqual([{ op: "open_surface", tab: { kind: "file", thread: "s-1", params: { path: "/w/b.ts" }, title: "b.ts" }, focus: false }]);
  });

  it("an open tab takes the new params where it is", () => {
    host.openTab(host.threadTarget("s-1"), host.makeTab("files", "a.ts", { path: "/w/a.ts" }), { behind: true });
    expect(ops).toEqual([{ op: "set_tab_params", tab: "t-f", params: { path: "/w/a.ts" }, title: "a.ts" }]);
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

  it("has nothing to show or expand", () => {
    expect(host.showTabs(host.threadTarget("s-1"), true)).toBe(true);
    expect(host.showTabs(host.threadTarget("s-9"), true)).toBe(false);
    expect(host.expandTabs("current")).toBe(false);
    expect(ops).toEqual([]);
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
