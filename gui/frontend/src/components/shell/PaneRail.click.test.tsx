/**
 * A click on a rail (docs/notes/shell-model.md, "Small windows" and "Collapsing a pane";
 * docs/notes/shell-25j-rail-click.md): anywhere that is not one of its controls opens the pane on
 * its selected tab (a collapsed pane as its Open pane button does, a folded one as its selected
 * icon does); an icon still opens on that tab; the buttons do what they did; a click from the
 * tab's context menu (a portal) is not a click on the rail.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNodeView } from "@/api/layout";
import { thread } from "@/test/projectsWorld";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const ran: string[] = [];
vi.mock("@/shell/commands", () => ({
  focusTabNow: (id: string) => {
    ran.push(`tab.focus ${id}`);
    return Promise.resolve(true);
  },
  focusPaneNow: () => Promise.resolve(true),
  runLayoutCommand: (name: string, args: Record<string, string> = {}) => {
    ran.push([name, ...Object.entries(args).map(([k, v]) => `${k}=${v}`)].join(" "));
    return Promise.resolve({ rev: 2, changed: true });
  },
  afterRev: () => Promise.resolve(),
}));
vi.mock("@/shell/fullscreen", () => ({
  enterFullscreen: (paneId: string) => {
    ran.push(`fullscreen ${paneId}`);
  },
}));

const { PaneRail } = await import("./PaneRail");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");
const { useThreadsStore } = await import("@/stores/threads");

const RECT = { x: 0, y: 0, w: 36, h: 400, rail: true };
const STRIP = { x: 0, y: 0, w: 400, h: 36, rail: true };

/** p-1 (Sizes, then Reviewer selected) beside the open p-2; p-1 collapsed or folded. */
async function seed(collapsed: boolean): Promise<void> {
  const p1 = pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-b", "thread", "s-2")], "t-b");
  const root = row("s-r", [(collapsed ? { ...p1, collapsed: true } : p1) as LayoutNodeView, pane("p-2", [tab("t-c", "prs")])]);
  await act(async () => {
    await seedLayout(layoutOf([space(root, "p-2")]));
  });
}

const rail = () => screen.getByTestId("shell-rail");
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const focusRequestFor = () => useShellViewStore.getState().focusRequest.paneId;

beforeEach(() => {
  ran.length = 0;
  resetLayout();
  resetShellView();
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", { name: "Sizes" }), "s-2": thread("s-2", { name: "Reviewer" }) }, order: ["s-1", "s-2"], loaded: true });
});

afterEach(() => {
  cleanup();
  resetLayout();
});

describe("a click on a rail's empty area", () => {
  it.each([
    ["a collapsed rail", true, RECT, ["pane.collapse pane=p-1 off=true"]],
    ["a collapsed strip", true, STRIP, ["pane.collapse pane=p-1 off=true"]],
    ["a folded rail", false, RECT, ["tab.focus t-b"]],
    ["a folded strip", false, STRIP, ["tab.focus t-b"]],
  ])("on %s opens the pane on its selected tab", async (_name, collapsed, rect, want) => {
    await seed(collapsed);
    render(<PaneRail paneId="p-1" rect={rect} />);
    // The rail itself, and the tablist that fills it: both are empty area.
    fireEvent.click(rail());
    await settle();
    expect(ran).toEqual(want);
    ran.length = 0;
    fireEvent.click(screen.getByRole("tablist"));
    await settle();
    expect(ran).toEqual(want);
    // A folded pane's keyboard goes to it now; a collapsed one's once the daemon has opened it (shell/collapse.ts).
    if (!collapsed) expect(focusRequestFor()).toBe("p-1");
  });

  it("adds no tab stop and no role: the icons are the tablist's only tabs, one of them in the tab order", async () => {
    await seed(true);
    render(<PaneRail paneId="p-1" rect={RECT} />);
    expect(rail().getAttribute("role")).toBeNull();
    expect(rail().hasAttribute("tabindex")).toBe(false);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0]);
  });
});

describe("a click on a rail's controls", () => {
  it.each([
    ["collapsed", true],
    ["folded", false],
  ])("on a %s rail, an icon opens the pane on that tab, not on the selected one", async (_name, collapsed) => {
    await seed(collapsed);
    render(<PaneRail paneId="p-1" rect={RECT} />);
    const first = screen.getAllByTestId("shell-rail-tab")[0];
    if (!first) throw new Error("no icon");
    fireEvent.click(first);
    // The icon's svg, as a pointer lands on it, is the icon too.
    const svg = first.querySelector("svg");
    if (svg) fireEvent.click(svg);
    await settle();
    expect(ran).toEqual(svg ? ["tab.focus t-a", "tab.focus t-a"] : ["tab.focus t-a"]);
  });

  it("Open pane opens a collapsed pane once, and Full screen only shows it full screen", async () => {
    await seed(true);
    render(<PaneRail paneId="p-1" rect={RECT} />);
    fireEvent.click(screen.getByTestId("shell-rail-expand"));
    await settle();
    expect(ran).toEqual(["pane.collapse pane=p-1 off=true"]);
    ran.length = 0;
    fireEvent.click(screen.getByTestId("shell-rail-fullscreen"));
    await settle();
    expect(ran).toEqual(["fullscreen p-1"]);
  });

  it("an item of an icon's context menu is not a click on the rail", async () => {
    await seed(true);
    render(<PaneRail paneId="p-1" rect={RECT} />);
    const first = screen.getAllByTestId("shell-rail-tab")[0];
    if (!first) throw new Error("no icon");
    fireEvent.contextMenu(first);
    const items = await screen.findAllByRole("menuitem");
    const item = items[0];
    if (!item) throw new Error("no item");
    fireEvent.click(item);
    await settle();
    expect(ran.filter((r) => r.startsWith("pane.collapse") || r.startsWith("tab.focus"))).toEqual([]);
  });
});
