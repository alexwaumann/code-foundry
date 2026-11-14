import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";
import { tooltipText } from "@/test/tooltip";

// Bodies as markers: which pane mounts one is the question.
vi.mock("@/components/thread/ThreadPane", () => ({ ThreadPane: ({ threadId }: { threadId: string }) => <div data-testid="body" data-body={`thread:${threadId}`} /> }));
vi.mock("@/components/prs/PullRequestsPage", () => ({ PullRequestsPage: () => <div data-testid="body" data-body="prs" /> }));
vi.mock("@/components/diff/DiffView", () => ({ DiffView: ({ tabId }: { tabId: string }) => <div data-testid="body" data-body={`diff:${tabId}`} /> }));
vi.mock("@/components/files/FileTab", () => ({ FileTab: () => <div data-testid="body" data-body="file" /> }));
vi.mock("@/shell/viewport", () => ({ reportViewport: () => undefined, resendViewport: () => undefined }));
const focusedTabs: string[] = [];
const focusedPanes: string[] = [];
vi.mock("@/shell/commands", () => ({
  focusPaneNow: (id: string) => {
    focusedPanes.push(id);
    return Promise.resolve(true);
  },
  focusTabNow: (id: string) => {
    focusedTabs.push(id);
    return Promise.resolve(true);
  },
  closeTabNow: () => Promise.resolve(null),
  runLayoutCommand: () => Promise.resolve(null),
  afterRev: () => Promise.resolve(),
}));

const { PaneGrid } = await import("./PaneGrid");
const { resetLayout, useLayoutStore, geoTree } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");
const { foldRails } = await import("@/shell/geometry/rails");
const { enterFullscreen, leaveFullscreen } = await import("@/shell/fullscreen");
const { useThreadsStore } = await import("@/stores/threads");

/**
 * Three panes in a row: s-1's thread (focused), s-1's diff and file (the file active), and s-2's
 * thread behind Pull Requests. Minimums 360 + 260 + 300 and two 12px gutters: 944px wide.
 */
const TREE = row("s-r", [
  pane("p-a", [tab("t-th1", "thread", "s-1")]),
  pane("p-b", [tab("t-d", "diff", "s-1"), tab("t-f", "file", "s-1", { params: { path: "/w/a.go" } })], "t-f"),
  pane("p-c", [tab("t-th2", "thread", "s-2"), tab("t-prs", "prs")], "t-prs"),
]);

let width = 1500;
function sized(w: number): void {
  width = w;
}

async function seed(): Promise<void> {
  await act(async () => {
    await seedLayout(layoutOf([space(TREE, "p-a", { mru: ["t-th1", "t-prs", "t-f"] })]));
  });
}

const rails = () => screen.queryAllByTestId("shell-rail").map((r) => r.getAttribute("data-pane-id"));
const open = () => screen.queryAllByTestId("shell-pane").map((r) => r.getAttribute("data-pane-id"));
const bodies = () => screen.queryAllByTestId("body").map((b) => b.getAttribute("data-body"));
/** What rails.ts folds for the seeded tree at this width. */
const expected = (w: number) => [...foldRails({ root: geoTree(useLayoutStore.getState(), "sp-a"), w, h: 800, focus: "p-a", mru: ["t-th1", "t-prs", "t-f"] })].sort();

beforeEach(() => {
  focusedTabs.length = 0;
  focusedPanes.length = 0;
  resetLayout();
  resetShellView();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.getAttribute("data-testid") === "shell-grid" ? new DOMRect(0, 0, width, 800) : new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetLayout();
  resetShellView();
  useThreadsStore.setState({ byId: {} });
});

