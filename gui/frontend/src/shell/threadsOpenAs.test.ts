import { describe, expect, it } from "vitest";
import { besidePane, headedTab, targetThreadPane, threadsOpenAsOf } from "./threadsOpenAs";

const tab = (id: string, kind: string, paneId: string, thread = "") => ({ id, kind, paneId, thread, key: id, params: {}, title: "", name: "", preview: false });
const state = {
  spaces: { a: { id: "a", name: "A", focus: "p-d", mru: ["t-d", "t-2", "t-1"], drafts: [] } },
  panes: {
    "p-1": { id: "p-1", spaceId: "a", tabIds: ["t-1"], active: "t-1" },
    "p-2": { id: "p-2", spaceId: "a", tabIds: ["t-2"], active: "t-2" },
    "p-d": { id: "p-d", spaceId: "a", tabIds: ["t-d", "t-c"], active: "t-d" },
  },
  tabs: { "t-1": tab("t-1", "thread", "p-1", "s-1"), "t-2": tab("t-2", "compose", "p-2"), "t-d": tab("t-d", "diff", "p-d", "s-1"), "t-c": tab("t-c", "thread", "p-d", "s-3") },
  threads: {},
  defaultSpaceId: "a",
};

describe("threads open as in the window", () => {
  it("reads unknown values as Tabs", () => {
    expect([undefined, "", "tabs", "panes", "single", "grid"].map(threadsOpenAsOf)).toEqual(["tabs", "tabs", "tabs", "panes", "single", "tabs"]);
  });

  it("a pane of one thread or composer is headed under Panes and Single only", () => {
    expect(["p-1", "p-2", "p-d"].map((p) => headedTab(state, p, "panes"))).toEqual(["t-1", "t-2", ""]);
    expect(headedTab(state, "p-1", "single")).toBe("t-1");
    expect(headedTab(state, "p-1", "tabs")).toBe("");
  });

  it("the target thread pane: the focused one when it holds a thread, else the most recent", () => {
    // p-d holds a thread tab beside its diff (a layout not yet conformed): it counts.
    expect(targetThreadPane(state, "a")).toBe("p-d");
    const noThread = { ...state, tabs: { ...state.tabs, "t-c": tab("t-c", "prs", "p-d") } };
    expect(targetThreadPane(noThread, "a")).toBe("p-2");
    expect(targetThreadPane({ ...noThread, spaces: { a: { ...state.spaces.a, mru: [] } } }, "a")).toBe("p-1");
  });

  it("Open beside names the target, unless the thread is open in the space already", () => {
    const s = { ...state, tabs: { ...state.tabs, "t-c": tab("t-c", "prs", "p-d") } };
    expect(besidePane(s, "s-9")).toBe("p-2");
    expect(besidePane(s, "s-1")).toBe("");
  });
});
