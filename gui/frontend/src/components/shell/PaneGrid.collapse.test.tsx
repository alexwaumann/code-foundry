/**
 * Collapsed panes and dividers in the pane grid (docs/notes/shell-model.md, "Collapsing a pane" and
 * "Dividers"; docs/notes/shell-25d-collapse.md): a collapsed pane is a rail with an open control,
 * the strip's control collapses (not the last open pane), and each divider's cursor says which ways
 * it can still move.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNodeView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";
import { tooltipText } from "@/test/tooltip";

vi.mock("@/components/thread/ThreadPane", () => ({ ThreadPane: ({ threadId }: { threadId: string }) => <div data-testid="body" data-body={`thread:${threadId}`} /> }));
vi.mock("@/components/prs/PullRequestsPage", () => ({ PullRequestsPage: () => <div data-testid="body" data-body="prs" /> }));
vi.mock("@/components/diff/DiffView", () => ({ DiffView: ({ tabId }: { tabId: string }) => <div data-testid="body" data-body={`diff:${tabId}`} /> }));
vi.mock("@/shell/viewport", () => ({ reportViewport: () => undefined, resendViewport: () => undefined }));
const ran: [string, Record<string, string>][] = [];
const focusedTabs: string[] = [];
vi.mock("@/shell/commands", () => ({
  focusPaneNow: () => Promise.resolve(true),
  focusTabNow: (id: string) => {
    focusedTabs.push(id);
    return Promise.resolve(true);
  },
  closeTabNow: () => Promise.resolve(null),
  runLayoutCommand: (name: string, args: Record<string, string> = {}) => {
    ran.push([name, args]);
    return Promise.resolve({ rev: 1, changed: true });
  },
  afterRev: () => Promise.resolve(),
}));

const { PaneGrid } = await import("./PaneGrid");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, requestPaneFocus } = await import("@/stores/shellView");
const { enterFullscreen } = await import("@/shell/fullscreen");
const { useCommandsStore } = await import("@/stores/commands");

const collapsed = (n: LayoutNodeView): LayoutNodeView => ({ ...n, collapsed: true }) as LayoutNodeView;

/** s-1's thread (focused), Pull Requests (collapsed), s-1's diff, in a row. */
const TREE = row("s-r", [pane("p-a", [tab("t-th", "thread", "s-1")]), collapsed(pane("p-b", [tab("t-prs", "prs"), tab("t-d2", "diff", "s-2")])), pane("p-c", [tab("t-d", "diff", "s-1")])]);

async function seed(root: LayoutNodeView = TREE, focus = "p-a"): Promise<void> {
  await act(async () => {
    await seedLayout(layoutOf([space(root, focus, { mru: ["t-th", "t-d"] })]));
  });
}

let width = 1400;
beforeEach(() => {
  ran.length = 0;
  focusedTabs.length = 0;
  width = 1400;
  resetLayout();
  resetShellView();
  useCommandsStore.setState({ commands: [{ name: "pane.collapse", title: "Toggle Collapse Pane", description: "", category: "Layout", args: [], keybindings: ["cmd+shift+m"], available: true }] });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.getAttribute("data-testid") === "shell-grid" ? new DOMRect(0, 0, width, 800) : new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetLayout();
  resetShellView();
  useCommandsStore.setState({ commands: [] });
});

const railOf = (id: string) => screen.getAllByTestId("shell-rail").find((r) => r.getAttribute("data-pane-id") === id);

