/** A table's meter cells (docs/notes/plugin-table-meter.md): the fill, its tone, the label, the meter role, and the label going into a tooltip in a narrow column. */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewNode } from "@/api/plugin";
import type { TableData } from "@/api/pluginTable";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { hoverTooltipText } from "@/test/tooltip";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/global", viewTab: "run-list", uiContext: emptyContext, inert: false };

/** The table box's outer width (jsdom has no layout). */
let boxWidth = 386;
let observers: ((entries: unknown[]) => void)[] = [];

const suites = demoView("run-list").nodes.find((n) => n.key === "suites") as ViewNode & { table: TableData };

function show(node: ViewNode = suites) {
  return render(
    <ViewContext.Provider value={ctx}>
      <NodeList nodes={[node]} />
    </ViewContext.Provider>,
  );
}

function resize(w: number) {
  boxWidth = w;
  act(() => {
    // The tooltip's floating-ui observer reads its entries.
    for (const o of observers) o([]);
  });
}

const meterOf = (row: string) => {
  const r = screen.getAllByTestId("plugin-table-row").find((el) => el.dataset.key === row);
  if (!r) throw new Error(`no row ${row}`);
  return within(r).getByRole("meter");
};

beforeEach(() => {
  boxWidth = 386;
  observers = [];
  usePluginSurfacesStore.setState({ watches: { w: { instance: "hello/demo/global", version: 1 } } } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.dataset.testid === "plugin-table-box" ? boxWidth : 0;
    return { top: 0, bottom: 28, left: 0, right: w, width: w, height: 28, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: (entries: unknown[]) => void;
      constructor(cb: (entries: unknown[]) => void) {
        this.cb = cb;
      }
      observe(): void {
        observers.push(this.cb);
      }
      unobserve(): void {}
      disconnect(): void {
        observers = observers.filter((o) => o !== this.cb);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {}, collapsed: {} } as never);
});

describe("a meter cell", () => {
  it("is a meter: its value as a percentage, its label as the value text", () => {
    show();
    const m = meterOf("su-integration");
    expect(m.getAttribute("aria-valuenow")).toBe("86");
    expect(m.getAttribute("aria-valuemin")).toBe("0");
    expect(m.getAttribute("aria-valuemax")).toBe("100");
    expect(m.getAttribute("aria-valuetext")).toBe("86%");
    expect(meterOf("su-fuzz").getAttribute("aria-valuenow")).toBe("38");
    expect(meterOf("su-fuzz").getAttribute("aria-valuetext")).toBe("3 of 8");
  });

  it("fills to its value in its tone's colour, neutral without one; 0 draws the empty track and anything above at least 2 px", () => {
    show();
    const fill = (row: string) => within(meterOf(row)).getByTestId("plugin-meter-fill");
    expect(fill("su-unit").style.width).toBe("100%");
    expect(fill("su-unit").className).toContain("bg-cf-success");
    expect(fill("su-integration").style.width).toBe("86%");
    expect(fill("su-integration").className).toContain("bg-cf-warning");
    expect(fill("su-e2e").className).toContain("bg-cf-error");
    expect(fill("su-bench").className).toContain("bg-cf-text-muted");
    expect(fill("su-fuzz").className).toContain("bg-cf-text/55");
    expect(fill("su-fuzz").style.minWidth).toBe("2px");
    expect(fill("su-lint").style.width).toBe("0%");
    expect(fill("su-lint").style.minWidth).toBe("0px");
    expect(within(meterOf("su-lint")).getByTestId("plugin-meter-track").className).toContain("bg-cf-text/10");
  });

  it("shows its label after the track in the side panel, in the caption role with tabular figures, and the track has no tooltip", () => {
    show();
    const m = meterOf("su-e2e");
    const label = within(m).getByTestId("plugin-meter-label");
    expect(label.textContent).toBe("41%");
    expect(label.className).toMatch(/\btext-caption\b/);
    expect(label.className).toContain("tabular-nums");
    expect(within(m).getByTestId("plugin-meter-track").hasAttribute("data-tip")).toBe(false);
    expect(screen.getAllByTestId("plugin-meter-label").map((l) => l.textContent)).toEqual(["100%", "86%", "41%", "3 of 8", "1 of 5", "–"]);
  });

  it("drops the label in a narrow column and keeps the track, its tooltip then the whole label", async () => {
    show();
    // 280 px panel: the box is 246 px, Pass rate 71 px wide, under the 96 px the label needs.
    resize(246);
    expect(screen.queryAllByTestId("plugin-meter-label")).toEqual([]);
    expect(screen.getAllByTestId("plugin-meter-track")).toHaveLength(6);
    const m = meterOf("su-fuzz");
    expect(m.getAttribute("aria-valuetext")).toBe("3 of 8");
    expect(await hoverTooltipText(within(m).getByTestId("plugin-meter-track"))).toBe("3 of 8");
    resize(386);
    expect(screen.getAllByTestId("plugin-meter-label")).toHaveLength(6);
  });

  it("has no value text or tooltip without a label", () => {
    show({ key: "t", table: { columns: [{ key: "c", label: "Share" }], rows: [{ key: "r", cells: { c: { meter: { value: 0.5 } } } }] } });
    resize(120);
    const m = meterOf("r");
    expect(m.hasAttribute("aria-valuetext")).toBe(false);
    expect(within(m).queryByTestId("plugin-meter-label")).toBeNull();
    expect(within(m).getByTestId("plugin-meter-track").hasAttribute("data-tip")).toBe(false);
  });

  it("is the cell's whole content: no value, glyph or pill drawn beside it", () => {
    show({ key: "t", table: { columns: [{ key: "c", label: "Share" }], rows: [{ key: "r", cells: { c: { meter: { value: 0.5, label: "half" } } } }] } });
    const cell = meterOf("r").parentElement as HTMLElement;
    expect(cell.dataset.col).toBe("c");
    expect(cell.children).toHaveLength(1);
  });
});
