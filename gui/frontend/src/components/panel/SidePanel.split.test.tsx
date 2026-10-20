import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { getPanel, makeTab, usePanelStore, type PanelEntry } from "@/stores/panel";
import { PANEL_SIDE_BY_SIDE_MIN, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { SidePanel } from "./SidePanel";

const KEY = "thread:a";
const files = makeTab("files", "Files");
const diff = makeTab("diff", "Diff", { path: "a.go" });
const usage = makeTab("usage", "Usage");

const command = (name: string): CommandView => ({ name, title: name, description: "", category: "View", args: [], keybindings: [], available: true });

function setEntry(e: Partial<PanelEntry>): void {
  usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [files, usage], activeTabId: files.id }, { tabs: [diff], activeTabId: diff.id }], focused: 1, ...e } } });
}

const group = (g: 0 | 1) => screen.getByTestId("side-panel").querySelector<HTMLElement>(`[data-panel-group="${String(g)}"]`);
const split = () => screen.getByTestId("panel-split");
const controlsIn = () => screen.getByTestId("panel-controls").closest("[data-panel-group]")?.getAttribute("data-panel-group");
const tabWrapper = (g: 0 | 1, id: string) => group(g)?.querySelector<HTMLElement>(`[role="presentation"][data-tab-id="${id}"]`);

