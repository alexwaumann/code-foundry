import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonthView } from "@/api/gh";
import { ActivityCharts } from "./ActivityCharts";

const SIX: MonthView[] = [
  { month: "2026-10", commits: 16, merged: 2 },
  { month: "2026-09", commits: 463, merged: 38 },
  { month: "2026-08", commits: 210, merged: 17 },
  { month: "2026-07", commits: 96, merged: 9 },
  { month: "2026-06", commits: 0, merged: 0 },
  { month: "2026-05", commits: 41, merged: 3 },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = (k: "merged" | "commits") => within(screen.getByTestId(`activity-${k}`));

describe("ActivityCharts", () => {
  it.each([0, 1, 2, 3, 4, 5, 6])("renders %d months without crashing", (n) => {
    render(<ActivityCharts months={SIX.slice(0, n)} />);
    for (const k of ["merged", "commits"] as const) {
      expect(card(k).queryAllByTestId("activity-marker")).toHaveLength(n);
      expect(card(k).queryAllByTestId("activity-month")).toHaveLength(n);
      expect(card(k).queryByTestId("activity-empty") !== null).toBe(n === 0);
      // The newest closed month and the current one are labelled (activity.test.ts: labelledIndexes).
      expect(card(k).queryAllByTestId("activity-value")).toHaveLength(Math.min(n, 2));
    }
  });

  it("empty: both cards say no stats yet over a zero axis", () => {
    render(<ActivityCharts months={[]} />);
    expect(screen.getAllByText("No stats yet")).toHaveLength(2);
    expect(within(screen.getByTestId("activity-commits")).getByText("0")).toBeDefined();
  });

  it("labels the last closed month and the current one, marked partial; the y axis only at 0 and the top", () => {
    render(<ActivityCharts months={SIX} />);
    const values = (k: "merged" | "commits") => card(k).getAllByTestId("activity-value").map((v) => [v.textContent, v.hasAttribute("data-partial")]);
    expect(values("merged")).toEqual([
      ["38", false],
      ["2", true],
    ]);
    expect(values("commits")).toEqual([
      ["463", false],
      ["16", true],
    ]);
    // Gridlines at 0, 200, 400, 600; labels at 0 and 600 only.
    expect(card("commits").getAllByTestId("activity-tick").map((t) => t.textContent)).toEqual(["0", "600"]);
    expect(card("merged").getAllByTestId("activity-tick").map((t) => t.textContent)).toEqual(["0", "40"]);
    const partial = card("commits")
      .getAllByTestId("activity-marker")
      .filter((m) => m.hasAttribute("data-partial"));
    expect(partial.map((m) => m.getAttribute("data-month"))).toEqual(["2026-10"]);
    expect(card("commits").getAllByTestId("activity-month").map((r) => r.getAttribute("data-month"))).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
  });

  it("hover is shared: both cards get the crosshair, only the hovered one the tooltip", () => {
    render(<ActivityCharts months={SIX} />);
    const aug = card("commits").getAllByTestId("activity-month")[3];
    if (!aug) throw new Error("no August");
    fireEvent.mouseEnter(aug);
    expect(screen.getAllByTestId("activity-crosshair")).toHaveLength(2);
    expect(screen.getAllByTestId("activity-tooltip")).toHaveLength(1);
    const tip = card("commits").getByTestId("activity-tooltip");
    expect(tip.textContent).toBe("August210commits17merged prs");
    expect(tip.getAttribute("data-side")).toBe("left");
    const oct = card("merged").getAllByTestId("activity-month")[5];
    if (!oct) throw new Error("no October");
    fireEvent.mouseEnter(oct);
    expect(card("merged").getByTestId("activity-tooltip").textContent).toContain("October (so far)");
    expect(card("commits").queryByTestId("activity-tooltip")).toBeNull();
  });
});
