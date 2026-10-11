import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { getPanel, makeTab, openSurface, usePanelStore } from "@/stores/panel";
import { PANEL_MIN, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { filesSurface } from "@/surfaces/files";
import { pullRequestSurface } from "@/surfaces/pullrequest";
import { revealTab } from "./reveal";
import { SidePanel } from "./SidePanel";

const KEY = "session:a";

const newTabCommand: CommandView = { name: "view.panel.new-tab", title: "New Side Panel Tab", description: "", category: "View", args: [], keybindings: [], available: true };

beforeEach(() => {
  usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ selection: { kind: "session", id: "a" }, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
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

  it("expanded, it fills the row without a resize handle, shows without room, and settings still hides it", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null, width: 500, expanded: true } } });
    useUiStore.setState({ windowWidth: 1000, sidebarWidth: 520 });
    render(<SidePanel />);
    const wrapper = screen.getByTestId("side-panel-wrapper");
    expect(wrapper.getAttribute("data-expanded")).toBe("true");
    expect(wrapper.style.width).toBe("");
    expect(wrapper.className).toContain("flex-1");
    expect(screen.queryByRole("separator")).toBeNull();
    act(() => {
      useViewsStore.setState({ settingsOpen: true });
    });
    expect(screen.queryByTestId("side-panel")).toBeNull();
    // Back to the split: the stored width and the handle return (the room allows it again).
    act(() => {
      useViewsStore.setState({ settingsOpen: false });
      useUiStore.setState({ windowWidth: 1400, sidebarWidth: 260 });
      usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null, width: 500 } } });
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
    usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null }, "session:b": { open: true, tabs: [], activeTabId: null, width: 500 } } });
    render(<SidePanel />);
    const sep = () => screen.getByRole("separator");
    const wrapper = () => screen.getByTestId("side-panel-wrapper");
    expect(wrapper().style.width).toBe("420px");
    fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    expect(wrapper().style.width).toBe("436px");
    expect(getPanel("session:b").width).toBe(500);

    // The other selection's panel shows at its own width.
    act(() => {
      useUiStore.getState().select({ kind: "session", id: "b" });
    });
    expect(wrapper().style.width).toBe("500px");
    expect(sep().getAttribute("aria-valuenow")).toBe("500");
    fireEvent.doubleClick(sep());
    expect(wrapper().style.width).toBe("420px");
    expect(getPanel("session:b")).not.toHaveProperty("width");
    expect(getPanel(KEY).width).toBe(436);
  });

  it("renders a stored width above the room at the room, and keeps it for when the room comes back", () => {
    usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null, width: 800 } } });
    render(<SidePanel />);
    // 1400 - 260 - 24 - 360 = 756.
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("756px");
    act(() => {
      useUiStore.getState().setWindowWidth(1100);
    });
    expect(screen.getByTestId("side-panel-wrapper").style.width).toBe("456px");
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
      expect(usePanelStore.getState().byKey[KEY]?.tabs.map((t) => t.id)).toEqual([one.id]);
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
    act(() => {
      openSurface(KEY, one);
      openSurface(KEY, two);
    });
  });

  const plus = () => screen.getByTestId("panel-new-tab");
  const aside = () => screen.getByTestId("side-panel");
  const tabIds = () => getPanel(KEY).tabs.map((t) => t.id);
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
      usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null } } });
    });
    expect(screen.queryByTestId("panel-new-tab")).toBeNull();
    expect(screen.getByTestId("panel-empty")).toBeTruthy();
  });

  it("enters picking without adding a tab: the list shows, no tab is selected, the + is pressed", () => {
    render(<SidePanel />);
    expect(aside().hasAttribute("data-picking")).toBe(false);
    enterPicking();
    expect(tabIds()).toEqual([one.id, two.id]);
    expect(getPanel(KEY)).toMatchObject({ activeTabId: null, pickFrom: two.id });
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
    expect(getPanel(KEY).pickFrom).toBe(files.id);
    act(() => {
      fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    });
    enterPicking();
    fireEvent.click(screen.getByTestId("panel-empty").querySelector('[data-surface="files"]') as HTMLButtonElement);
    expect(tabIds()).toEqual([one.id, two.id, files.id]);
    expect(getPanel(KEY).activeTabId).toBe(files.id);
  });

  it("clicking a tab leaves picking", () => {
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByRole("tab", { name: "#1" }));
    expect(getPanel(KEY)).toEqual({ open: true, tabs: [one, two], activeTabId: one.id });
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
    expect(getPanel(KEY)).toEqual({ open: true, tabs: [one, two], activeTabId: one.id });
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
    expect(getPanel(KEY).activeTabId).toBe(active);
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
      expect(getPanel(KEY).activeTabId).toBe(two.id);
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
    expect(getPanel(KEY)).toEqual({ open: true, tabs: [one, files], activeTabId: null, pickFrom: files.id });
    expect(aside().getAttribute("data-picking")).toBe("true");
    fireEvent.keyDown(aside(), { key: "Escape" });
    expect(getPanel(KEY).activeTabId).toBe(files.id);
  });

  it("closing every tab while picking hides the panel", () => {
    render(<SidePanel />);
    enterPicking();
    fireEvent.click(screen.getByRole("button", { name: "Close #1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close #2" }));
    expect(getPanel(KEY)).toEqual({ open: false, tabs: [], activeTabId: null });
    expect(screen.queryByTestId("side-panel")).toBeNull();
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
