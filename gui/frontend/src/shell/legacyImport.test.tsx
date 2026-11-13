import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyImportView, LayoutView } from "@/api/layout";
import { layoutOf, pane, space, tab } from "@/test/shellLayout";

// The import's call (api/layout.ts importLegacy): recorded, answered or failed per test.
const calls: [string, string][] = [];
let answer: (panel: string, bottom: string) => Promise<LegacyImportView>;
vi.mock("@/api/layout", async (orig) => ({
  ...(await orig<typeof import("@/api/layout")>()),
  importLegacy: (panel: string, bottom: string) => {
    calls.push([panel, bottom]);
    return answer(panel, bottom);
  },
}));
// The grid and the popup are their own tests' (components/shell): here a marker says the shell drew.
vi.mock("@/components/shell/PaneGrid", () => ({ PaneGrid: () => <div data-testid="pane-grid" /> }));
vi.mock("@/components/needs/NeedsPopup", () => ({ NeedsPopup: () => null }));

const { Shell } = await import("@/components/shell/Shell");
const { LEGACY_BOTTOM_KEY, LEGACY_PANEL_KEY, importSettled, readLegacyStores, resetLegacyImport, runLegacyImport, useLegacyImportStore } = await import("./legacyImport");
const { applyLayoutEvent, resetLayout, useLayoutStore } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");

const PANEL = '{"state":{"byKey":{"thread:s-1":{"open":true,"groups":[]}}},"version":3}';
const BOTTOM = '{"state":{"byKey":{"thread:s-1":{"open":true,"height":240}}},"version":1}';

/** The daemon's layout before the import (the mark unset), at rev 4. */
const before: LayoutView = { ...layoutOf([space(null, "")], 4), legacyImported: false };
/** What the import answers: the threads' sets remembered, the space still empty, the mark set. */
const after: LayoutView = {
  ...layoutOf([space(null, "")], 5),
  legacyImported: true,
  threads: [{ threadId: "s-1", spaceId: "sp-a", quick: { open: true, height: 240, ran: "" }, remembered: [{ tab: tab("t-f", "file", "s-1"), paneId: "", index: 0, active: true, adjacent: false, beside: null, fresh: null }], rememberedPaneId: "" }],
};

function snapshot(l: LayoutView): void {
  applyLayoutEvent({ kind: "snapshot", rev: l.rev, layout: l, clientId: "" });
}

beforeEach(() => {
  calls.length = 0;
  answer = () => Promise.resolve({ layout: after, imported: true });
  localStorage.setItem(LEGACY_PANEL_KEY, PANEL);
  localStorage.setItem(LEGACY_BOTTOM_KEY, BOTTOM);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetLayout();
  resetLegacyImport();
  resetShellView();
});

describe("the first-load import", () => {
  it("sends the classic stores' raw strings once, draws from the answer, and leaves both keys", async () => {
    render(<Shell />);
    expect(screen.queryByTestId("pane-grid")).toBeNull();
    act(() => {
      snapshot(before);
    });
    await screen.findByTestId("pane-grid");
    expect(calls).toEqual([[PANEL, BOTTOM]]);
    expect(useLayoutStore.getState()).toMatchObject({ legacyImported: true, rev: 5 });
    expect(useLayoutStore.getState().threads["s-1"]?.remembered).toHaveLength(1);
    expect(localStorage.getItem(LEGACY_PANEL_KEY)).toBe(PANEL);
    expect(localStorage.getItem(LEGACY_BOTTOM_KEY)).toBe(BOTTOM);
    // The import's own delta (rev 5) and later events change nothing about it: no second call.
    act(() => {
      applyLayoutEvent({ kind: "delta", rev: 5, delta: { spaces: [], removedSpaceIds: [], spaceOrder: ["sp-a"], currentSpaceId: "sp-a", defaultSpaceId: "sp-a", threads: [], removedThreadIds: [], legacyImported: true }, clientId: "" });
    });
    await act(() => runLegacyImport());
    expect(calls).toHaveLength(1);
  });

  it("does not call when the daemon's layout says it ran (a second window, a second launch)", async () => {
    render(<Shell />);
    act(() => {
      snapshot({ ...before, legacyImported: true });
    });
    await screen.findByTestId("pane-grid");
    expect(calls).toEqual([]);
  });

  it("sends empty strings when the classic stores are absent (a fresh install)", async () => {
    localStorage.clear();
    snapshot(before);
    await runLegacyImport();
    expect(calls).toEqual([["", ""]]);
  });

  it("keeps the layout the stream is already past, with the mark", async () => {
    snapshot({ ...before, rev: 9, spaces: [space(pane("p-1", [tab("t-th", "thread", "s-2")]), "p-1")] });
    answer = () => Promise.resolve({ layout: after, imported: false });
    await runLegacyImport();
    expect(useLayoutStore.getState()).toMatchObject({ rev: 9, legacyImported: true });
    expect(useLayoutStore.getState().tabs["t-th"]).toBeDefined();
  });

  it("a failure says what happened; Try again runs it again and draws", async () => {
    answer = () => Promise.reject(new Error("unavailable: the daemon is restarting"));
    render(<Shell />);
    act(() => {
      snapshot(before);
    });
    expect((await screen.findByTestId("shell-notice")).getAttribute("data-notice")).toBe("import-failed");
    expect(screen.getByTestId("shell-notice-error").textContent).toContain("the daemon is restarting");
    expect(screen.queryByTestId("pane-grid")).toBeNull();
    expect(useShellViewStore.getState().mode).toBe("waiting");
    answer = () => Promise.resolve({ layout: after, imported: true });
    fireEvent.click(screen.getByTestId("shell-import-retry"));
    await screen.findByTestId("pane-grid");
    expect(screen.queryByTestId("shell-notice")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("Open without them draws the layout as it is, the mark unset for the next launch", async () => {
    answer = () => Promise.reject(new Error("boom"));
    render(<Shell />);
    act(() => {
      snapshot(before);
    });
    await screen.findByTestId("shell-notice");
    fireEvent.click(screen.getByTestId("shell-import-skip"));
    await screen.findByTestId("pane-grid");
    expect(useLayoutStore.getState().legacyImported).toBe(false);
    expect(useLegacyImportStore.getState().phase).toBe("skipped");
    expect(calls).toHaveLength(1);
  });
});

describe("importSettled", () => {
  it.each([
    [false, false, "idle", false],
    [false, true, "done", false],
    [true, false, "idle", false],
    [true, false, "running", false],
    [true, false, "failed", false],
    [true, false, "done", true],
    [true, false, "skipped", true],
    [true, true, "idle", true],
  ] as const)("loaded %s, imported %s, %s: %s", (loaded, imported, phase, want) => {
    expect(importSettled(loaded, imported, phase)).toBe(want);
  });
});

describe("readLegacyStores", () => {
  it("reads both raw values, and empty strings for absent keys or blocked storage", () => {
    expect(readLegacyStores()).toEqual({ panelJson: PANEL, bottomJson: BOTTOM });
    expect(readLegacyStores({ getItem: () => null })).toEqual({ panelJson: "", bottomJson: "" });
    expect(
      readLegacyStores({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual({ panelJson: "", bottomJson: "" });
    expect(readLegacyStores(null)).toEqual({ panelJson: "", bottomJson: "" });
  });
});
