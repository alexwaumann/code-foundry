/**
 * Grid, divider, spacer and group (docs/notes/plugins-layout-2-grid-inline.md): the grid's
 * column formula and spans, how it stacks, the flex spacer's box rule, and the inline
 * group. jsdom has no layout: a fake geometry gives each element (by data-key) a width, and
 * the ResizeObserver stub re-measures on demand.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridItemData, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { ViewContext, type ViewCtx } from "./context";
import { GRID_GAP, GRID_MAX_COLUMNS, GRID_MAX_SPAN, GRID_MIN_WIDTH, GROUP_GAP, SPACER_SIZE, gridColumns, gridMinWidth, gridSpan, spacerSize } from "./layout";
import { NodeList } from "./NodeList";

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/thread:s-1", version: 1, plugin: "hello", viewTab: "layout", uiContext: emptyContext, inert: false };

let widths: Record<string, number> = {};
let observers: (() => void)[] = [];

beforeEach(() => {
  widths = {};
  observers = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = widths[this.getAttribute("data-key") ?? ""] ?? 0;
    return { top: 0, bottom: 0, left: 0, right: w, width: w, height: 0, x: 0, y: 0, toJSON: () => ({}) };
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
});

function inView(children: ReactNode) {
  return render(<ViewContext.Provider value={ctx}>{children}</ViewContext.Provider>);
}

/** Every ResizeObserver fires (the widths changed). */
function resize(): void {
  act(() => {
    for (const o of [...observers]) o();
  });
}

const text = (key: string): ViewNode => ({ key, text: { content: key } });
const item = (key: string, extra: Partial<GridItemData> = {}, children: ViewNode[] = [text(`${key}-t`)]): GridItemData => ({ key, children, ...extra });
const grid = (items: GridItemData[], minWidth?: number): ViewNode => ({ key: "g", grid: { items, ...(minWidth === undefined ? {} : { minWidth }) } });

function gridEl(): HTMLElement {
  return screen.getByTestId("plugin-grid");
}
function spans(): (string | null)[] {
  return screen.getAllByTestId("plugin-grid-item").map((i) => i.getAttribute("data-span"));
}

describe("grid: the formula", () => {
  it("fits floor((width + 12) / (minWidth + 12)) columns, at least 1 and at most 6", () => {
    expect([GRID_MIN_WIDTH, GRID_GAP, GRID_MAX_COLUMNS, GRID_MAX_SPAN]).toEqual([240, 12, 6, 2]);
    expect(gridColumns(null, 240)).toBe(1);
    expect(gridColumns(0, 240)).toBe(1);
    expect(gridColumns(239, 240)).toBe(1);
    // The side panel at its default width: one column, at the default and at 160 px.
    expect(gridColumns(328, 240)).toBe(1);
    expect(gridColumns(328, 160)).toBe(1);
    expect(gridColumns(491, 240)).toBe(1);
    expect(gridColumns(492, 240)).toBe(2);
    expect(gridColumns(743, 240)).toBe(2);
    expect(gridColumns(744, 240)).toBe(3);
    expect(gridColumns(332, 160)).toBe(2);
    expect(gridColumns(412, 200)).toBe(2);
    expect(gridColumns(411, 200)).toBe(1);
    expect(gridColumns(6 * 160 + 5 * 12, 160)).toBe(6);
    expect(gridColumns(4000, 160)).toBe(6);
    expect(gridColumns(4000, 480)).toBe(6);
    expect(gridColumns(2 * 480 + 12, 480)).toBe(2);
  });

  it("takes minWidth in 160..480, else 240", () => {
    expect(gridMinWidth({ items: [] })).toBe(240);
    expect(gridMinWidth({ items: [], minWidth: 160 })).toBe(160);
    expect(gridMinWidth({ items: [], minWidth: 480 })).toBe(480);
    expect(gridMinWidth({ items: [], minWidth: 159 })).toBe(240);
    expect(gridMinWidth({ items: [], minWidth: 481 })).toBe(240);
    expect(gridMinWidth({ items: [], minWidth: Number.NaN })).toBe(240);
  });

  it("spans 1 or 2 columns, never more than there are", () => {
    expect(gridSpan(item("a"), 3)).toBe(1);
    expect(gridSpan(item("a", { span: 2 }), 3)).toBe(2);
    expect(gridSpan(item("a", { span: 2 }), 1)).toBe(1);
    expect(gridSpan(item("a", { span: 3 }), 6)).toBe(1);
    expect(gridSpan(item("a", { span: 0 }), 6)).toBe(1);
    expect(gridSpan(item("a", { span: 1.5 }), 6)).toBe(1);
  });
});

