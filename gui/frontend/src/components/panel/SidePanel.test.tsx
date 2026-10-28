import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { KEYS, useSettingsStore } from "@/stores/settings";
import { closePanelTab, getPanel, isPicking, makeTab, openSurface, startPanelPicking, usePanelStore } from "@/stores/panel";
import { PANEL_MIN, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { filesSurface } from "@/surfaces/files";
import { pullRequestSurface } from "@/surfaces/pullrequest";
import { revealTab } from "./reveal";
import { SidePanel } from "./SidePanel";

const KEY = "thread:a";

const newTabCommand: CommandView = { name: "view.panel.new-tab", title: "New Side Panel Tab", description: "", category: "View", args: [], keybindings: [], available: true };

beforeEach(() => {
  usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false });
  useUiStore.setState({ selection: { kind: "thread", id: "a" }, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
  useCommandsStore.setState({ commands: [newTabCommand] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SidePanel", () => {
  it("re-renders a surface's availability when a store it watches changes", () => {
    const useFlag = create<{ ready: boolean }>()(() => ({ ready: false }));
    vi.spyOn(filesSurface, "available").mockImplementation(() => (useFlag.getState().ready ? "enabled" : "disabled"));
    const prev = filesSurface.watches;
    filesSurface.watches = [useFlag];
    try {
      render(<SidePanel />);
      const row = () => screen.getByTestId("panel-empty").querySelector('[data-surface="files"]');
      expect(row()?.getAttribute("data-availability")).toBe("disabled");
      act(() => {
        useFlag.setState({ ready: true });
      });
      expect(row()?.getAttribute("data-availability")).toBe("enabled");
      expect((row() as HTMLButtonElement).disabled).toBe(false);
    } finally {
      filesSurface.watches = prev;
    }
  });

  it("mounts each tab's body fresh, even for two tabs of one kind", () => {
    // State captured at mount: a reused component would keep showing the first tab's id.
    function Probe({ id }: { id: string }) {
      const [mountedFor] = useState(id);
      return <p data-testid="probe">{mountedFor}</p>;
    }
    vi.spyOn(pullRequestSurface, "render").mockImplementation((tab) => <Probe id={tab.id} />);
    const one = makeTab("pullrequest", "#1", { number: "1" });
    const two = makeTab("pullrequest", "#2", { number: "2" });
    act(() => {
      openSurface(KEY, one);
      openSurface(KEY, two);
    });
    render(<SidePanel />);
    expect(screen.getByTestId("probe").textContent).toBe(two.id);
    fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    expect(screen.getByTestId("panel-body").getAttribute("data-tab-id")).toBe(one.id);
    expect(screen.getByTestId("probe").textContent).toBe(one.id);
  });

  it("is hidden while there is no room beside the content pane, and keeps its open state", () => {
    useUiStore.setState({ windowWidth: 1000, sidebarWidth: 520 });
    render(<SidePanel />);
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(usePanelStore.getState().byKey[KEY]?.open).toBe(true);
    act(() => {
      useUiStore.setState({ sidebarVisible: false });
    });
    expect(screen.getByTestId("side-panel")).toBeTruthy();
    const sep = screen.getByRole("separator");
    expect(sep.getAttribute("aria-valuenow")).toBe("420");
    expect(sep.getAttribute("aria-valuemin")).toBe(String(PANEL_MIN));
    expect(sep.getAttribute("aria-valuemax")).toBe("600");
  });

  it("expanded, it fills the row without a resize handle, shows without room, and the usage page still hides it", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }], width: 500, expanded: true } } });
    useUiStore.setState({ windowWidth: 1000, sidebarWidth: 520 });
    render(<SidePanel />);
    const wrapper = screen.getByTestId("side-panel-wrapper");
    expect(wrapper.getAttribute("data-expanded")).toBe("true");
    expect(wrapper.style.width).toBe("");
    expect(wrapper.className).toContain("flex-1");
    expect(screen.queryByRole("separator")).toBeNull();
    act(() => {
      useViewsStore.setState({ usageOpen: true });
    });
    expect(screen.queryByTestId("side-panel")).toBeNull();
    // Back to the split: the stored width and the handle return (the room allows it again).
    act(() => {
      useViewsStore.setState({ usageOpen: false });
      useUiStore.setState({ windowWidth: 1400, sidebarWidth: 260 });
      usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }], width: 500 } } });
    });
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("500px");
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("resizes with arrow keys on the separator (Left widens)", () => {
    render(<SidePanel />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(getPanel(KEY).width).toBe(436);
    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(getPanel(KEY).width).toBe(372);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(getPanel(KEY).width).toBe(PANEL_MIN);
  });

  it("sizes only the current selection's panel; double-click resets it to the default", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }] }, "thread:b": { open: true, groups: [{ tabs: [], activeTabId: null }], width: 500 } } });
    render(<SidePanel />);
    const sep = () => screen.getByRole("separator");
    const wrapper = () => screen.getByTestId("side-panel-wrapper");
    expect(wrapper().style.width).toBe("420px");
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    expect(wrapper().style.width).toBe("436px");
    expect(getPanel("thread:b").width).toBe(500);

    // The other selection's panel shows at its own width.
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "b" });
    });
    expect(wrapper().style.width).toBe("500px");
    expect(sep().getAttribute("aria-valuenow")).toBe("500");
    fireEvent.doubleClick(sep());
    expect(wrapper().style.width).toBe("420px");
    expect(getPanel("thread:b")).not.toHaveProperty("width");
    expect(getPanel(KEY).width).toBe(436);
  });

  it("renders a stored width above the room at the room, and keeps it for when the room comes back", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }], width: 800 } } });
    render(<SidePanel />);
    // 1400 - 260 - 36 - 360 = 744.
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("744px");
    act(() => {
      useUiStore.getState().setWindowWidth(1100);
    });
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("444px");
    expect(getPanel(KEY).width).toBe(800);
    act(() => {
      useUiStore.getState().setWindowWidth(1600);
    });
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("800px");
  });

  it("offers the active surface chords, but never the panel's own (cmd+w, surface letters)", () => {
    vi.spyOn(pullRequestSurface, "render").mockImplementation(() => <p data-testid="probe">body</p>);
    const onKey = vi.fn(() => true);
    const prev = pullRequestSurface.onKey;
    pullRequestSurface.onKey = onKey;
    try {
      const one = makeTab("pullrequest", "#1", { number: "1" });
      const two = makeTab("pullrequest", "#2", { number: "2" });
      act(() => {
        openSurface(KEY, one);
        openSurface(KEY, two);
      });
      render(<SidePanel />);
      const body = screen.getByTestId("probe");
      fireEvent.keyDown(body, { key: "p" });
      fireEvent.keyDown(body, { key: "f" });
      expect(onKey).not.toHaveBeenCalled();
      fireEvent.keyDown(body, { key: "c", metaKey: true, shiftKey: true });
      expect(onKey).toHaveBeenCalledWith("cmd+shift+c", expect.objectContaining({ id: two.id }));
      fireEvent.keyDown(body, { key: "q" });
      expect(onKey).toHaveBeenLastCalledWith("q", expect.objectContaining({ id: two.id }));
      onKey.mockClear();
      fireEvent.keyDown(body, { key: "w", metaKey: true });
      expect(onKey).not.toHaveBeenCalled();
      expect(usePanelStore.getState().byKey[KEY]?.groups[0]?.tabs.map((t) => t.id)).toEqual([one.id]);
    } finally {
      pullRequestSurface.onKey = prev;
    }
  });
});

