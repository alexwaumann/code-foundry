/**
 * A drop's verbs and where the keyboard goes after them (shell/spaceActions.ts runGridDrop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const ran: string[] = [];
/** The verbs the daemon refuses. */
let refused = new Set<string>();
/** The focused pane the daemon's commit leaves. */
let focusAfter = "";
vi.mock("@/shell/commands", () => ({
  runLayoutCommand: async (name: string) => {
    ran.push(name);
    if (refused.has(name)) return null;
    await seedLayout(layoutOf([space(row("s-r", [pane("p-a", [tab("t-a", "prs")]), pane("p-b", [tab("t-b", "prs")])]), focusAfter)], 2));
    return { rev: 2, changed: true };
  },
  afterRev: () => Promise.resolve(),
}));

const { runGridDrop } = await import("./spaceActions");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");

const request = () => useShellViewStore.getState().focusRequest;

beforeEach(async () => {
  ran.length = 0;
  refused = new Set();
  focusAfter = "p-b";
  resetLayout();
  resetShellView();
  await seedLayout(layoutOf([space(row("s-r", [pane("p-a", [tab("t-a", "prs"), tab("t-b", "prs")])]), "p-a")]));
});

afterEach(() => {
  resetLayout();
  resetShellView();
});

describe("runGridDrop", () => {
  it("after the drop lands, asks the pane it focused for the keyboard (the dragged tab's node went with it)", async () => {
    await runGridDrop([{ name: "tab.move", args: { tab: "t-b", split: "right" } }]);
    expect(ran).toEqual(["tab.move"]);
    expect(request()).toEqual({ paneId: "p-b", seq: 1 });
  });

  it("a refused drop asks nothing", async () => {
    refused = new Set(["tab.move"]);
    await runGridDrop([{ name: "tab.move", args: { tab: "t-b", split: "right" } }]);
    expect(request().seq).toBe(0);
  });
});
