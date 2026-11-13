import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApplyView, LayoutDeltaView, LayoutEventView, LayoutNodeView, LayoutSpaceView, LayoutTabView, LayoutView } from "@/api/layout";

const getLayout = vi.fn<() => Promise<LayoutView>>();
const applyLayoutOp = vi.fn<(op: unknown) => Promise<LayoutApplyView>>();
vi.mock("@/api/layout", async (orig) => ({ ...(await orig<typeof import("@/api/layout")>()), getLayout: () => getLayout(), applyLayoutOp: (op: unknown) => applyLayoutOp(op) }));

const { applyLayoutEvent, focusPane, focusTab, geoTree, resetLayout, useLayoutStore, usePane, useTab, useTree } = await import("./layout");

// ---- Fixtures: a space with a thread pane beside a pane of two linked tabs, and a second space ----

const tab = (id: string, kind: string, thread = ""): LayoutTabView => ({ id, kind, thread, key: `${kind}:${id}`, params: {}, title: "", name: "" });
const pane = (id: string, tabs: LayoutTabView[], active = tabs[0]?.id ?? ""): LayoutNodeView => ({ t: "pane", id, tabs, active });

function mainSpace(over: Partial<LayoutSpaceView> = {}, rightActive = "t-d"): LayoutSpaceView {
  return {
    id: "sp-a",
    name: "Main",
    root: { t: "split", id: "s-r", dir: "row", kids: [pane("p-a", [tab("t-a", "thread", "th-a")]), pane("p-b", [tab("t-d", "diff", "th-a"), tab("t-f", "file", "th-a")], rightActive)], sizes: [0.6, 0.4] },
    focus: "p-a",
    mru: ["t-a", "t-d"],
    drafts: [],
    ...over,
  };
}

const review: LayoutSpaceView = { id: "sp-b", name: "Review", root: pane("p-c", [tab("t-c", "thread", "th-c")]), focus: "p-c", mru: ["t-c"], drafts: [{ id: "d-1", label: "Fix the build", params: { project: "pj" } }] };

function layout(rev: number, spaces = [mainSpace(), review]): LayoutView {
  return { rev, spaces, currentSpaceId: "sp-a", defaultSpaceId: "sp-a", threads: [{ threadId: "th-c", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "" }] };
}

const snapshot = (l: LayoutView): LayoutEventView => ({ kind: "snapshot", rev: l.rev, layout: l, clientId: "" });

function delta(rev: number, d: Partial<LayoutDeltaView>, clientId = ""): LayoutEventView {
  return {
    kind: "delta",
    rev,
    clientId,
    delta: { spaces: [], removedSpaceIds: [], spaceOrder: ["sp-a", "sp-b"], currentSpaceId: "sp-a", defaultSpaceId: "sp-a", threads: [], removedThreadIds: [], ...d },
  };
}

const state = () => useLayoutStore.getState();

beforeEach(() => {
  resetLayout();
  getLayout.mockReset();
  applyLayoutOp.mockReset();
});

afterEach(() => {
  resetLayout();
});

