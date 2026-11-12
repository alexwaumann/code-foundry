import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { expandPanel, movePanelTabToGroup, splitPanel, startPanelPicking, togglePanel, usePanelStore } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import {
  findTab,
  groupOfTab,
  makeTab,
  openTab,
  retitleTab,
  setTabParams,
  shownTab,
  subscribeTabs,
  tabPlace,
  targetOf,
  threadOfTarget,
  threadTarget,
  useTabPlace,
  type TabPlaces,
} from "./host";

// The classic half: each operation is the side panel's, so this pins only what the seam adds
// (the place read model, its identity, the subscription and the params function).

const T = threadTarget("t1");
const a = makeTab("file", "a.ts", { path: "/a.ts" });
const b = makeTab("file", "b.ts", { path: "/b.ts" });

beforeEach(() => {
  usePanelStore.setState({ byKey: {} });
  useUiStore.setState({ selection: { kind: "thread", id: "t1" } });
});

describe("targets", () => {
  it("are the side panel's keys", () => {
    expect(T).toBe("thread:t1");
    expect(targetOf({ kind: "thread", id: "t1" })).toBe(T);
    expect(targetOf({ kind: "none" })).toBeNull();
    expect(threadOfTarget("current")).toBe("t1");
    expect(threadOfTarget("view:projects")).toBe("");
  });
});

describe("tabPlace", () => {
  it("is empty and hidden for a target without tabs", () => {
    expect(tabPlace(T)).toMatchObject({ shown: false, expanded: false, tabs: [], focused: 0 });
    expect(shownTab(tabPlace(T))).toBeNull();
  });

  it("names the tabs, each group's shown tab and the focused group", () => {
    openTab(T, a);
    openTab(T, b);
    splitPanel(T);
    movePanelTabToGroup(T, b.id, 1);
    const p = tabPlace("current");
    expect(p.shown).toBe(true);
    expect(p.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(p.groups.map((g) => g.active?.id)).toEqual([a.id, b.id]);
    expect(p.focused).toBe(1);
    expect(shownTab(p)?.id).toBe(b.id);
    expect(groupOfTab(p, a.id)).toBe(0);
    expect(groupOfTab(p, "nope")).toBeNull();
    expect(findTab(T, b.id)?.title).toBe("b.ts");
  });

  it("shows no tab in a group that is picking", () => {
    openTab(T, a);
    startPanelPicking(T, { focus: false });
    expect(tabPlace(T).groups[0]?.active).toBeNull();
  });

  it("says when the tabs fill the content area", () => {
    openTab(T, a);
    expandPanel(T, true);
    expect(tabPlace(T).expanded).toBe(true);
  });

  it("keeps its identity until the target's tabs change", () => {
    openTab(T, a);
    const before = tabPlace(T);
    openTab("thread:other", b);
    expect(tabPlace(T)).toBe(before);
    openTab(T, b);
    expect(tabPlace(T)).not.toBe(before);
  });
});

describe("setTabParams", () => {
  it("takes params or a function of the old ones, and changes nothing for an unknown tab", () => {
    openTab(T, a);
    setTabParams(T, a.id, (p) => ({ ...p, line: "4" }));
    expect(findTab(T, a.id)?.params).toEqual({ path: "/a.ts", line: "4" });
    setTabParams(T, a.id, { path: "/a.ts" });
    expect(findTab(T, a.id)?.params).toEqual({ path: "/a.ts" });
    const before = usePanelStore.getState().byKey;
    setTabParams(T, "nope", () => ({ x: "1" }));
    setTabParams(T, a.id, (p) => ({ ...p }));
    expect(usePanelStore.getState().byKey).toBe(before);
  });
});

describe("subscribeTabs", () => {
  it("is called with the places now and before when tabs change", () => {
    const calls: [TabPlaces, TabPlaces][] = [];
    const stop = subscribeTabs((now, prev) => calls.push([now, prev]));
    openTab(T, a);
    togglePanel(T, false);
    stop();
    openTab(T, b);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0][T]?.tabs.map((t) => t.id)).toEqual([a.id]);
    expect(calls[0]?.[1][T]).toBeUndefined();
    expect(calls[1]?.[0][T]?.shown).toBe(false);
    // The same entry is the same place in both.
    expect(calls[1]?.[1][T]?.tabs).toBe(calls[1]?.[0][T]?.tabs);
  });

  it("is not called when nothing changed", () => {
    openTab(T, a);
    let n = 0;
    const stop = subscribeTabs(() => n++);
    retitleTab(T, a.id, a.title);
    retitleTab(T, "nope", "x");
    stop();
    expect(n).toBe(0);
  });
});

describe("useTabPlace", () => {
  it("re-renders only when the selection from the place changes", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useTabPlace(T, (p) => p.tabs.length);
    });
    expect(result.current).toBe(0);
    act(() => {
      openTab("thread:other", a);
    });
    expect(renders).toBe(1);
    act(() => {
      openTab(T, a);
    });
    expect(result.current).toBe(1);
    expect(renders).toBe(2);
  });
});
