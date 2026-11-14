import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const calls: [string, string][] = [];
vi.mock("@/shell/commands", () => ({
  closeTabNow: (id: string) => {
    calls.push(["tab.close", id]);
    return Promise.resolve(null);
  },
  focusTabNow: (id: string) => {
    calls.push(["tab.focus", id]);
    return Promise.resolve(true);
  },
  focusPaneNow: () => Promise.resolve(true),
}));

const { PaneTabStrip } = await import("./PaneTabStrip");
const { tooltipText } = await import("@/test/tooltip");
const { useTabCut } = await import("@/shell/tabCut");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");

const strip = layoutOf([
  space(
    pane("p-1", [tab("t-th", "thread", "s-1", { title: "Old name" }), tab("t-d", "diff", "s-1", { title: "main vs working" }), tab("t-prs", "prs"), tab("t-c", "compose")], "t-d"),
    "p-1",
  ),
]);

const tabs = () => screen.getAllByTestId("shell-tab");

beforeEach(async () => {
  calls.length = 0;
  resetLayout();
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree" } } as never });
  await seedLayout(strip);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetLayout();
});

describe("PaneTabStrip", () => {
  it("draws the pane's tabs in order, each named by its surface, the active one selected", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(tabs().map((t) => t.getAttribute("data-tab-id"))).toEqual(["t-th", "t-d", "t-prs", "t-c"]);
    // A thread's tab is the thread's current name, not the layout's stored title.
    expect(tabs().map((t) => t.querySelector('[data-testid="shell-tab-label"]')?.textContent)).toEqual(["Refactor sidebar tree", "main vs working", "Pull Requests", "New thread"]);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(tabs()[1]?.hasAttribute("data-active")).toBe(true);
  });

  it("renames a thread's tab when the thread is renamed", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Virtualize the sidebar" } } as never });
    });
    expect(tabs()[0]?.textContent).toContain("Virtualize the sidebar");
  });

  it("a click focuses a tab (tab.focus); the active tab of the focused pane asks nothing", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    const [thread, diff] = screen.getAllByRole("tab");
    if (!thread || !diff) throw new Error("tabs");
    fireEvent.click(diff);
    expect(calls).toEqual([]);
    fireEvent.click(thread);
    expect(calls).toEqual([["tab.focus", "t-th"]]);
  });

  it("the active tab of a pane without the focus focuses on a click", () => {
    render(<PaneTabStrip paneId="p-1" focused={false} />);
    const diff = screen.getAllByRole("tab")[1];
    if (!diff) throw new Error("tab");
    fireEvent.click(diff);
    expect(calls).toEqual([["tab.focus", "t-d"]]);
  });

  it("the × and a middle click close a tab (tab.close), once its surface agreed (shell/closeTab.ts)", async () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    fireEvent.click(screen.getByRole("button", { name: "Close Pull Requests" }));
    const thread = tabs()[0];
    if (!thread) throw new Error("tab");
    fireEvent(thread, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await vi.waitFor(() => {
      expect(calls).toEqual([
        ["tab.close", "t-prs"],
        ["tab.close", "t-th"],
      ]);
    });
  });

  /** Every tab is 150px by nature; the strip is `width` wide (its padding, gaps, the "+", the collapse and the full screen buttons take 110px of it). */
  function stripOf(width: number): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.getAttribute("data-testid") === "shell-tab-strip") return new DOMRect(0, 0, width, 44);
      if (this.hasAttribute("data-measure-tab")) return new DOMRect(0, 0, 150, 28);
      return new DOMRect(0, 0, 0, 0);
    });
  }

  it("fits tabs to the strip: the active tab keeps its whole name, the others shorten", () => {
    stripOf(530);
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(tabs().map((t) => t.getAttribute("data-label"))).toEqual(["short", "full", "short", "short"]);
  });

  it("tight, tabs go icon-only, the farthest from the active tab first, with no × and the name kept for a screen reader", () => {
    stripOf(332);
    render(<PaneTabStrip paneId="p-1" focused />);
    const labels = tabs().map((t) => t.getAttribute("data-label"));
    expect(labels[3]).toBe("icon");
    expect(labels[1]).not.toBe("icon");
    expect(tabs()[3]?.querySelector('[data-testid="shell-tab-close"]')).toBeNull();
    expect(tabs()[3]?.querySelector(".sr-only")?.textContent).toBe("New thread");
  });

  it("with room for every tab, all show whole", () => {
    stripOf(1000);
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(tabs().map((t) => t.getAttribute("data-label"))).toEqual(["full", "full", "full", "full"]);
  });

  it("marks a thread's tab icon with the attention dot while its thread needs the user, active or not, never when archived", () => {
    const attention = (o: object = {}) => {
      act(() => {
        useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree", status: "attention", archivedAtMs: null, flags: [], ...o } } as never });
      });
    };
    render(<PaneTabStrip paneId="p-1" focused />);
    const dots = () => tabs().map((t) => t.querySelector('[data-testid="shell-tab-attention"]') !== null);
    expect(dots()).toEqual([false, false, false, false]);
    attention();
    // Only the thread's own tab, not its diff; the thread's tab is not the active one here.
    expect(dots()).toEqual([true, false, false, false]);
    expect(tabs()[0]?.querySelector('[data-testid="shell-tab-attention"]')?.getAttribute("aria-label")).toBe("Needs you");
    attention({ archivedAtMs: 1 });
    expect(dots()).toEqual([false, false, false, false]);
  });

  it("a linked tab's hover names its thread; another tab's only a cut name", () => {
    stripOf(1000);
    render(<PaneTabStrip paneId="p-1" focused />);
    const [thread, diff] = screen.getAllByRole("tab");
    if (!thread || !diff) throw new Error("tabs");
    expect(tooltipText(diff)).toBe("Diff of Refactor sidebar tree");
    expect(tooltipText(thread)).toBeNull();
  });

  it("tells the header whether the active tab's name is cut", () => {
    const cut = () => useTabCut.getState().cut["p-1"] ?? false;
    stripOf(1000);
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(cut()).toBe(false);
    cleanup();
    stripOf(250);
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(cut()).toBe(true);
    // A strip that goes forgets its pane.
    cleanup();
    expect("p-1" in useTabCut.getState().cut).toBe(false);
  });
});
