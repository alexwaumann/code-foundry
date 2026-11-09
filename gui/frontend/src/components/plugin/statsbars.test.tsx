/** The stats and bars nodes (docs/notes/plugin-stats-bars.md): layout by width, tones, toggles, the bar tooltip and keys, and which acts run. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, ViewNode } from "@/api/plugin";
import type { Bar } from "@/api/pluginCharts";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";

const acts: ActRequestView[] = [];

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.push(req);
    return Promise.resolve();
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "p/s/global", plugin: "p", viewTab: "", uiContext: emptyContext, inert: false };

/** Widths jsdom does not lay out: a stats node's by its key, a bar plot's 300 px. */
let widths: Record<string, number> = {};
let observers: (() => void)[] = [];

function nodes(list: ViewNode[], c: Partial<ViewCtx> = {}) {
  return render(
    <ViewContext.Provider value={{ ...ctx, ...c }}>
      <NodeList nodes={list} />
    </ViewContext.Provider>,
  );
}

function resize(key: string, w: number) {
  widths[key] = w;
  act(() => {
    for (const o of observers) o();
  });
}

beforeEach(() => {
  acts.length = 0;
  widths = {};
  observers = [];
  usePluginSurfacesStore.setState({ watches: { w: { instance: "p/s/global", version: 1 } } } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.dataset.testid === "plugin-bars-plot" ? 300 : (widths[this.dataset.key ?? ""] ?? 0);
    return { top: 0, bottom: 64, left: 0, right: w, width: w, height: 64, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
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
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {} } as never);
});

const statsNode: ViewNode = {
  key: "st",
  stats: {
    cards: [
      { key: "pass", label: "Pass rate", value: "86%", tone: "ok", subtitle: "last 30" },
      { key: "med", label: "Median", value: "4m 12s", subtitle: { spans: [{ text: "p90 " }, { duration: { ms: 361_000 } }] } },
      { key: "fail", label: "Failing", value: "2", tone: "error", action: { event: "filter", data: "failed" } },
      { key: "q", label: "Queue", value: "1", tone: "attention", action: { event: "filter", data: "queue" } },
    ],
  },
};

