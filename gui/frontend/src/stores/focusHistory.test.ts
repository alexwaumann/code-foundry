import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNodeView } from "@/api/layout";
import type { FocusHistoryState } from "./focusHistory";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// The verbs a step runs; focus_tab is applied at once by the slice (optimistic), as the real call does.
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { canStepFocus, FOCUS_HISTORY_MAX, liveEntry, pushEntry, resetFocusHistory, startFocusHistory, stepFocus, stepIndex, useFocusHistoryStore } = await import("./focusHistory");
const { resetLayout, useLayoutStore } = await import("./layout");
const { useShellViewStore, resetShellView } = await import("./shellView");

/** Two spaces: Main with two panes (a thread and a diff), Review with one pane of two tabs. */
const LAYOUT = layoutOf([
  space(row("s-r", [pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-b", "thread", "s-2")]), pane("p-2", [tab("t-d", "diff", "s-1")])]), "p-1", { id: "sp-a", name: "Main" }),
  space(pane("p-9", [tab("t-x", "prs"), tab("t-y", "projects")]), "p-9", { id: "sp-b", name: "Review" }),
]);

const runs: { name: string; args: Record<string, string> }[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Moves the layout's focus as the daemon's commit would (its event): to a tab, switching to its space. */
async function focus(tabId: string, rev: number): Promise<void> {
  let cur = useLayoutStore.getState().currentSpaceId;
  const visit = (n: LayoutNodeView | null): { node: LayoutNodeView | null; pane: string } => {
    if (!n) return { node: n, pane: "" };
    if (n.t === "pane") return n.tabs.some((t) => t.id === tabId) ? { node: { ...n, active: tabId }, pane: n.id } : { node: n, pane: "" };
    let pane = "";
    const kids = n.kids.map((k) => {
      const r = visit(k);
      pane ||= r.pane;
      return r.node ?? k;
    });
    return { node: { ...n, kids }, pane };
  };
  LAYOUT.spaces = LAYOUT.spaces.map((sp) => {
    const r = visit(sp.root);
    if (!r.pane) return sp;
    cur = sp.id;
    return { ...sp, root: r.node, focus: r.pane };
  });
  await seedLayout({ ...LAYOUT, rev, currentSpaceId: cur });
  await flush();
}

let stop: () => void = () => undefined;

beforeEach(async () => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: JSON.stringify({ rev: 999, changed: true }) });
  });
  resetLayout();
  resetFocusHistory();
  resetShellView();
  LAYOUT.spaces = layoutOf([
    space(row("s-r", [pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-b", "thread", "s-2")]), pane("p-2", [tab("t-d", "diff", "s-1")])]), "p-1", { id: "sp-a", name: "Main" }),
    space(pane("p-9", [tab("t-x", "prs"), tab("t-y", "projects")]), "p-9", { id: "sp-b", name: "Review" }),
  ]).spaces;
  LAYOUT.currentSpaceId = "sp-a";
  await seedLayout(LAYOUT);
  stop = startFocusHistory();
});

afterEach(() => {
  stop();
  vi.clearAllMocks();
  resetLayout();
});

const tabsOf = () => useFocusHistoryStore.getState().entries.map((e) => e.tab);

describe("pushEntry", () => {
  const e = (tab: string) => ({ space: "sp-a", pane: "p-1", tab });

  it("appends a new focus and drops what was after the current entry", () => {
    let h: FocusHistoryState = { entries: [e("a"), e("b"), e("c")], index: 1 };
    h = pushEntry(h, e("d"));
    expect(h.entries.map((x) => x.tab)).toEqual(["a", "b", "d"]);
    expect(h.index).toBe(2);
  });

  it("does not push the current entry again", () => {
    const h = { entries: [e("a")], index: 0 };
    expect(pushEntry(h, e("a"))).toBe(h);
  });

  it("keeps at most FOCUS_HISTORY_MAX entries, dropping the oldest", () => {
    let h: FocusHistoryState = { entries: [], index: -1 };
    for (let i = 0; i < FOCUS_HISTORY_MAX + 5; i++) h = pushEntry(h, e(String(i)));
    expect(h.entries).toHaveLength(FOCUS_HISTORY_MAX);
    expect(h.entries[0]?.tab).toBe("5");
    expect(h.index).toBe(FOCUS_HISTORY_MAX - 1);
  });
});

describe("recording", () => {
  it("records the focus at the start, then each focus change and space switch, once each", async () => {
    expect(tabsOf()).toEqual(["t-a"]);
    await focus("t-d", 2);
    await focus("t-d", 3); // the same focus confirmed again: nothing new
    await focus("t-x", 4); // another space
    expect(tabsOf()).toEqual(["t-a", "t-d", "t-x"]);
    expect(useFocusHistoryStore.getState().entries.map((e) => e.space)).toEqual(["sp-a", "sp-a", "sp-b"]);
  });

  it("records a space with no pane as the space alone", async () => {
    await seedLayout({ ...LAYOUT, rev: 2, spaces: [...LAYOUT.spaces, space(null, "", { id: "sp-c", name: "Empty" })], currentSpaceId: "sp-c" });
    await flush();
    expect(useFocusHistoryStore.getState().entries.at(-1)).toEqual({ space: "sp-c", pane: "", tab: "" });
  });
});

describe("back and forward", () => {
  it("go back across panes and spaces, then forward again, switching space by focusing the tab", async () => {
    await focus("t-d", 2);
    await focus("t-x", 3);
    expect(canStepFocus(useFocusHistoryStore.getState(), useLayoutStore.getState(), 1)).toBe(false);

    await stepFocus(-1);
    // tab.focus switches the space: the slice applies it at once.
    expect(runs.at(-1)).toEqual({ name: "tab.focus", args: { tab: "t-d", focus: "true" } });
    expect(useLayoutStore.getState().currentSpaceId).toBe("sp-a");
    expect(useShellViewStore.getState().focusRequest.paneId).toBe("p-2");
    await flush();
    // The step's own focus is the current entry: nothing was pushed, forward is still there.
    expect(tabsOf()).toEqual(["t-a", "t-d", "t-x"]);
    expect(useFocusHistoryStore.getState().index).toBe(1);

    await stepFocus(1);
    expect(runs.at(-1)).toEqual({ name: "tab.focus", args: { tab: "t-x", focus: "true" } });
    expect(useLayoutStore.getState().currentSpaceId).toBe("sp-b");
  });

  it("skips entries whose tab is gone, and finds a moved tab where it is now", async () => {
    await focus("t-d", 2);
    await focus("t-x", 3);
    // t-d closes and t-a moves to Review's pane.
    LAYOUT.spaces = [
      space(pane("p-1", [tab("t-b", "thread", "s-2")]), "p-1", { id: "sp-a", name: "Main" }),
      space(pane("p-9", [tab("t-x", "prs"), tab("t-y", "projects"), tab("t-a", "thread", "s-1")]), "p-9", { id: "sp-b", name: "Review" }),
    ];
    await seedLayout({ ...LAYOUT, rev: 4, currentSpaceId: "sp-b" });
    await flush();
    const s = useLayoutStore.getState();
    const h = useFocusHistoryStore.getState();
    expect(liveEntry(h.entries[1] ?? { space: "", pane: "", tab: "" }, s)).toBeNull();
    expect(liveEntry(h.entries[0] ?? { space: "", pane: "", tab: "" }, s)).toEqual({ space: "sp-b", pane: "p-9", tab: "t-a" });
    expect(stepIndex(h, s, -1)).toBe(0);
    await stepFocus(-1);
    expect(runs.at(-1)).toEqual({ name: "tab.focus", args: { tab: "t-a", focus: "true" } });
  });

  it("skips an entry that shows what is focused now, and goes nowhere at the ends", async () => {
    await focus("t-d", 2);
    await focus("t-a", 3); // back where it started: [t-a, t-d, t-a]
    const h = useFocusHistoryStore.getState();
    expect(stepIndex(h, useLayoutStore.getState(), -1)).toBe(1);
    // Close t-d: the only earlier entry left is t-a, which is focused, so back goes nowhere.
    LAYOUT.spaces = [space(pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-b", "thread", "s-2")]), "p-1", { id: "sp-a", name: "Main" }), LAYOUT.spaces[1] ?? space(null, "")];
    await seedLayout({ ...LAYOUT, rev: 4, currentSpaceId: "sp-a" });
    await flush();
    expect(canStepFocus(useFocusHistoryStore.getState(), useLayoutStore.getState(), -1)).toBe(false);
    expect(await stepFocus(-1)).toBe(false);
    expect(runs).toEqual([]);
  });

  it("switches to a space recorded without a tab with space.switch", async () => {
    LAYOUT.spaces = [...LAYOUT.spaces, space(null, "", { id: "sp-c", name: "Empty" })];
    await seedLayout({ ...LAYOUT, rev: 2, currentSpaceId: "sp-c" });
    await flush();
    await focus("t-x", 3);
    await stepFocus(-1);
    expect(runs.at(-1)).toEqual({ name: "space.switch", args: { space: "sp-c", focus: "true" } });
  });
});