describe("a collapsed pane in the grid", () => {
  it("is a rail with room to spare: its icons, the selected one marked, and its open control before full screen", async () => {
    await seed();
    render(<PaneGrid />);
    const rail = railOf("p-b");
    if (!rail) throw new Error("rail");
    expect(rail.hasAttribute("data-collapsed")).toBe(true);
    expect(rail.getAttribute("aria-label")).toBe("Collapsed pane");
    expect(within(rail).getAllByTestId("shell-rail-tab").map((i) => i.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    const buttons = within(rail)
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid"))
      .filter((t) => t !== "shell-rail-tab");
    expect(buttons).toEqual(["shell-rail-expand", "shell-rail-fullscreen"]);
    expect(tooltipText(within(rail).getByTestId("shell-rail-expand"))).toBe("Open pane ⇧⌘M");
  });

  it("opens again from its control (pane.collapse --off) and from a click on an icon (that tab takes the focus)", async () => {
    await seed();
    render(<PaneGrid />);
    const rail = railOf("p-b");
    if (!rail) throw new Error("rail");
    fireEvent.click(within(rail).getByTestId("shell-rail-expand"));
    expect(ran).toEqual([["pane.collapse", { pane: "p-b", off: "true" }]]);
    fireEvent.click(within(rail).getAllByTestId("shell-rail-tab")[1] as HTMLElement);
    expect(focusedTabs).toEqual(["t-d2"]);
  });

  it("an automatic rail has no open control", async () => {
    width = 700;
    await seed(row("s-r", [pane("p-a", [tab("t-th", "thread", "s-1")]), pane("p-b", [tab("t-prs", "prs")]), pane("p-c", [tab("t-d", "diff", "s-1")])]));
    render(<PaneGrid />);
    const rail = railOf("p-b");
    if (!rail) throw new Error("rail");
    expect(rail.hasAttribute("data-collapsed")).toBe(false);
    expect(within(rail).queryByTestId("shell-rail-expand")).toBeNull();
  });

  it("with the focus, it is marked focused and a focus request puts the keyboard on its selected icon", async () => {
    await seed(TREE, "p-b");
    render(<PaneGrid />);
    const rail = railOf("p-b");
    if (!rail) throw new Error("rail");
    expect(rail.hasAttribute("data-focused")).toBe(true);
    expect(rail.className).toContain("border-cf-accent/60");
    act(() => {
      requestPaneFocus("p-b");
    });
    expect(document.activeElement?.getAttribute("data-tab-id")).toBe("t-prs");
  });

  it("in full screen it is drawn whole, and its stored state is untouched", async () => {
    await seed(TREE, "p-b");
    render(<PaneGrid />);
    act(() => {
      enterFullscreen();
    });
    expect(screen.queryAllByTestId("shell-rail")).toEqual([]);
    expect(screen.getByTestId("shell-pane").getAttribute("data-pane-id")).toBe("p-b");
    expect(ran).toEqual([]);
  });
});

describe("the strip's collapse control", () => {
  const stripOf = (id: string) => screen.getAllByTestId("shell-pane").find((p) => p.getAttribute("data-pane-id") === id);

  it("sits before full screen, names itself and its key, and collapses its pane (pane.collapse --on)", async () => {
    await seed();
    render(<PaneGrid />);
    const p = stripOf("p-c");
    if (!p) throw new Error("pane");
    const strip = within(p).getByTestId("shell-tab-strip");
    const order = Array.from(strip.querySelectorAll("[data-testid]"))
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => t === "shell-collapse" || t === "shell-fullscreen");
    expect(order).toEqual(["shell-collapse", "shell-fullscreen"]);
    const button = within(p).getByTestId("shell-collapse");
    expect(tooltipText(button)).toBe("Collapse pane ⇧⌘M");
    fireEvent.click(button);
    expect(ran).toEqual([["pane.collapse", { pane: "p-c", on: "true" }]]);
  });

  it("is disabled on the last open pane of the space, with the reason in its tooltip", async () => {
    await seed(row("s-r", [pane("p-a", [tab("t-th", "thread", "s-1")]), collapsed(pane("p-b", [tab("t-prs", "prs")]))]));
    render(<PaneGrid />);
    const p = stripOf("p-a");
    if (!p) throw new Error("pane");
    const button = within(p).getByTestId("shell-collapse");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(tooltipText(button)).toBe("The last open pane of a space cannot be collapsed");
    fireEvent.click(button);
    expect(ran).toEqual([]);
  });

  it("is not there in full screen", async () => {
    await seed();
    render(<PaneGrid />);
    act(() => {
      enterFullscreen();
    });
    expect(screen.queryByTestId("shell-collapse")).toBeNull();
  });
});

describe("dividers' cursors", () => {
  const gutters = () => screen.queryAllByTestId("shell-gutter").map((g) => [g.getAttribute("data-index"), g.style.cursor]);
  const fixed = () => screen.queryAllByTestId("shell-gutter-fixed").map((g) => [g.getAttribute("data-index"), g.style.cursor]);

  it("beside a collapsed pane: not-allowed, no handle to grab and no keyboard", async () => {
    await seed();
    render(<PaneGrid />);
    expect(gutters()).toEqual([]);
    expect(fixed()).toEqual([
      ["0", "not-allowed"],
      ["1", "not-allowed"],
    ]);
    expect(screen.getAllByTestId("shell-gutter-fixed").every((g) => g.getAttribute("tabindex") === null)).toBe(true);
  });

  it("both ways with room, one way when a side is at its minimum, not-allowed when both are", async () => {
    const two = row("s-r", [pane("p-a", [tab("t-th", "thread", "s-1")]), pane("p-c", [tab("t-d", "diff", "s-1")])]);
    await seed(two);
    const { unmount } = render(<PaneGrid />);
    expect(gutters()).toEqual([["0", "col-resize"]]);
    unmount();
    // 480 + 12 + 520: the thread at its minimum, the diff 40 over its 480.
    width = 1012;
    await seed(row("s-r", [pane("p-a", [tab("t-th", "thread", "s-1")]), pane("p-c", [tab("t-d", "diff", "s-1")])], [0.2, 0.8]));
    const second = render(<PaneGrid />);
    expect(gutters()).toEqual([["0", "e-resize"]]);
    second.unmount();
    width = 972;
    await seed(two);
    render(<PaneGrid />);
    expect(gutters()).toEqual([["0", "not-allowed"]]);
    // A press there starts no drag.
    const g = screen.getByTestId("shell-gutter");
    fireEvent.pointerDown(g, { button: 0, pointerId: 1, clientX: 486 });
    expect(screen.queryByTestId("shell-gutter-drag")).toBeNull();
    expect(g.querySelector("span")?.hidden).toBe(true);
  });
});