describe("stats", () => {
  it("lays the cards out in one row when they fit, else balanced rows, with the figure role for the width", () => {
    nodes([statsNode]);
    const grid = screen.getByTestId("plugin-stats");
    resize("st", 1100);
    expect(grid.dataset.columns).toBe("4");
    expect(grid.dataset.role).toBe("text-display-sm");
    expect(screen.getAllByTestId("plugin-stat-value")[0]?.className).toContain("text-display-sm");
    resize("st", 330);
    expect(grid.dataset.columns).toBe("2");
    expect(grid.dataset.role).toBe("text-title");
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("colours each figure by its tone, the Pull Requests cards' tones", () => {
    nodes([statsNode]);
    const tones = screen.getAllByTestId("plugin-stat-value").map((v) => ["text-cf-success-text", "text-cf-warning-text", "text-cf-error-text"].find((c) => v.className.includes(c)) ?? "");
    expect(tones).toEqual(["text-cf-success-text", "", "text-cf-error-text", "text-cf-warning-text"]);
  });

  it("shows label, value and subtitle (a duration formatted by the host)", () => {
    nodes([statsNode]);
    const med = screen.getAllByTestId("plugin-stat")[1];
    expect(med?.textContent).toBe("Median4m 12sp90 6m 1s");
  });

  it("makes a card with an action a toggle that acts on its key; the others stay plain", () => {
    nodes([statsNode]);
    expect(screen.getAllByRole("button").map((b) => b.dataset.key)).toEqual(["fail", "q"]);
    fireEvent.click(screen.getByRole("button", { name: /Failing/ }));
    expect(acts).toEqual([expect.objectContaining({ key: "fail", instance: "p/s/global" })]);
  });

  it("presses the pressed card and dims the other toggles", () => {
    const pressed = structuredClone(statsNode);
    const card = pressed.stats?.cards[2];
    if (card) card.pressed = true;
    nodes([pressed]);
    const fail = screen.getByRole("button", { name: /Failing/ });
    const queue = screen.getByRole("button", { name: /Queue/ });
    expect(fail.getAttribute("aria-pressed")).toBe("true");
    expect(fail.className).toContain("ring-cf-text");
    expect(queue.getAttribute("aria-pressed")).toBe("false");
    expect(queue.className).toContain("opacity-50");
  });

  it("ignores pressed on a card without an action", () => {
    nodes([{ key: "st", stats: { cards: [{ key: "a", label: "A", value: "1", pressed: true }] } }]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("plugin-stat").dataset.pressed).toBeUndefined();
  });

  it("does not act while the plugin is down", () => {
    nodes([statsNode], { inert: true });
    const fail = screen.getByRole("button", { name: /Failing/ });
    expect(fail).toHaveProperty("disabled", true);
    fireEvent.click(fail);
    expect(acts).toEqual([]);
  });
});

const bars: Bar[] = [
  { key: "b1", value: 240, status: "ok", title: "#1 · 4m 00s", meta: "main · 2h ago" },
  { key: "b2", value: 361, status: "failed", title: "#2 · 6m 01s", meta: "cf/fix · 1h ago", action: { event: "open", data: "2" } },
  { key: "b3", value: 0, status: "off", title: "#3 · aborted" },
  { key: "b4", value: 130, status: "running", title: "#4 · running" },
  { key: "b5", value: 200, series: 2, title: "#5" },
];
const barsNode: ViewNode = { key: "ch", bars: { title: "Build time", subtitle: "last 5", bars, reference: { value: 252, label: "median 4m 12s" }, startLabel: "#1", endLabel: "#5" } };

const plot = () => screen.getByTestId("plugin-bars-plot");
const tip = () => screen.queryByTestId("plugin-bar-tip");
/** Points at x px of the 300 px plot (60 px a bar). */
const point = (x: number) => {
  fireEvent.pointerMove(plot(), { clientX: x });
};

describe("bars", () => {
  it("draws the header, the reference line and its label, the axis labels and every bar", () => {
    nodes([barsNode]);
    const card = screen.getByTestId("plugin-bars");
    expect(card.querySelector("h3")?.textContent).toBe("Build time");
    expect(card.textContent).toContain("last 5");
    expect(screen.getByTestId("plugin-bars-reference").textContent).toBe("median 4m 12s");
    expect(screen.getByTestId("plugin-bars-reference-line")).toBeTruthy();
    expect(screen.getByTestId("plugin-bars-axis").textContent).toBe("#1#5");
    const rects = screen.getAllByTestId("plugin-bar");
    expect(rects.map((r) => [r.dataset.key, r.dataset.status ?? `series ${r.dataset.series ?? ""}`])).toEqual([
      ["b1", "ok"],
      ["b2", "failed"],
      ["b3", "off"],
      ["b4", "running"],
      ["b5", "series 2"],
    ]);
    // The tallest bar fills the plot; the zero keeps a stub; running is a dashed outline.
    expect(rects.map((r) => Math.round(Number(r.getAttribute("height"))))).toEqual([43, 64, 2, 23, 35]);
    expect(rects[3]?.getAttribute("stroke-dasharray")).toBe("2 2");
  });

  it("shows one tooltip for the bar under the pointer and dims the others", () => {
    nodes([barsNode]);
    expect(tip()).toBeNull();
    point(70);
    expect(tip()?.dataset.key).toBe("b2");
    expect(screen.getByTestId("plugin-bar-tip-title").textContent).toBe("#2 · 6m 01s");
    expect(tip()?.textContent).toBe("#2 · 6m 01scf/fix · 1h ago");
    const op = screen.getAllByTestId("plugin-bar").map((r) => r.getAttribute("fill-opacity"));
    expect(op[1]).toBe("0.85");
    expect(op[0]).toBe(String(0.85 * 0.4));
    point(290);
    expect(tip()?.dataset.key).toBe("b5");
    expect(tip()?.dataset.side).toBe("left");
    fireEvent.pointerLeave(plot());
    expect(tip()).toBeNull();
    expect(screen.getAllByTestId("plugin-bar").map((r) => r.getAttribute("fill-opacity"))[0]).toBe("0.85");
  });

  it("acts on a click on a bar with an action, not on one without", () => {
    nodes([barsNode]);
    point(10);
    fireEvent.click(plot());
    expect(acts).toEqual([]);
    point(70);
    fireEvent.click(plot());
    expect(acts).toEqual([expect.objectContaining({ key: "b2" })]);
  });

  it("is one tab stop: focus shows the newest bar, arrows and Home/End move, Enter acts", () => {
    nodes([barsNode]);
    expect(plot().tabIndex).toBe(0);
    expect(plot().getAttribute("aria-label")).toBe("Build time: 5 bars");
    act(() => {
      plot().focus();
    });
    expect(tip()?.dataset.key).toBe("b5");
    fireEvent.keyDown(plot(), { key: "ArrowLeft" });
    expect(tip()?.dataset.key).toBe("b4");
    fireEvent.keyDown(plot(), { key: "Home" });
    expect(tip()?.dataset.key).toBe("b1");
    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    expect(tip()?.dataset.key).toBe("b2");
    // The live region reads the highlighted bar.
    expect(document.getElementById(plot().getAttribute("aria-describedby") ?? "")?.textContent).toBe("#2 · 6m 01s, cf/fix · 1h ago");
    fireEvent.keyDown(plot(), { key: "Enter" });
    expect(acts).toEqual([expect.objectContaining({ key: "b2" })]);
    fireEvent.keyDown(plot(), { key: "End" });
    fireEvent.keyDown(plot(), { key: " " });
    expect(acts).toHaveLength(1); // b5 has no action
    act(() => {
      plot().blur();
    });
    expect(tip()).toBeNull();
  });

  it("does not act while the plugin is down", () => {
    nodes([barsNode], { inert: true });
    point(70);
    fireEvent.click(plot());
    expect(acts).toEqual([]);
  });

  it("says so when there are no bars, and takes no focus", () => {
    nodes([{ key: "ch", bars: { title: "Build time", bars: [] } }]);
    expect(screen.getByTestId("plugin-bars-empty").textContent).toBe("No data yet");
    expect(plot().hasAttribute("tabindex")).toBe(false);
    expect(screen.queryByTestId("plugin-bars-axis")).toBeNull();
  });
});

describe("the hello demo's overview", () => {
  it("has the stats row and the build-time chart under its intro", () => {
    nodes(demoView("overview").nodes.slice(0, 3));
    expect(screen.getAllByTestId("plugin-stat").map((c) => c.dataset.key)).toEqual(["stat-pass", "stat-median", "stat-failing", "stat-queue"]);
    expect(screen.getAllByTestId("plugin-bar")).toHaveLength(30);
    expect(screen.getByTestId("plugin-bars-reference").textContent).toBe("median 4m 12s");
  });
});