describe("the new-tab button and picking", () => {
  const one = makeTab("pullrequest", "#1", { number: "1" });
  const two = makeTab("pullrequest", "#2", { number: "2" });
  const files = makeTab("files", "Files");

  beforeEach(() => {
    vi.spyOn(pullRequestSurface, "render").mockImplementation((tab) => <p data-testid="probe">{tab.id}</p>);
    vi.spyOn(filesSurface, "render").mockImplementation((tab) => <p data-testid="probe">{tab.id}</p>);
    vi.spyOn(filesSurface, "available").mockReturnValue("enabled");
    // The File surface's own default is the panel's last File tab: a stand-in tab here.
    vi.spyOn(filesSurface, "openDefault").mockReturnValue(files);
    act(() => {
      openSurface(KEY, one);
      openSurface(KEY, two);
    });
  });

  const plus = () => screen.getByTestId("panel-new-tab");
  const aside = () => screen.getByTestId("side-panel");
  const tabIds = () => getPanel(KEY).groups[0]?.tabs.map((t) => t.id);
  const selected = () => screen.queryAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
  const enterPicking = () => {
    fireEvent.click(plus());
  };

  it("shows after the last tab, and not without tabs", () => {
    render(<SidePanel />);
    const strip = screen.getByTestId("panel-tabs");
    expect(strip.lastElementChild?.contains(plus())).toBe(true);
    expect(plus().getAttribute("aria-label")).toBe("New tab");
    expect(plus().getAttribute("aria-pressed")).toBe("false");
    act(() => {
      usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
    });
    expect(screen.queryByTestId("panel-new-tab")).toBeNull();
    expect(screen.getByTestId("panel-empty")).toBeTruthy();
  });

  it("enters picking without adding a tab: the list shows, no tab is selected, the + is pressed", () => {
    render(<SidePanel />);
    expect(aside().hasAttribute("data-picking")).toBe(false);
    enterPicking();
    expect(tabIds()).toEqual([one.id, two.id]);
    expect(getPanel(KEY)).toMatchObject({ groups: [{ activeTabId: null, pickFrom: two.id }] });
    expect(aside().getAttribute("data-picking")).toBe("true");
    expect(screen.getByTestId("panel-empty")).toBeTruthy();
    expect(screen.queryByTestId("panel-body")).toBeNull();
    expect(selected()).toEqual([]);
    expect(plus().getAttribute("aria-pressed")).toBe("true");
    // The strip stays reachable by Tab: the first tab takes the roving tabindex.
    expect(screen.getByRole("tab", { name: "#1" }).tabIndex).toBe(0);
  });

  it("picking a surface adds its tab, activates it, and leaves picking", () => {
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByTestId("panel-empty").querySelector('[data-surface="files"]') as HTMLButtonElement);
    expect(tabIds()).toEqual([one.id, two.id, files.id]);
    expect(getPanel(KEY)).not.toHaveProperty("pickFrom");
    expect(screen.getByTestId("panel-body").getAttribute("data-tab-id")).toBe(files.id);
    expect(aside().hasAttribute("data-picking")).toBe(false);
    expect(plus().getAttribute("aria-pressed")).toBe("false");
  });

  it("picking a surface that is already open activates its tab instead of adding one", () => {
    act(() => {
      openSurface(KEY, files);
    });
    render(<SidePanel />);
    enterPicking();
    expect(getPanel(KEY).groups[0]?.pickFrom).toBe(files.id);
    act(() => {
      fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    });
    enterPicking();
    fireEvent.click(screen.getByTestId("panel-empty").querySelector('[data-surface="files"]') as HTMLButtonElement);
    expect(tabIds()).toEqual([one.id, two.id, files.id]);
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(files.id);
  });

  it("clicking a tab leaves picking", () => {
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [one, two], activeTabId: one.id }] });
    expect(screen.getByTestId("probe").textContent).toBe(one.id);
    expect(aside().hasAttribute("data-picking")).toBe(false);
  });

  it.each([
    ["Escape", { key: "Escape" }],
    ["cmd+w", { key: "w", metaKey: true }],
  ])("%s goes back to the tab that was active, and the panel stays", (_name, ev) => {
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    enterPicking();
    fireEvent.keyDown(screen.getByTestId("panel-empty"), ev);
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [one, two], activeTabId: one.id }] });
    expect(screen.getByTestId("probe").textContent).toBe(one.id);
  });

  it.each([
    ["Escape", (row: HTMLElement) => fireEvent.keyDown(row, { key: "Escape" }), one.id],
    ["its letter", (row: HTMLElement) => fireEvent.keyDown(row, { key: "f" }), files.id],
    ["a click", (row: HTMLElement) => fireEvent.click(row), files.id],
  ])("leaving the list with focus on a row (%s) hands focus to the panel", (_name, leave, active) => {
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    enterPicking();
    const row = screen.getByTestId("panel-empty").querySelector<HTMLButtonElement>('[data-surface="files"]');
    if (!row) throw new Error("no files row");
    row.focus();
    leave(row);
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(active);
    expect(screen.queryByTestId("panel-empty")).toBeNull();
    expect(document.activeElement).toBe(aside());
  });

  it("Escape with a tab active is left alone (surfaces use it)", () => {
    const onKey = vi.fn(() => true);
    const prev = pullRequestSurface.onKey;
    pullRequestSurface.onKey = onKey;
    try {
      render(<SidePanel />);
      fireEvent.keyDown(screen.getByTestId("probe"), { key: "Escape" });
      expect(onKey).toHaveBeenCalledWith("escape", expect.objectContaining({ id: two.id }));
      expect(getPanel(KEY).groups[0]?.activeTabId).toBe(two.id);
    } finally {
      pullRequestSurface.onKey = prev;
    }
  });

  it("closing the tab it came from keeps picking; Escape then goes to its neighbour", () => {
    act(() => {
      openSurface(KEY, files);
      openSurface(KEY, two);
    });
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByRole("button", { name: "Close #2" }));
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [one, files], activeTabId: null, pickFrom: files.id }] });
    expect(aside().getAttribute("data-picking")).toBe("true");
    fireEvent.keyDown(aside(), { key: "Escape" });
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(files.id);
  });

  it("closing every tab while picking hides the panel", () => {
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByRole("button", { name: "Close #1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close #2" }));
    expect(getPanel(KEY)).toEqual({ open: false, groups: [{ tabs: [], activeTabId: null }] });
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });
});

