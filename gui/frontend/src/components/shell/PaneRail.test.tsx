import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const calls: [string, string][] = [];
vi.mock("@/shell/commands", () => ({
  focusTabNow: (id: string) => {
    calls.push(["tab.focus", id]);
    return Promise.resolve(true);
  },
  focusPaneNow: () => Promise.resolve(true),
  runLayoutCommand: (name: string, args: Record<string, string>) => {
    calls.push([name, args.tab ?? ""]);
    return Promise.resolve({ rev: 2, changed: true });
  },
}));

const { PaneRail } = await import("./PaneRail");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");

const RECT = { x: 0, y: 0, w: 36, h: 400, rail: true };
const railOf = (active: string) => layoutOf([space(pane("p-1", [tab("t-a", "thread", "s-1"), tab("t-pv", "thread", "s-2", { preview: true })], active), "p-1")]);
const icons = () => screen.getAllByTestId("shell-rail-tab");

beforeEach(async () => {
  calls.length = 0;
  resetLayout();
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Sizes" }, "s-2": { id: "s-2", name: "Reviewer", snoozedUntilMs: 1 } } as never });
  await seedLayout(railOf("t-pv"));
});

afterEach(() => {
  cleanup();
  resetLayout();
});

describe("a preview in a rail (docs/notes/shell-model.md, \"Preview tabs\")", () => {
  it("has a dashed square around its icon, with the accent bar when it is the shown tab; it says it is a preview", () => {
    render(<PaneRail paneId="p-1" rect={RECT} />);
    const [kept, pv] = icons();
    if (!kept || !pv) throw new Error("icons");
    expect(pv.hasAttribute("data-preview")).toBe(true);
    expect(pv.className.split(" ")).toEqual(expect.arrayContaining(["after:border-dashed", "after:border-cf-text-muted/60", "before:bg-cf-accent"]));
    expect(pv.getAttribute("aria-label")).toBe("Reviewer, preview");
    expect(kept.hasAttribute("data-preview")).toBe(false);
    expect(kept.className).not.toContain("after:border-dashed");
    expect(kept.getAttribute("aria-label")).toBe("Sizes");
  });

  it("behind another tab it keeps the dashes, without the bar", async () => {
    await seedLayout(railOf("t-a"));
    render(<PaneRail paneId="p-1" rect={RECT} />);
    const pv = icons()[1];
    expect(pv?.className).toContain("after:border-dashed");
    expect(pv?.className).not.toContain("before:bg-cf-accent");
  });

  it("a double click on its icon keeps it (tab.keep); a kept icon's does not", () => {
    render(<PaneRail paneId="p-1" rect={RECT} />);
    const [kept, pv] = icons();
    if (!kept || !pv) throw new Error("icons");
    fireEvent.doubleClick(kept);
    expect(calls).toEqual([]);
    fireEvent.doubleClick(pv);
    expect(calls).toEqual([["tab.keep", "t-pv"]]);
  });
});
