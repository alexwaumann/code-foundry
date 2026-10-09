import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { makeTab, openSurface, usePanelStore } from "@/stores/panel";
import { PANEL_MIN, useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { filesSurface } from "@/surfaces/files";
import { pullRequestSurface } from "@/surfaces/pullrequest";
import { revealTab } from "./reveal";
import { SidePanel } from "./SidePanel";

const KEY = "session:a";

beforeEach(() => {
  usePanelStore.setState({ byKey: { [KEY]: { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ selection: { kind: "session", id: "a" }, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, panelWidth: 420 });
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

  it("resizes with arrow keys on the separator (Left widens)", () => {
    render(<SidePanel />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(useUiStore.getState().panelWidth).toBe(436);
    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(useUiStore.getState().panelWidth).toBe(372);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(useUiStore.getState().panelWidth).toBe(PANEL_MIN);
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