describe("rails in the pane grid", () => {
  it.each([
    [1500, []],
    [1100, ["p-b"]],
    [600, ["p-b", "p-c"]],
  ])("at %ipx wide, the panes rails.ts folds are rails (%j) and the rest are open", async (w, want) => {
    sized(w);
    await seed();
    render(<PaneGrid />);
    expect(expected(w)).toEqual(want);
    expect(rails().sort()).toEqual(want);
    expect(open().sort()).toEqual(["p-a", "p-b", "p-c"].filter((p) => !want.includes(p)));
  });

  it("a folded pane mounts no body", async () => {
    sized(600);
    await seed();
    render(<PaneGrid />);
    expect(bodies()).toEqual(["thread:s-1"]);
  });

  it("a rail shows its tabs' icons, the selected one marked, and the attention dot of a thread that needs the user", async () => {
    sized(600);
    await seed();
    act(() => {
      useThreadsStore.setState({ byId: { "s-2": { id: "s-2", name: "Port renderer", status: "attention", archivedAtMs: null, flags: [] } } as never });
    });
    render(<PaneGrid />);
    const rail = screen.getAllByTestId("shell-rail").find((r) => r.getAttribute("data-pane-id") === "p-b");
    if (!rail) throw new Error("rail");
    const icons = within(rail).getAllByTestId("shell-rail-tab");
    expect(icons.map((i) => i.getAttribute("data-tab-id"))).toEqual(["t-d", "t-f"]);
    expect(icons.map((i) => i.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(icons.map((i) => i.hasAttribute("data-active"))).toEqual([false, true]);
    expect(rail.getAttribute("data-orientation")).toBe("vertical");
    const other = screen.getAllByTestId("shell-rail").find((r) => r.getAttribute("data-pane-id") === "p-c");
    if (!other) throw new Error("rail");
    const dots = within(other)
      .getAllByTestId("shell-rail-tab")
      .map((i) => i.querySelector('[data-testid="shell-tab-attention"]') !== null);
    expect(dots).toEqual([true, false]);
  });

  it("a tooltip names a rail's tab, and a linked one its thread", async () => {
    sized(600);
    await seed();
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree", status: "idle", archivedAtMs: null, flags: [] } } as never });
    });
    render(<PaneGrid />);
    const icon = screen.getAllByTestId("shell-rail-tab").find((i) => i.getAttribute("data-tab-id") === "t-d");
    if (!icon) throw new Error("icon");
    const text = tooltipText(icon);
    expect(text).toContain("Diff");
    expect(text).toContain("Refactor sidebar tree");
  });

  it("a click on a rail's icon focuses that tab", async () => {
    sized(600);
    await seed();
    render(<PaneGrid />);
    const icon = screen.getAllByTestId("shell-rail-tab").find((i) => i.getAttribute("data-tab-id") === "t-d");
    if (!icon) throw new Error("icon");
    fireEvent.click(icon);
    expect(focusedTabs).toEqual(["t-d"]);
    expect(useShellViewStore.getState().focusRequest.paneId).toBe("p-b");
  });

  it("a rail's full screen button shows that pane full screen", async () => {
    sized(600);
    await seed();
    render(<PaneGrid />);
    const rail = screen.getAllByTestId("shell-rail").find((r) => r.getAttribute("data-pane-id") === "p-c");
    if (!rail) throw new Error("rail");
    fireEvent.click(within(rail).getByTestId("shell-rail-fullscreen"));
    expect(focusedPanes).toEqual(["p-c"]);
    expect(useShellViewStore.getState().fullscreen).toBe("sp-a");
  });
});

describe("full screen in the pane grid", () => {
  it("draws only the focused pane, over the whole area, with no gutter; the others mount nothing", async () => {
    sized(1500);
    await seed();
    render(<PaneGrid />);
    expect(open()).toHaveLength(3);
    act(() => {
      enterFullscreen();
    });
    expect(open()).toEqual(["p-a"]);
    expect(rails()).toEqual([]);
    const el = screen.getByTestId("shell-pane");
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["0px", "0px", "1500px", "800px"]);
    expect(el.hasAttribute("data-fullscreen")).toBe(true);
    expect(screen.queryAllByTestId("shell-gutter")).toHaveLength(0);
    expect(bodies()).toEqual(["thread:s-1"]);
    // Its strip's exit control leaves.
    fireEvent.click(screen.getByTestId("shell-fullscreen-exit"));
    expect(open()).toHaveLength(3);
  });

  it("a small window folds nothing in full screen", async () => {
    sized(600);
    await seed();
    render(<PaneGrid />);
    act(() => {
      enterFullscreen();
    });
    expect([open(), rails()]).toEqual([["p-a"], []]);
    act(() => {
      leaveFullscreen();
    });
    expect(rails().sort()).toEqual(["p-b", "p-c"]);
  });

  it("every open pane's strip has a full screen button", async () => {
    sized(1500);
    await seed();
    render(<PaneGrid />);
    expect(screen.getAllByTestId("shell-fullscreen")).toHaveLength(3);
    fireEvent.click(screen.getAllByTestId("shell-fullscreen")[1] as HTMLElement);
    expect(focusedPanes).toEqual(["p-b"]);
  });
});
