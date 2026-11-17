import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";
import type { StatusLineKind } from "@/lib/statusLine";

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
  runLayoutCommand: (name: string, args: Record<string, string>) => {
    calls.push([name, args.tab ?? ""]);
    return Promise.resolve({ rev: 2, changed: true });
  },
}));

const { PaneTabStrip } = await import("./PaneTabStrip");
const { tooltipText } = await import("@/test/tooltip");
const { useTabCut } = await import("@/shell/tabCut");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { statusRegistry } = await import("@/lib/statusRegistry");

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

  it.each([
    { name: "idle", thread: { status: "idle" }, kind: null, tone: null },
    { name: "working", thread: { status: "busy" }, kind: "working", tone: "bg-cf-info" },
    { name: "a permission ask", thread: { status: "attention", statusReason: "permission: Bash" }, kind: "input", tone: "bg-cf-warning" },
    { name: "done", thread: { status: "attention", statusReason: "finished" }, kind: "finished", tone: "bg-cf-success" },
    { name: "an error", thread: { status: "error" }, kind: "error", tone: "bg-cf-error" },
    { name: "archived while asking", thread: { status: "attention", statusReason: "permission: Bash", archivedAtMs: 1 }, kind: null, tone: null },
  ])("a thread's tab icon carries its status's dot, active or not: $name", ({ thread, kind, tone }) => {
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree", statusReason: "", archivedAtMs: null, ...thread } } as never });
    });
    render(<PaneTabStrip paneId="p-1" focused />);
    const dots = tabs().map((t) => t.querySelector('[data-testid="shell-tab-status"]'));
    // Only the thread's own tab, not its diff; the thread's tab is not the active one here.
    expect(dots.slice(1).every((d) => d === null)).toBe(true);
    const dot = dots[0] ?? null;
    if (kind === null) {
      expect(dot).toBeNull();
      return;
    }
    expect(dot?.getAttribute("data-kind")).toBe(kind);
    expect(dot?.classList.contains(tone)).toBe(true);
    expect(dot?.getAttribute("aria-label")).toBe(statusRegistry[kind as StatusLineKind].word);
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

describe("a thread's name that is not final yet (provisional, or being regenerated)", () => {
  const labelOf = (id: string) => {
    const el = tabs()
      .find((t) => t.getAttribute("data-tab-id") === id)
      ?.querySelector<HTMLElement>('[data-testid="shell-tab-label"]');
    if (!el) throw new Error(id);
    return el;
  };
  const isQuiet = (el: HTMLElement) => el.hasAttribute("data-provisional") && el.classList.contains("italic") && el.classList.contains("text-cf-text-muted");
  const setThread = (o: { naming?: boolean; nameProvisional?: boolean }) => {
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree", naming: false, nameProvisional: false, ...o } } as never });
    });
  };

  it.each([
    ["being regenerated", { naming: true }],
    ["provisional", { nameProvisional: true }],
  ])("%s: the thread's tab shows its name muted and italic, as the sidebar's row", (_name, o) => {
    render(<PaneTabStrip paneId="p-1" focused />);
    setThread(o);
    expect(labelOf("t-th").textContent).toBe("Refactor sidebar tree");
    expect(isQuiet(labelOf("t-th"))).toBe(true);
  });

  it("goes back to the tab's own colour once the name lands", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    setThread({ naming: true });
    expect(isQuiet(labelOf("t-th"))).toBe(true);
    setThread({ naming: false });
    expect(labelOf("t-th").hasAttribute("data-provisional")).toBe(false);
    expect(labelOf("t-th").className).not.toMatch(/italic|text-cf-text-muted/);
  });

  it("leaves a linked tab (its title is not the thread's name) and the other tabs as they are", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    setThread({ naming: true, nameProvisional: true });
    for (const id of ["t-d", "t-prs", "t-c"]) {
      expect(labelOf(id).hasAttribute("data-provisional")).toBe(false);
      expect(labelOf(id).className).not.toMatch(/italic/);
    }
  });
});

describe("a preview tab (docs/notes/shell-model.md, \"Preview tabs\")", () => {
  const withPreview = (active: string) =>
    layoutOf([space(pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-pv", "thread", "s-2", { preview: true })], active), "p-1")]);
  const tabOf = (id: string) => tabs().find((t) => t.getAttribute("data-tab-id") === id) as HTMLElement;
  const dashed = (el: HTMLElement) => el.className.split(" ").includes("after:border-dashed");

  beforeEach(async () => {
    useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Sizes" }, "s-2": { id: "s-2", name: "Reviewer", archivedAtMs: 1 } } as never });
    await seedLayout(withPreview("t-pv"));
  });

  it.each([
    ["shown in the focused pane", "t-pv", true, "bg-cf-control-hover"],
    ["shown in a pane without the focus", "t-pv", false, "bg-cf-control-hover/40"],
    ["behind another tab", "t-a", true, "text-cf-text-muted"],
  ])("%s: dashed in a quiet neutral, with that state's usual fill", async (_name, active, focused, fill) => {
    await seedLayout(withPreview(active));
    render(<PaneTabStrip paneId="p-1" focused={focused} />);
    const pv = tabOf("t-pv");
    expect(pv.hasAttribute("data-preview")).toBe(true);
    expect(dashed(pv)).toBe(true);
    expect(pv.className.split(" ")).toEqual(expect.arrayContaining(["after:border-cf-text-muted/60", "after:rounded-md", "after:inset-0", fill]));
    // Upright, no accent.
    expect(pv.className).not.toMatch(/italic|accent/);
    expect(tabOf("t-a").hasAttribute("data-preview")).toBe(false);
    expect(dashed(tabOf("t-a"))).toBe(false);
  });

  it("shows the ordinary thread icon and the name, and says it is a preview to a screen reader only", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    const [kept, pv] = screen.getAllByRole("tab");
    if (!kept || !pv) throw new Error("tabs");
    expect(pv.querySelector("svg")?.getAttribute("class")).toBe(kept.querySelector("svg")?.getAttribute("class"));
    expect(pv.textContent).toBe("Reviewer, preview");
    expect(pv.querySelector(".sr-only")?.textContent).toBe(", preview");
    expect(kept.textContent).toBe("Sizes");
    // The measuring copy is the plain tab: the dashes and the words take no room.
    const measure = screen.getByTestId("shell-tab-measure");
    expect(measure.textContent).toBe("SizesReviewer");
  });

  it("a double click keeps a preview (tab.keep, once); a kept tab's double click does nothing", () => {
    render(<PaneTabStrip paneId="p-1" focused />);
    fireEvent.doubleClick(tabOf("t-a"));
    expect(calls).toEqual([]);
    fireEvent.doubleClick(tabOf("t-pv").querySelector('[data-testid="shell-tab-label"]') as HTMLElement);
    expect(calls).toEqual([["tab.keep", "t-pv"]]);
  });

  it("reading keeps nothing: a click on it, its keyboard focus", () => {
    render(<PaneTabStrip paneId="p-1" focused={false} />);
    const pv = screen.getAllByRole("tab")[1];
    if (!pv) throw new Error("tab");
    pv.focus();
    fireEvent.click(pv);
    expect(calls).toEqual([["tab.focus", "t-pv"]]);
  });
});