describe("applying the layout source", () => {
  it("holds a snapshot as spaces, trees, panes, tabs and threads", () => {
    applyLayoutEvent(snapshot(layout(4)));
    const s = state();
    expect(s.loaded).toBe(true);
    expect(s.rev).toBe(4);
    expect(s.spaceOrder).toEqual(["sp-a", "sp-b"]);
    expect(s.trees["sp-a"]).toEqual({ t: "split", id: "s-r", dir: "row", kids: [{ t: "pane", id: "p-a" }, { t: "pane", id: "p-b" }], sizes: [0.6, 0.4] });
    expect(s.panes["p-b"]).toEqual({ id: "p-b", spaceId: "sp-a", tabIds: ["t-d", "t-f"], active: "t-d" });
    expect(s.tabs["t-f"]).toMatchObject({ kind: "file", thread: "th-a", paneId: "p-b" });
    expect(s.spaces["sp-b"]).toEqual({ id: "sp-b", name: "Review", focus: "p-c", mru: ["t-c"], drafts: [{ id: "d-1", label: "Fix the build", params: { project: "pj" } }] });
    expect(s.threads["th-c"]?.spaceId).toBe("sp-b");
  });

  it("keeps the identity of every space, tree, pane and tab a delta did not change", () => {
    applyLayoutEvent(snapshot(layout(4)));
    const before = state();
    // The commit makes t-f active in p-b: only that pane (and the space it is in, whole) is new.
    applyLayoutEvent(delta(5, { spaces: [mainSpace({}, "t-f")] }));
    const after = state();
    expect(after.rev).toBe(5);
    expect(after.panes["p-b"]).not.toBe(before.panes["p-b"]);
    expect(after.panes["p-b"]?.active).toBe("t-f");
    expect(after.panes["p-a"]).toBe(before.panes["p-a"]);
    expect(after.panes["p-c"]).toBe(before.panes["p-c"]);
    expect(after.tabs).toBe(before.tabs);
    expect(after.trees).toBe(before.trees);
    expect(after.spaces).toBe(before.spaces);
    expect(after.threads).toBe(before.threads);
    expect(after.spaceOrder).toBe(before.spaceOrder);
  });

  it("re-renders a pane's hook only for its own pane", () => {
    applyLayoutEvent(snapshot(layout(4)));
    let rendersA = 0;
    let rendersB = 0;
    renderHook(() => {
      rendersA++;
      return [usePane("p-a"), useTab("t-a"), useTree("sp-a")];
    });
    renderHook(() => {
      rendersB++;
      return usePane("p-b");
    });
    act(() => {
      applyLayoutEvent(delta(5, { spaces: [mainSpace({}, "t-f")] }));
    });
    expect(rendersA).toBe(1);
    expect(rendersB).toBe(2);
  });

  it("removes a space and a thread record, and follows the order", () => {
    applyLayoutEvent(snapshot(layout(4)));
    applyLayoutEvent(delta(5, { removedSpaceIds: ["sp-b"], spaceOrder: ["sp-a"], removedThreadIds: ["th-c"] }));
    const s = state();
    expect(s.spaceOrder).toEqual(["sp-a"]);
    expect(s.panes["p-c"]).toBeUndefined();
    expect(s.tabs["t-c"]).toBeUndefined();
    expect(s.trees["sp-b"]).toBeUndefined();
    expect(s.threads["th-c"]).toBeUndefined();
  });

  it("skips a delta at or below its rev: it was in the snapshot", () => {
    applyLayoutEvent(snapshot(layout(4)));
    const before = state();
    applyLayoutEvent(delta(4, { spaces: [mainSpace({ name: "Old" })] }));
    applyLayoutEvent(delta(3, { spaces: [mainSpace({ name: "Older" })] }));
    expect(state()).toBe(before);
    expect(getLayout).not.toHaveBeenCalled();
  });

  it("reads the whole layout again after a gap, then applies the deltas that came after it", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    let answer: (l: LayoutView) => void = () => undefined;
    getLayout.mockReturnValue(new Promise((r) => (answer = r)));
    // 5 and 6 were missed.
    applyLayoutEvent(delta(7, { spaces: [mainSpace({ name: "Seven" })] }));
    expect(getLayout).toHaveBeenCalledTimes(1);
    // While the Get runs, deltas wait.
    applyLayoutEvent(delta(8, { spaces: [mainSpace({ name: "Eight" })] }));
    expect(state().rev).toBe(4);
    await act(async () => {
      answer(layout(7, [mainSpace({ name: "Seven" }), review]));
      await Promise.resolve();
    });
    expect(state().rev).toBe(8);
    expect(state().spaces["sp-a"]?.name).toBe("Eight");
    expect(getLayout).toHaveBeenCalledTimes(1);
  });

  it("a snapshot that arrives while a Get runs wins: the older Get never lands on it, and later deltas apply", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    let answer: (l: LayoutView) => void = () => undefined;
    getLayout.mockReturnValue(new Promise((r) => (answer = r)));
    applyLayoutEvent(delta(7, { spaces: [mainSpace({ name: "Seven" })] }));
    expect(getLayout).toHaveBeenCalledTimes(1);
    // A reconnect: the stream's snapshot is newer than what the Get will answer.
    applyLayoutEvent(snapshot(layout(10, [mainSpace({ name: "Ten" }), review])));
    expect(state().rev).toBe(10);
    // The next delta is not held behind the Get.
    applyLayoutEvent(delta(11, { spaces: [mainSpace({ name: "Eleven" })] }));
    expect(state().rev).toBe(11);
    await act(async () => {
      answer(layout(7, [mainSpace({ name: "Seven" }), review]));
      await Promise.resolve();
    });
    expect(state().rev).toBe(11);
    expect(state().spaces["sp-a"]?.name).toBe("Eleven");
  });

  it("a Get never takes the slice back to an older revision", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    let answer: (l: LayoutView) => void = () => undefined;
    getLayout.mockReturnValue(new Promise((r) => (answer = r)));
    applyLayoutEvent(delta(7, { spaces: [mainSpace({ name: "Seven" })] }));
    // The first-load import's answer moved the slice on meanwhile (applyImportedLayout's path).
    const { applyImportedLayout } = await import("./layout");
    applyImportedLayout(layout(9, [mainSpace({ name: "Nine" }), review]));
    await act(async () => {
      answer(layout(6, [mainSpace({ name: "Six" }), review]));
      await Promise.resolve();
    });
    expect(state().rev).toBeGreaterThanOrEqual(9);
    expect(state().spaces["sp-a"]?.name).not.toBe("Six");
  });

  it("replaces everything on a snapshot, even at a lower rev (a daemon that restarted)", () => {
    applyLayoutEvent(snapshot(layout(9)));
    applyLayoutEvent(snapshot(layout(2, [review])));
    expect(state().rev).toBe(2);
    expect(state().spaceOrder).toEqual(["sp-b"]);
    expect(state().panes["p-a"]).toBeUndefined();
  });

  it("maps a space onto the geometry's tree", () => {
    applyLayoutEvent(snapshot(layout(4)));
    expect(geoTree(state(), "sp-a")).toEqual({
      t: "split",
      id: "s-r",
      dir: "row",
      kids: [
        { t: "pane", id: "p-a", tabs: [{ id: "t-a", kind: "thread", thread: "th-a" }], active: "t-a" },
        {
          t: "pane",
          id: "p-b",
          tabs: [
            { id: "t-d", kind: "diff", thread: "th-a" },
            { id: "t-f", kind: "file", thread: "th-a" },
          ],
          active: "t-d",
        },
      ],
      sizes: [0.6, 0.4],
    });
    expect(geoTree(state(), "sp-none")).toBeNull();
  });
});

