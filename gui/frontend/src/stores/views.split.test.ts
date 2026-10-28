import { beforeEach, describe, expect, it } from "vitest";
import { getPanel, makeTab, usePanelStore } from "./panel";
import { useUiStore, type FocusRegion } from "./ui";
import { showView, splitPanelCommand, useViewsStore } from "./views";

const closedPalette = { open: false, query: "", commandName: null, page: "commands" as const, returnTo: "content" as FocusRegion };
const files = makeTab("files", "Files");
const diff = makeTab("diff", "Diff");

describe("splitPanelCommand", () => {
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
    useUiStore.setState({ selection: { kind: "thread", id: "a" }, focus: "content", panelFocusSeq: 0, palette: closedPalette });
  });

  it("splits an unsplit panel (the active tab moves to the second group) and focuses it", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files, diff], activeTabId: diff.id }] } } });
    expect(splitPanelCommand()).toBe(true);
    expect(getPanel()).toEqual({
      open: true,
      groups: [
        { tabs: [files], activeTabId: files.id },
        { tabs: [diff], activeTabId: diff.id },
      ],
      focused: 1,
    });
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("joins a split panel, keeping its width and ratio; focus in the panel is asked back", () => {
    usePanelStore.setState({
      byKey: { "thread:a": { open: true, width: 600, ratio: 0.3, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [diff], activeTabId: diff.id }], focused: 1 } },
    });
    useUiStore.setState({ focus: "panel" });
    expect(splitPanelCommand()).toBe(false);
    expect(getPanel()).toEqual({ open: true, width: 600, ratio: 0.3, groups: [{ tabs: [files, diff], activeTabId: diff.id }] });
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("joining with focus elsewhere leaves it there", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files], activeTabId: files.id }, { tabs: [diff], activeTabId: diff.id }] } } });
    expect(splitPanelCommand()).toBe(false);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("a hidden split panel is shown, still split, rather than joined out of sight", () => {
    const groups = [
      { tabs: [files], activeTabId: files.id },
      { tabs: [diff], activeTabId: diff.id },
    ];
    usePanelStore.setState({ byKey: { "thread:a": { open: false, groups } } });
    expect(splitPanelCommand()).toBe(true);
    expect(getPanel()).toEqual({ open: true, groups });
  });

  it("a hidden unsplit panel is shown split", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: false, groups: [{ tabs: [files, diff], activeTabId: files.id }] } } });
    expect(splitPanelCommand()).toBe(true);
    expect(getPanel().open).toBe(true);
    expect(getPanel().groups).toHaveLength(2);
  });

  it("a panel without tabs is only shown: nothing to split", () => {
    expect(splitPanelCommand()).toBe(false);
    expect(getPanel()).toEqual({ open: true, groups: [{ tabs: [], activeTabId: null }] });
  });

  it("is a no-op while a page is up or with nothing selected", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files, diff], activeTabId: diff.id }] } } });
    useViewsStore.setState({ usageOpen: true });
    expect(splitPanelCommand()).toBe(false);
    expect(getPanel().groups).toHaveLength(1);
    useViewsStore.setState({ usageOpen: false });
    useUiStore.getState().select({ kind: "none" });
    expect(splitPanelCommand()).toBe(false);
    expect(usePanelStore.getState().byKey["thread:a"]?.groups).toHaveLength(1);
  });

  it("from the palette moves its return target to the panel instead of focusing", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files, diff], activeTabId: diff.id }] } } });
    useUiStore.setState({ focus: "palette", palette: { ...closedPalette, open: true, returnTo: "content" } });
    expect(splitPanelCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
  });

  it("is what ShowView panel.split runs", () => {
    usePanelStore.setState({ byKey: { "thread:a": { open: true, groups: [{ tabs: [files, diff], activeTabId: diff.id }] } } });
    expect(showView("panel.split")).toBe(true);
    expect(getPanel().groups).toHaveLength(2);
    expect(showView("panel.split")).toBe(true);
    expect(getPanel().groups).toHaveLength(1);
  });
});