describe("appearance.panel_keep_open", () => {
  const one = makeTab("pullrequest", "#1", { number: "1" });
  const two = makeTab("pullrequest", "#2", { number: "2" });
  const aside = () => screen.getByTestId("side-panel");

  function keepOpen(on: boolean): void {
    useSettingsStore.setState({ snapshot: { values: { [KEYS.panelKeepOpen]: String(on) }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
  }

  beforeEach(() => {
    vi.spyOn(pullRequestSurface, "render").mockImplementation((tab) => <p data-testid="probe">{tab.id}</p>);
    useUiStore.setState({ focus: "panel", panelFocusSeq: 0 });
    act(() => {
      openSurface(KEY, one);
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ snapshot: null });
  });

  it("off: the last tab's × hides the panel and hands focus to the content pane", () => {
    keepOpen(false);
    const focusContent = vi.spyOn(useUiStore.getState(), "focusContent");
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close #1" }));
    expect(getPanel(KEY).open).toBe(false);
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(focusContent).toHaveBeenCalled();
  });

  it("on: the last tab's × leaves the surface list showing, with focus in the panel", () => {
    keepOpen(true);
    render(<SidePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close #1" }));
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [], activeTabId: null }] });
    expect(screen.getByTestId("panel-empty")).toBeTruthy();
    expect(screen.queryByTestId("panel-new-tab")).toBeNull();
    expect(document.activeElement).toBe(aside());
  });

  it("on: cmd+w closes the last tab and stays; cmd+w again hides the panel", () => {
    keepOpen(true);
    act(() => {
      openSurface(KEY, two);
    });
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("probe"), { key: "w", metaKey: true });
    expect(getPanel(KEY).groups[0]?.tabs.map((t) => t.id)).toEqual([one.id]);
    fireEvent.keyDown(screen.getByTestId("probe"), { key: "w", metaKey: true });
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [], activeTabId: null }] });
    expect(screen.getByTestId("panel-empty")).toBeTruthy();
    fireEvent.keyDown(aside(), { key: "w", metaKey: true });
    expect(getPanel(KEY).open).toBe(false);
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("on: middle click on the last tab leaves the panel open", () => {
    keepOpen(true);
    render(<SidePanel />);
    const wrapper = screen.getByRole("tab", { name: "#1" }).parentElement;
    if (!wrapper) throw new Error("no tab wrapper");
    fireEvent(wrapper, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(getPanel(KEY)).toEqual({ open: true, groups: [{ tabs: [], activeTabId: null }] });
  });
});

