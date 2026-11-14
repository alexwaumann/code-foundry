/**
 * cmd+shift+m and the collapse controls in the window (shell/collapse.ts;
 * docs/notes/shell-25d-collapse.md): which verb runs with which args, and where the keyboard goes.
 */
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNodeView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const ran: [string, Record<string, string>][] = [];
/** What the daemon's commit leaves: the focus it hands on. */
let focusAfter = "";
vi.mock("@/shell/commands", () => ({
  runLayoutCommand: async (name: string, args: Record<string, string> = {}) => {
    ran.push([name, args]);
    if (focusAfter) await seedLayout(layoutOf([space(tree(), focusAfter)], 2));
    return { rev: 2, changed: true };
  },
  afterRev: () => Promise.resolve(),
  focusTabNow: () => Promise.resolve(true),
  focusPaneNow: () => Promise.resolve(true),
}));

const { foldAxisOf, isLastOpen, toggleCollapseFocused, whyNoCollapse, collapsePane, openPane } = await import("./collapse");
const { presentShellCommand, resetKeyPresenters } = await import("./keyPresenters");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");
const { resetShellView, setFullscreen, useShellViewStore } = await import("@/stores/shellView");

let folded = new Set<string>();
const p = (id: string): LayoutNodeView => ({ ...pane(id, [tab(`t-${id}`, "prs")]), ...(folded.has(id) ? { collapsed: true } : {}) });
const tree = (): LayoutNodeView => row("s-r", [p("p-a"), { t: "split", id: "s-c", dir: "col", kids: [p("p-b"), p("p-c")], sizes: [0.5, 0.5] }]);

async function seed(focus: string): Promise<void> {
  await act(async () => {
    await seedLayout(layoutOf([space(tree(), focus)]));
  });
}

beforeEach(() => {
  ran.length = 0;
  focusAfter = "";
  folded = new Set();
  resetLayout();
  resetShellView();
  resetKeyPresenters();
});

afterEach(() => {
  resetLayout();
  resetShellView();
});

describe("collapse in the window", () => {
  it("knows the last open pane of a space, and why it cannot collapse", async () => {
    folded = new Set(["p-b", "p-c"]);
    await seed("p-a");
    const s = useLayoutStore.getState();
    expect(isLastOpen(s, "p-a")).toBe(true);
    expect(isLastOpen(s, "p-b")).toBe(false);
    expect(whyNoCollapse(s, "p-a")).toBe("The last open pane of a space cannot be collapsed");
    expect(whyNoCollapse(s, "p-b")).toBe("");
  });

  it("folds a pane in a column to a strip, anywhere else to a rail", async () => {
    await seed("p-a");
    const t = useLayoutStore.getState().trees["sp-a"];
    expect([foldAxisOf(t, "p-a"), foldAxisOf(t, "p-b"), foldAxisOf(t, "p-x")]).toEqual(["row", "col", "row"]);
  });

  it("cmd+shift+m collapses the focused pane, and the keyboard follows the focus the daemon handed on", async () => {
    await seed("p-a");
    focusAfter = "p-c";
    expect(presentShellCommand("pane.collapse")).toBe(true);
    await vi.waitFor(() => {
      expect(useShellViewStore.getState().focusRequest.paneId).toBe("p-c");
    });
    expect(ran).toEqual([["pane.collapse", { pane: "p-a", on: "true" }]]);
  });

  it("cmd+shift+m opens the focused pane when it is collapsed, and the keyboard goes into it", async () => {
    folded = new Set(["p-b"]);
    await seed("p-b");
    focusAfter = "p-b";
    await toggleCollapseFocused();
    expect(ran).toEqual([["pane.collapse", { pane: "p-b", off: "true" }]]);
    expect(useShellViewStore.getState().focusRequest.paneId).toBe("p-b");
  });

  it("does nothing in full screen, as the pane focus and move keys", async () => {
    await seed("p-a");
    setFullscreen("sp-a");
    presentShellCommand("pane.collapse");
    await Promise.resolve();
    expect(ran).toEqual([]);
  });

  it("the strip's control sends nothing for the last open pane; the rail's opens", async () => {
    folded = new Set(["p-b", "p-c"]);
    await seed("p-a");
    await collapsePane("p-a");
    expect(ran).toEqual([]);
    await openPane("p-b");
    expect(ran).toEqual([["pane.collapse", { pane: "p-b", off: "true" }]]);
  });
});