describe("grid: rendered", () => {
  it("stacks before it is measured and in one column, like the list around it", () => {
    inView(<NodeList nodes={[grid([item("a"), item("b", { span: 2 })])]} />);
    expect(gridEl().getAttribute("data-columns")).toBe("1");
    expect(gridEl().className).toContain("flex-col");
    expect(gridEl().className).toContain("gap-3");
    expect(gridEl().style.gridTemplateColumns).toBe("");
    // One column: the span-2 item spans it.
    expect(spans()).toEqual(["1", "1"]);
    widths.g = 328;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("1");
    expect(gridEl().getAttribute("data-width")).toBe("328");
  });

  it("stacks 6 px apart inside a section, like the section's nodes", () => {
    inView(<NodeList nodes={[{ key: "s", section: { children: [grid([item("a"), item("b")])] } }]} inner />);
    expect(gridEl().className).toContain("gap-1.5");
  });

  it("goes to columns as it widens and back as it narrows; items span up to 2", () => {
    inView(<NodeList nodes={[grid([item("a"), item("b", { span: 2 }), item("c"), item("d")])]} />);
    widths.g = 744;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("3");
    expect(gridEl().className).toContain("grid");
    expect(gridEl().className).toContain("gap-3");
    expect(gridEl().style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(spans()).toEqual(["1", "2", "1", "1"]);
    const b = screen.getAllByTestId("plugin-grid-item")[1];
    expect(b?.style.gridColumn).toBe("span 2 / span 2");
    expect(screen.getAllByTestId("plugin-grid-item")[0]?.style.gridColumn).toBe("");
    widths.g = 2400;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("6");
    widths.g = 500;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("2");
    widths.g = 360;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("1");
    expect(spans()).toEqual(["1", "1", "1", "1"]);
    expect(b?.style.gridColumn).toBe("");
  });

  it("uses its minWidth, and keeps the last width while hidden", () => {
    inView(<NodeList nodes={[grid([item("a"), item("b"), item("c")], 160)]} />);
    widths.g = 332;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("2");
    widths.g = 0;
    resize();
    expect(gridEl().getAttribute("data-columns")).toBe("2");
  });

  it("stretches an item's only node to the row in columns, not several", () => {
    const card: ViewNode = { key: "card", section: { card: true, title: "Card", children: [text("in")] } };
    inView(<NodeList nodes={[grid([item("a", {}, [card]), item("b", {}, [text("b1"), text("b2")])])]} />);
    const lists = () => screen.getAllByTestId("plugin-grid-item").map((i) => i.firstElementChild?.className ?? "");
    expect(lists().every((c) => !c.includes("only-child"))).toBe(true);
    widths.g = 600;
    resize();
    expect(lists().every((c) => c.includes("grow") && c.includes("[&>:only-child]:grow"))).toBe(true);
    expect(screen.getByTestId("plugin-section").closest('[data-testid="plugin-grid-item"]')?.getAttribute("data-key")).toBe("a");
  });

  it("draws an empty grid and items without nodes", () => {
    inView(<NodeList nodes={[grid([]), { key: "g2", grid: { items: [item("e", {}, [])] } }]} />);
    expect(screen.getAllByTestId("plugin-grid")).toHaveLength(2);
    expect(screen.getAllByTestId("plugin-grid-item")).toHaveLength(1);
  });

  it("holds containers and walks into them: columns in a grid item, a grid in a pane", () => {
    const cols: ViewNode = { key: "cols", columns: { items: [{ key: "c1", children: [text("c1t")] }, { key: "c2", children: [] }] } };
    inView(<NodeList nodes={[{ key: "p", pane: { height: 300, children: [grid([item("a", {}, [cols])])] } }]} />);
    expect(screen.getByTestId("plugin-columns").closest('[data-testid="plugin-grid"]')).not.toBeNull();
    expect(screen.getByTestId("plugin-grid").closest('[data-testid="plugin-pane"]')).not.toBeNull();
  });
});

describe("divider", () => {
  it("is a hairline, or a centred overline label between two", () => {
    inView(<NodeList nodes={[{ key: "d1", divider: {} }, { key: "d2", divider: { label: "Checks" } }, { key: "d3", divider: { label: "   " } }]} />);
    const [bare, labelled, blank] = screen.getAllByTestId("plugin-divider");
    expect(bare?.getAttribute("data-slot")).toBe("separator");
    expect(bare?.className).toContain("h-px");
    expect(bare?.getAttribute("role")).toBe("none");
    expect(labelled?.getAttribute("data-label")).toBe("Checks");
    expect(labelled?.querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
    const label = screen.getByTestId("plugin-divider-label");
    expect(label.textContent).toBe("Checks");
    expect(label.className).toContain("text-overline");
    expect(label.className).toContain("truncate");
    // A blank label is a bare hairline.
    expect(blank?.getAttribute("data-slot")).toBe("separator");
  });
});

describe("spacer", () => {
  const spacer = (key: string, extra: { size?: number; flex?: boolean } = {}): ViewNode => ({ key, spacer: extra });
  const byKey = (key: string) => screen.getAllByTestId("plugin-spacer").find((s) => s.getAttribute("data-key") === key);

  it("is size px (4..64, else 12) on top of the list's gap", () => {
    expect(SPACER_SIZE).toBe(12);
    expect([spacerSize({}), spacerSize({ size: 4 }), spacerSize({ size: 64 }), spacerSize({ size: 3 }), spacerSize({ size: 65 }), spacerSize({ size: 7.5 })]).toEqual([12, 4, 64, 12, 12, 12]);
    inView(
      <>
        <NodeList nodes={[text("a"), spacer("s1"), text("b"), spacer("s2", { size: 40 })]} />
        <NodeList nodes={[text("c"), spacer("s3", { size: 4 })]} inner />
      </>,
    );
    expect([byKey("s1")?.style.height, byKey("s2")?.style.height, byKey("s3")?.style.height]).toEqual(["12px", "40px", "4px"]);
    // It takes back one gap: 12 px at the top level, 6 px inside a section.
    expect(byKey("s1")?.className).toContain("-mt-3");
    expect(byKey("s3")?.className).toContain("-mt-1.5");
    expect(byKey("s1")?.className).toContain("first:mt-0");
    expect(byKey("s1")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("flexes in its box's own list: the surface's and a px or fill pane's", () => {
    inView(
      <NodeList
        nodes={[
          spacer("top", { flex: true }),
          { key: "px", pane: { height: 300, children: [text("t"), spacer("in-px", { flex: true, size: 20 }), text("bar")] } },
          { key: "fill", pane: { height: "fill", children: [spacer("in-fill", { flex: true })] } },
        ]}
        box
      />,
    );
    for (const k of ["top", "in-px", "in-fill"]) {
      expect(byKey(k)?.getAttribute("data-flex")).toBe("true");
      expect(byKey(k)?.className).toContain("grow");
      expect(byKey(k)?.style.height).toBe("");
    }
    expect(byKey("in-px")?.style.minHeight).toBe("20px");
    // The lists grow to their boxes so the spacer has room to take.
    const pane = screen.getAllByTestId("plugin-pane")[0];
    expect(pane?.firstElementChild?.getAttribute("data-box-list")).toBe("true");
    expect(pane?.firstElementChild?.className).toContain("grow");
  });

  it("is its fixed size anywhere else: a section, an auto pane, a column, a grid item, a list that is no box", () => {
    inView(
      <>
        <NodeList
          nodes={[
            { key: "s", section: { children: [spacer("in-section", { flex: true })] } },
            { key: "auto", pane: { children: [spacer("in-auto", { flex: true })] } },
            { key: "cols", columns: { items: [{ key: "c1", children: [spacer("in-column", { flex: true })] }, { key: "c2", children: [] }] } },
            grid([item("a", {}, [spacer("in-grid", { flex: true })])]),
            { key: "px", pane: { height: 300, children: [{ key: "s2", section: { children: [spacer("in-section-in-px", { flex: true })] } }] } },
          ]}
          box
        />
        <NodeList nodes={[spacer("no-box", { flex: true, size: 30 })]} />
      </>,
    );
    for (const k of ["in-section", "in-auto", "in-column", "in-grid", "in-section-in-px", "no-box"]) {
      expect(byKey(k)?.getAttribute("data-flex")).toBeNull();
      expect(byKey(k)?.className).not.toContain("grow");
    }
    expect(byKey("no-box")?.style.height).toBe("30px");
    expect(screen.getAllByTestId("plugin-pane").find((p) => p.getAttribute("data-key") === "auto")?.firstElementChild?.getAttribute("data-box-list")).toBeNull();
  });
});

describe("group", () => {
  const group = (items: ViewNode[], extra: { align?: "start" | "center" | "end" | "between"; noWrap?: boolean } = {}): ViewNode => ({ key: "grp", group: { items, ...extra } });
  const bar: ViewNode = { key: "bar", actions: { buttons: [{ key: "go", label: "Go", action: { event: "go" } }] } };
  const chips: ViewNode = { key: "ch", chips: { chips: [{ key: "c1", label: "Build", status: "ok" }] } };
  const progress: ViewNode = { key: "pr", progress: { value: 0.5 } };

  it("lays its items on one wrapping line, 8 px apart, centred vertically", () => {
    expect(GROUP_GAP).toBe(8);
    inView(<NodeList nodes={[group([text("t"), chips, bar, progress])]} />);
    const g = screen.getByTestId("plugin-group");
    expect(g.getAttribute("role")).toBe("group");
    for (const c of ["flex", "gap-2", "items-center", "flex-wrap", "justify-start"]) expect(g.className.split(" ")).toContain(c);
    expect([g.getAttribute("data-align"), g.getAttribute("data-wrap")]).toEqual(["start", "true"]);
    const items = screen.getAllByTestId("plugin-group-item");
    expect(items.map((i) => i.getAttribute("data-key"))).toEqual(["t", "ch", "bar", "pr"]);
    expect(items[0]?.querySelector('[data-testid="plugin-text"]')).not.toBeNull();
    expect(items[1]?.querySelector('[data-testid="plugin-chips"]')).not.toBeNull();
    expect(items[2]?.querySelector('[data-testid="plugin-button"]')).not.toBeNull();
    expect(items[3]?.querySelector('[data-testid="plugin-progress"]')).not.toBeNull();
    // Content-wide items; the progress bar takes the free width, at least 160 px.
    expect(items[0]?.className).toContain("shrink");
    expect(items[0]?.className).not.toContain("grow");
    expect(items[3]?.className).toContain("grow");
    expect(items[3]?.className).toContain("basis-40");
  });

  it("aligns start, center, end or between, and does not wrap with noWrap", () => {
    const want = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" } as const;
    for (const [align, cls] of Object.entries(want) as [keyof typeof want, string][]) {
      inView(<NodeList nodes={[group([text("t")], { align })]} />);
      expect(screen.getByTestId("plugin-group").className).toContain(cls);
      expect(screen.getByTestId("plugin-group").getAttribute("data-align")).toBe(align);
      cleanup();
    }
    inView(<NodeList nodes={[group([text("t"), bar], { noWrap: true })]} />);
    const g = screen.getByTestId("plugin-group");
    expect(g.className).toContain("flex-nowrap");
    expect(g.getAttribute("data-wrap")).toBe("false");
  });

  it("draws an unknown align as start, an empty group, and a kind the daemon would refuse", () => {
    inView(<NodeList nodes={[{ key: "g1", group: { items: [text("t")], align: "middle" as "start" } }, { key: "g2", group: { items: [] } }, { key: "g3", group: { items: [{ key: "x" }] } }]} />);
    expect(screen.getAllByTestId("plugin-group")[0]?.className).toContain("justify-start");
    expect(screen.getAllByTestId("plugin-group")[1]?.children).toHaveLength(0);
    expect(screen.getByTestId("plugin-unknown-node")).toBeTruthy();
  });
});