describe("reordering tabs", () => {
  const one = makeTab("pullrequest", "#1", { number: "1" });
  const two = makeTab("pullrequest", "#2", { number: "2" });
  const three = makeTab("pullrequest", "#3", { number: "3" });

  beforeEach(() => {
    vi.spyOn(pullRequestSurface, "render").mockImplementation((tab) => <p data-testid="probe">{tab.id}</p>);
    act(() => {
      openSurface(KEY, one);
      openSurface(KEY, two);
      openSurface(KEY, three);
    });
  });

  const tab = (name: string) => screen.getByRole("tab", { name });
  const titles = () => screen.getAllByRole("tab").map((t) => t.textContent);
  const tabIds = () => getPanel(KEY).groups[0]?.tabs.map((t) => t.id);

  it("alt+Right and alt+Left move the focused tab one slot, keep it focused, and keep the active tab", () => {
    render(<SidePanel />);
    tab("#1").focus();
    fireEvent.keyDown(tab("#1"), { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(tabIds()).toEqual([two.id, one.id, three.id]);
    expect(titles()).toEqual(["#2", "#1", "#3"]);
    expect(document.activeElement).toBe(tab("#1"));
    fireEvent.keyDown(tab("#1"), { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(titles()).toEqual(["#2", "#3", "#1"]);
    expect(document.activeElement).toBe(tab("#1"));
    fireEvent.keyDown(tab("#1"), { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(titles()).toEqual(["#2", "#1", "#3"]);
    expect(document.activeElement).toBe(tab("#1"));
    // Moving is not activating: #3 stays the active tab.
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(three.id);
    expect(tab("#3").getAttribute("aria-selected")).toBe("true");
  });

  it("clamps at the ends (no wrap), and still handles the key there", () => {
    const onKey = vi.fn(() => true);
    const prev = pullRequestSurface.onKey;
    pullRequestSurface.onKey = onKey;
    try {
      render(<SidePanel />);
      tab("#1").focus();
      const before = usePanelStore.getState();
      expect(fireEvent.keyDown(tab("#1"), { key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe(false);
      tab("#3").focus();
      expect(fireEvent.keyDown(tab("#3"), { key: "ArrowRight", code: "ArrowRight", altKey: true })).toBe(false);
      expect(usePanelStore.getState()).toBe(before);
      expect(document.activeElement).toBe(tab("#3"));
      // Handled by the strip: the surface never sees it.
      expect(onKey).not.toHaveBeenCalled();
    } finally {
      pullRequestSurface.onKey = prev;
    }
  });

  it("from a tab's ×, moves that tab and keeps focus on the ×", () => {
    render(<SidePanel />);
    const close = screen.getByRole("button", { name: "Close #3" });
    close.focus();
    fireEvent.keyDown(close, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    expect(titles()).toEqual(["#1", "#3", "#2"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close #3" }));
  });

  it("plain arrows still only move focus, and alt+shift+arrows do nothing", () => {
    render(<SidePanel />);
    tab("#2").focus();
    fireEvent.keyDown(tab("#2"), { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(tab("#3"));
    fireEvent.keyDown(tab("#3"), { key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true });
    expect(tabIds()).toEqual([one.id, two.id, three.id]);
  });

  it("a click (pointer down and up without moving 4px) still activates the tab", () => {
    render(<SidePanel />);
    const t = tab("#1");
    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 12, clientY: 11 });
    fireEvent.click(t);
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(one.id);
    expect(screen.getByTestId("probe").textContent).toBe(one.id);
  });

  it("a drag past 4px is not a click: the tab is not activated on release", () => {
    render(<SidePanel />);
    const t = tab("#1");
    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 40, clientY: 10 });
    expect(t.parentElement?.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 40, clientY: 10 });
    fireEvent.click(t);
    expect(getPanel(KEY).groups[0]?.activeTabId).toBe(three.id);
    expect(t.parentElement?.hasAttribute("data-dragging")).toBe(false);
  });

  it("the aside carries data-dragging (its iframes ignore the pointer) from the lift to the drop, and to a cancel", () => {
    render(<SidePanel />);
    const aside = screen.getByTestId("side-panel");
    const t = tab("#1");
    expect(aside.hasAttribute("data-dragging")).toBe(false);
    // Under the 4px threshold the press is still a click: no drag yet.
    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 12, clientY: 10 });
    expect(aside.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 40, clientY: 10 });
    expect(aside.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 40, clientY: 10 });
    expect(aside.hasAttribute("data-dragging")).toBe(false);

    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 40, clientY: 10 });
    expect(aside.getAttribute("data-dragging")).toBe("true");
    fireEvent.keyDown(t, { key: "Escape", code: "Escape" });
    expect(aside.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 40, clientY: 10 });
  });

  it("mid-drag, Escape cancels the drag even while picking (which keeps picking), and alt+arrows wait for the drop", () => {
    render(<SidePanel />);
    // Not a click on the +: the drag test before this one leaves dnd-kit's click swallower on the document for 50ms.
    act(() => {
      startPanelPicking(KEY);
    });
    expect(isPicking(getPanel(KEY))).toBe(true);
    const t = tab("#1");
    t.focus();
    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 40, clientY: 10 });
    expect(t.parentElement?.getAttribute("data-dragging")).toBe("true");
    fireEvent.keyDown(t, { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(tabIds()).toEqual([one.id, two.id, three.id]);
    fireEvent.keyDown(t, { key: "Escape", code: "Escape" });
    expect(t.parentElement?.hasAttribute("data-dragging")).toBe(false);
    expect(isPicking(getPanel(KEY))).toBe(true);
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 40, clientY: 10 });
    // After the drag, Escape is the panel's again.
    fireEvent.keyDown(t, { key: "Escape", code: "Escape" });
    expect(isPicking(getPanel(KEY))).toBe(false);
  });

  /** jsdom lays nothing out: the header and strip are 400px wide and the tabs sit 100px apart, 80px wide, so dnd-kit finds the tab under the pointer. */
  const layOutTabs = () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist" || this.dataset.testid === "panel-header") return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 28 });
      if (this.dataset.tabId === undefined || !this.parentElement) return new DOMRect();
      const i = Array.from(this.parentElement.children).indexOf(this);
      return DOMRect.fromRect({ x: i * 100, y: 0, width: 80, height: 28 });
    });
  };
  const drag = (t: HTMLElement, x: number) => {
    fireEvent.pointerDown(t, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: 15, clientY: 10 });
    fireEvent.pointerMove(t, { isPrimary: true, clientX: x, clientY: 10 });
  };

  it("a drop onto another tab moves the dragged tab to that tab's index", () => {
    layOutTabs();
    render(<SidePanel />);
    const t = tab("#1");
    drag(t, 210);
    fireEvent.pointerUp(t, { isPrimary: true, button: 0, clientX: 210, clientY: 10 });
    expect(tabIds()).toEqual([two.id, three.id, one.id]);
  });

  it("tabs opened or closed mid-drag: the drop uses the strip as it is then, and a closed dragged tab moves nothing", () => {
    layOutTabs();
    const four = makeTab("pullrequest", "#4", { number: "4" });
    render(<SidePanel />);
    const t = tab("#1");
    drag(t, 110);
    act(() => {
      openSurface(KEY, four);
    });
    fireEvent.pointerUp(document, { isPrimary: true, button: 0, clientX: 110, clientY: 10 });
    expect(tabIds()).toEqual([two.id, one.id, three.id, four.id]);

    const d = tab("#4");
    drag(d, 10);
    act(() => {
      closePanelTab(KEY, four.id);
    });
    fireEvent.pointerUp(document, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    expect(tabIds()).toEqual([two.id, one.id, three.id]);
    expect(screen.queryByTestId("panel-tabs")?.querySelector("[data-dragging]")).toBeNull();
  });

  it("a drag whose panel unmounts (the selection switched) moves nothing on release", () => {
    layOutTabs();
    const other = makeTab("files", "Files");
    act(() => {
      openSurface("thread:b", other);
    });
    render(<SidePanel />);
    const t = tab("#1");
    drag(t, 210);
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "b" } });
    });
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    fireEvent.pointerUp(document, { isPrimary: true, button: 0, clientX: 210, clientY: 10 });
    expect(tabIds()).toEqual([one.id, two.id, three.id]);
  });

  it("describes the keyboard move on each tab, and keeps the wrapper presentational", () => {
    render(<SidePanel />);
    const t = tab("#2");
    const described = document.getElementById(t.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("To move this tab, press Option with Left Arrow or Right Arrow. Drag it onto the other group to move it there, or onto the far edge of the panel to split it.");
    const wrapper = t.parentElement;
    expect(wrapper?.getAttribute("role")).toBe("presentation");
    expect(wrapper?.hasAttribute("tabindex")).toBe(false);
    expect(wrapper?.hasAttribute("aria-roledescription")).toBe(false);
    expect(tab("#3").tabIndex).toBe(0);
    expect(t.tabIndex).toBe(-1);
  });
});

describe("revealTab", () => {
  function strip(scrollLeft: number): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 100 });
    el.scrollLeft = scrollLeft;
    [0, 90, 180].forEach((left, i) => {
      const t = document.createElement("div");
      t.dataset.tabId = `t${String(i)}`;
      Object.defineProperty(t, "offsetLeft", { value: left });
      Object.defineProperty(t, "offsetWidth", { value: 80 });
      el.append(t);
    });
    return el;
  }

  it.each([
    ["a tab past the right edge scrolls into view", 0, "t2", 166],
    ["a tab past the left edge scrolls into view", 150, "t0", 0],
    ["a visible tab does not scroll", 0, "t0", 0],
    ["an unknown tab does not scroll", 40, "nope", 40],
  ])("%s", (_name, from, id, want) => {
    const el = strip(from);
    revealTab(el, id);
    expect(el.scrollLeft).toBe(want);
  });
});
