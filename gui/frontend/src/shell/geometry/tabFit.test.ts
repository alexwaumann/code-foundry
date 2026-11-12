import { describe, expect, it } from "vitest";
import { rng } from "@/test/shellTrees";
import { TAB_ICON_WIDTH, TAB_MIN_LABEL, fitTabs, type TabLabel } from "./tabFit";

const fit = (widths: number[], active: number, avail: number) => {
  const out = fitTabs({ widths, active, avail });
  return { widths: out.map((t) => t.width), labels: out.map((t) => t.label) };
};

describe("tab fitting", () => {
  const table: { doc: string; widths: number[]; active: number; avail: number; want: number[]; labels: TabLabel[] }[] = [
    {
      doc: "every tab at its natural width when they fit",
      widths: [100, 120, 90],
      active: 1,
      avail: 400,
      want: [100, 120, 90],
      labels: ["full", "full", "full"],
    },
    {
      doc: "the active tab stays whole and the others shorten",
      widths: [200, 200, 200],
      active: 0,
      avail: 400,
      want: [200, 100, 100],
      labels: ["full", "short", "short"],
    },
    {
      doc: "the longest label shortens first",
      widths: [150, 100, 200],
      active: 0,
      avail: 360,
      want: [150, 100, 110],
      labels: ["full", "full", "short"],
    },
    {
      doc: "the active tab shortens only when the others are at their least",
      widths: [400, 100],
      active: 0,
      avail: 300,
      want: [216, 84],
      labels: ["short", "short"],
    },
    {
      doc: "a tab narrower than the least label width keeps its width",
      widths: [60, 300, 300],
      active: 1,
      avail: 300,
      want: [60, 156, 84],
      labels: ["full", "short", "short"],
    },
    {
      doc: "tabs go icon-only farthest from the active tab first, the later of two as far",
      widths: [200, 200, 200, 200, 200],
      active: 2,
      avail: 300,
      want: [26, 84, 138, 26, 26],
      labels: ["icon", "short", "short", "icon", "icon"],
    },
    {
      doc: "the active tab goes icon-only last",
      widths: [200, 200],
      active: 0,
      avail: 60,
      want: [26, 26],
      labels: ["icon", "icon"],
    },
    {
      doc: "when even icons overflow, every tab is an icon",
      widths: [200, 200, 200, 200],
      active: 3,
      avail: 50,
      want: [26, 26, 26, 26],
      labels: ["icon", "icon", "icon", "icon"],
    },
    {
      doc: "with no active tab, all of them share",
      widths: [200, 200],
      active: -1,
      avail: 300,
      want: [150, 150],
      labels: ["short", "short"],
    },
    { doc: "no tabs", widths: [], active: -1, avail: 300, want: [], labels: [] },
  ];

  it.each(table)("$doc", ({ widths, active, avail, want, labels }) => {
    expect(fit(widths, active, avail)).toEqual({ widths: want, labels });
  });

  it("holds its rules on random strips", () => {
    const rand = rng(5);
    for (let n = 0; n < 500; n++) {
      const count = 1 + Math.floor(rand() * 9);
      const widths = Array.from({ length: count }, () => Math.round(40 + rand() * 260));
      const active = Math.floor(rand() * count);
      const avail = Math.round(rand() * 1400);
      const out = fitTabs({ widths, active, avail });
      const total = out.reduce((s, t) => s + t.width, 0);
      const allIcons = out.every((t) => t.label === "icon");
      if (!allIcons || count * TAB_ICON_WIDTH <= avail) expect(total, `strip ${String(n)}`).toBeLessThanOrEqual(avail);
      out.forEach((t, i) => {
        const nat = widths[i] ?? 0;
        if (t.label === "icon") expect(t.width).toBe(TAB_ICON_WIDTH);
        if (t.label === "full") expect(t.width).toBe(nat);
        if (t.label === "short") {
          expect(t.width).toBeLessThan(nat);
          expect(t.width).toBeGreaterThanOrEqual(Math.min(nat, TAB_MIN_LABEL));
        }
      });
      // The active tab is an icon only when every other tab already is.
      if (out[active]?.label === "icon") expect(allIcons, `strip ${String(n)}`).toBe(true);
      // No other tab is wider than the active one unless the active one is whole.
      const a = out[active];
      if (a && a.label !== "full") for (const t of out) expect(t.width).toBeLessThanOrEqual(a.width);
    }
  });
});