describe("optimistic focus", () => {
  const applied = (rev: number): LayoutApplyView => ({ rev, spaceId: "", paneId: "", tabId: "", existing: false, closed: [], rule: "", kept: [], ended: [], backTabIds: [], placedTabIds: [], freshTabIds: [], swappedPaneIds: [], draftId: "" });

  it("focuses a tab at once, in another space too, before the daemon answers", () => {
    applyLayoutEvent(snapshot(layout(4)));
    applyLayoutOp.mockReturnValue(new Promise(() => undefined));
    void focusTab("t-c");
    const s = state();
    expect(s.currentSpaceId).toBe("sp-b");
    expect(s.spaces["sp-b"]?.mru[0]).toBe("t-c");
    expect(applyLayoutOp).toHaveBeenCalledWith({ op: "focus_tab", tab: "t-c" });
    void focusTab("t-f");
    expect(state().currentSpaceId).toBe("sp-a");
    expect(state().panes["p-b"]?.active).toBe("t-f");
    expect(state().spaces["sp-a"]).toMatchObject({ focus: "p-b", mru: ["t-f", "t-a", "t-d"] });
  });

  it("keeps the focus over a commit that came before its own, then takes the daemon's word", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    applyLayoutOp.mockResolvedValue(applied(6));
    await focusPane("p-b");
    expect(state().spaces["sp-a"]?.focus).toBe("p-b");
    // Rev 5 is someone else's change from before the focus: the focus stays on top.
    applyLayoutEvent(delta(5, { spaces: [mainSpace({ name: "Renamed" })] }));
    expect(state().spaces["sp-a"]).toMatchObject({ name: "Renamed", focus: "p-b" });
    // Rev 6 is the focus as the daemon made it: smart swap also switched p-b to t-f.
    applyLayoutEvent(delta(6, { spaces: [mainSpace({ name: "Renamed", focus: "p-b", mru: ["t-f", "t-a", "t-d"] }, "t-f")] }));
    expect(state().spaces["sp-a"]?.focus).toBe("p-b");
    expect(state().panes["p-b"]?.active).toBe("t-f");
    // The pending focus is gone: the next commit from elsewhere decides.
    applyLayoutEvent(delta(7, { spaces: [mainSpace({ name: "Renamed", focus: "p-a" }, "t-f")] }));
    expect(state().spaces["sp-a"]?.focus).toBe("p-a");
  });

  it("is corrected when the daemon's commit differs", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    applyLayoutOp.mockResolvedValue(applied(5));
    await focusTab("t-f");
    expect(state().panes["p-b"]?.active).toBe("t-f");
    // Another window closed t-f first; the daemon focused t-d instead.
    applyLayoutEvent(delta(5, { spaces: [mainSpace({ root: { t: "split", id: "s-r", dir: "row", kids: [pane("p-a", [tab("t-a", "thread", "th-a")]), pane("p-b", [tab("t-d", "diff", "th-a")])], sizes: [0.6, 0.4] }, focus: "p-b", mru: ["t-d", "t-a"] })] }));
    expect(state().panes["p-b"]).toEqual({ id: "p-b", spaceId: "sp-a", tabIds: ["t-d"], active: "t-d" });
    expect(state().tabs["t-f"]).toBeUndefined();
  });

  it("goes back to what the daemon holds when it refuses", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    const before = state();
    applyLayoutOp.mockRejectedValue(new Error("not found"));
    const ok = await focusTab("t-f");
    expect(ok).toBe(false);
    // Back to what the daemon holds; what the focus never touched kept its objects throughout.
    expect(state().panes["p-b"]).toEqual(before.panes["p-b"]);
    expect(state().spaces["sp-a"]).toEqual(before.spaces["sp-a"]);
    expect(state().panes["p-a"]).toBe(before.panes["p-a"]);
    expect(state().tabs).toBe(before.tabs);
    expect(state().currentSpaceId).toBe("sp-a");
  });

  it("drops a focus the daemon found already made (it answers the current rev)", async () => {
    applyLayoutEvent(snapshot(layout(4)));
    applyLayoutOp.mockResolvedValue(applied(4));
    await focusPane("p-a");
    // Another window moves the focus: nothing of ours stays on top.
    applyLayoutEvent(delta(5, { spaces: [mainSpace({ focus: "p-b" })] }));
    expect(state().spaces["sp-a"]?.focus).toBe("p-b");
  });
});