beforeEach(() => {
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false });
  // panelMax 776: room for a 760px panel.
  useUiStore.setState({ selection: { kind: "thread", id: "a" }, windowWidth: 1440, sidebarVisible: true, sidebarWidth: 280, focus: "panel" });
  useCommandsStore.setState({ commands: [command("view.panel.new-tab"), command("view.panel.expand"), command("view.panel.toggle")] });
  // jsdom has no pointer capture.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a split side panel", () => {
  it("unsplit: one group, its header holds the buttons, no divider", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [files], activeTabId: files.id }] } } });
    render(<SidePanel />);
    expect(split().hasAttribute("data-split")).toBe(false);
    expect(group(1)).toBeNull();
    expect(screen.queryByTestId("panel-split-divider")).toBeNull();
    expect(controlsIn()).toBe("0");
    // Unsplit, the group is not focusable itself and is not marked focused.
    expect(group(0)?.hasAttribute("tabindex")).toBe(false);
    expect(group(0)?.hasAttribute("data-focused")).toBe(false);
  });

  it.each<[string, Partial<PanelEntry>, "stack" | "side", string]>([
    ["the default width stacks, buttons in the top group", {}, "stack", "0"],
    ["just under the threshold stacks", { width: PANEL_SIDE_BY_SIDE_MIN - 1 }, "stack", "0"],
    ["at the threshold, side by side, buttons in the right group", { width: PANEL_SIDE_BY_SIDE_MIN }, "side", "1"],
    ["expanded, side by side at any width", { expanded: true }, "side", "1"],
  ])("%s", (_name, e, orientation, controls) => {
    setEntry(e);
    render(<SidePanel />);
    expect(split().getAttribute("data-orientation")).toBe(orientation);
    expect(split().className).toContain(orientation === "side" ? "flex-row" : "flex-col");
    expect(screen.getByTestId("panel-split-divider").getAttribute("aria-orientation")).toBe(orientation === "side" ? "vertical" : "horizontal");
    expect(controlsIn()).toBe(controls);
  });

  it("follows a window resize at once", () => {
    setEntry({ width: 700 });
    render(<SidePanel />);
    expect(split().getAttribute("data-orientation")).toBe("side");
    act(() => {
      useUiStore.setState({ windowWidth: 1200 }); // panelMax 536: rendered narrower
    });
    expect(split().getAttribute("data-orientation")).toBe("stack");
  });

  it("holds its orientation while the panel's resize handle is dragged, and catches up on release", () => {
    setEntry({ width: 560 });
    render(<SidePanel />);
    const handle = screen.getByTestId("panel-resize-handle");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 560, bottom: 800, width: 560, height: 800, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(getPanel(KEY).width).toBe(660);
    expect(split().getAttribute("data-orientation")).toBe("stack");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 });
    expect(split().getAttribute("data-orientation")).toBe("side");
  });

  it("sizes each group by the ratio, with each group's minimum on the split's axis", () => {
    setEntry({ ratio: 0.3, width: 760 });
    render(<SidePanel />);
    expect(group(0)?.style.flex).toBe("0.3 1 0px");
    expect(group(1)?.style.flex).toBe("0.7 1 0px");
    expect(group(0)?.style.minWidth).toBe("280px");
    expect(group(0)?.style.minHeight).toBe("");
    act(() => {
      setEntry({ ratio: 0.3 });
    });
    expect(group(1)?.style.minHeight).toBe("160px");
    expect(group(1)?.style.minWidth).toBe("");
  });

  it("tints the focused group's active tab fully and the other group's lighter", () => {
    setEntry({});
    render(<SidePanel />);
    expect(group(1)?.getAttribute("data-focused")).toBe("true");
    expect(tabWrapper(1, diff.id)?.className).toContain("dark:bg-accent/50");
    expect(tabWrapper(0, files.id)?.className).toContain("bg-accent/40");
    expect(tabWrapper(0, files.id)?.className).toContain("dark:bg-accent/25");
    // An inactive tab has neither.
    expect(tabWrapper(0, usage.id)?.className).not.toContain("dark:bg-accent/25");
  });

  it("a press or focus inside a group focuses it", () => {
    setEntry({});
    render(<SidePanel />);
    const g0 = group(0);
    if (!g0) throw new Error("no group");
    fireEvent.pointerDown(g0.querySelector('[data-testid="panel-body"]') ?? g0);
    expect(getPanel(KEY).focused).toBeUndefined();
    expect(group(0)?.getAttribute("data-focused")).toBe("true");
    const tab1 = group(1)?.querySelector<HTMLElement>('[role="tab"]');
    act(() => {
      tab1?.focus();
    });
    expect(getPanel(KEY).focused).toBe(1);
  });

  it("each group's +, list and the panel's letters act on their own group", () => {
    setEntry({ focused: undefined });
    render(<SidePanel />);
    // The second group's "+": it is focused first, then the command picks there.
    fireEvent.click(group(1)?.querySelector('[data-testid="panel-new-tab"]') ?? document.body);
    expect(getPanel(KEY).focused).toBe(1);
    expect(group(1)?.getAttribute("data-picking")).toBe("true");
    expect(group(0)?.hasAttribute("data-picking")).toBe(false);
    expect(screen.getByTestId("side-panel").getAttribute("data-picking")).toBe("true");
    expect(group(1)?.querySelector('[data-testid="panel-empty"]')).not.toBeNull();
    // Escape goes back in that group.
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "Escape", code: "Escape" });
    expect(group(1)?.hasAttribute("data-picking")).toBe(false);
    expect(getPanel(KEY).groups[1]?.activeTabId).toBe(diff.id);
  });

  it("cmd+alt+\\ moves the keyboard to the other group and back", () => {
    setEntry({});
    render(<SidePanel />);
    const aside = screen.getByTestId("side-panel");
    act(() => {
      aside.focus();
    });
    fireEvent.keyDown(aside, { key: "«", code: "Backslash", metaKey: true, altKey: true });
    expect(getPanel(KEY).focused).toBeUndefined();
    expect(document.activeElement).toBe(group(0));
    fireEvent.keyDown(document.activeElement ?? aside, { key: "«", code: "Backslash", metaKey: true, altKey: true });
    expect(getPanel(KEY).focused).toBe(1);
    expect(document.activeElement).toBe(group(1));
  });

  it("cmd+w closes the focused group's tab; the last one collapses the split", () => {
    setEntry({});
    render(<SidePanel />);
    const aside = screen.getByTestId("side-panel");
    fireEvent.keyDown(aside, { key: "w", code: "KeyW", metaKey: true });
    expect(getPanel(KEY).groups).toEqual([{ tabs: [files, usage], activeTabId: files.id }]);
    expect(split().hasAttribute("data-split")).toBe(false);
    expect(useUiStore.getState().panelFocusSeq).toBeGreaterThan(0);
  });

  describe("the divider", () => {
    const rect = (w: number, h: number) => ({ left: 100, top: 50, right: 100 + w, bottom: 50 + h, width: w, height: h, x: 100, y: 50, toJSON: () => ({}) });

    it("drags the ratio along the split's axis, clamped to each group's minimum", () => {
      setEntry({ width: 760 });
      render(<SidePanel />);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(759, 800));
      const d = screen.getByTestId("panel-split-divider");
      fireEvent.pointerDown(d, { pointerId: 1, clientX: 479 });
      expect(d.getAttribute("data-dragging")).toBe("true");
      fireEvent.pointerMove(d, { pointerId: 1, clientX: 100 + 379 });
      // The middle is the default: no stored ratio.
      expect(getPanel(KEY).ratio).toBeUndefined();
      fireEvent.pointerMove(d, { pointerId: 1, clientX: 100 + 400 });
      expect(getPanel(KEY).ratio).toBeCloseTo(400 / 758, 3);
      // Past the first group's 280px minimum.
      fireEvent.pointerMove(d, { pointerId: 1, clientX: 120 });
      expect(getPanel(KEY).ratio).toBeCloseTo(Math.round((280 / 758) * 1000) / 1000, 3);
      fireEvent.pointerUp(d, { pointerId: 1 });
      expect(d.hasAttribute("data-dragging")).toBe(false);
      // After the release, a move does nothing.
      fireEvent.pointerMove(d, { pointerId: 1, clientX: 600 });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.369, 3);
    });

    it("stacked, drags vertically", () => {
      setEntry({});
      render(<SidePanel />);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(418, 801));
      const d = screen.getByTestId("panel-split-divider");
      fireEvent.pointerDown(d, { pointerId: 1, clientY: 450 });
      fireEvent.pointerMove(d, { pointerId: 1, clientX: 0, clientY: 50 + 600 });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.75, 3);
      fireEvent.pointerUp(d, { pointerId: 1 });
    });

    it("moves with the arrows (16px, Shift 64px), Home and End, and resets on double-click", () => {
      setEntry({ width: 760 });
      render(<SidePanel />);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(1601, 800));
      const d = screen.getByTestId("panel-split-divider");
      fireEvent.keyDown(d, { key: "ArrowRight" });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.51, 3);
      fireEvent.keyDown(d, { key: "ArrowLeft", shiftKey: true });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.47, 3);
      expect(d.getAttribute("aria-valuenow")).toBe("47");
      fireEvent.keyDown(d, { key: "Home" });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.2, 3);
      fireEvent.keyDown(d, { key: "End" });
      expect(getPanel(KEY).ratio).toBeCloseTo(0.8, 3);
      fireEvent.doubleClick(d);
      expect(getPanel(KEY).ratio).toBeUndefined();
      expect(d.getAttribute("aria-valuenow")).toBe("50");
    });

    it("leaves modified keys alone", () => {
      setEntry({ width: 760 });
      render(<SidePanel />);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(1601, 800));
      fireEvent.keyDown(screen.getByTestId("panel-split-divider"), { key: "ArrowRight", metaKey: true });
      expect(getPanel(KEY).ratio).toBeUndefined();
    });
  });
});
