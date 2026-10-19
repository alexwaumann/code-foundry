/**
 * The layout containers (docs/notes/plugins-layout-1-columns-pane.md): when columns sit
 * side by side and how they degrade, pane heights, and what "fill" fills when nested.
 * jsdom has no layout: a fake geometry gives each element (by data-key, or the surface's
 * scroll area) a top, a height and a width, and the ResizeObserver stub re-measures on
 * demand. The nodes render in the surface's frame (SurfaceFrame) inside the panel's body,
 * so "the scroll area" is the surface's own, between its toolbar and footer
 * (chrome.test.tsx has fill with strips).
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnData, ViewNode } from "@/api/plugin";
import type { ThreadView } from "@/api/threads";
import { emptyContext } from "@/stores/context";
import { useThreadsStore } from "@/stores/threads";
import { ViewContext, type ViewCtx } from "./context";
import { FILL_BOTTOM, FILL_MIN, fillBoxOf, fillHeight } from "./height";
import { COLUMN_GAP, COLUMN_MIN_WIDTH, columnStyle, columnsMinWidth, columnWeight, shownColumns, sideBySide } from "./layout";
import { useInlineLiveStore } from "./live";
import { NodeList } from "./NodeList";
import { SurfaceFrame } from "./SurfaceFrame";

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/thread:s-1", plugin: "hello", viewTab: "layout", uiContext: emptyContext, inert: false };

/** Each fake element's box: top (page coordinates), height, width. */
interface Box {
  top: number;
  height: number;
  width: number;
}
let boxes: Record<string, Box> = {};
let observers: (() => void)[] = [];

function boxOf(el: Element): Box | undefined {
  if (el.getAttribute("data-testid") === "plugin-scroll") return boxes["scroll-root"];
  if (el.hasAttribute("data-scroll-root")) return boxes.panel;
  const key = el.getAttribute("data-key");
  return key === null ? undefined : boxes[key];
}

beforeEach(() => {
  boxes = {};
  observers = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const b = boxOf(this) ?? { top: 0, height: 0, width: 0 };
    return { top: b.top, bottom: b.top + b.height, left: 0, right: b.width, width: b.width, height: b.height, x: 0, y: b.top, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return boxOf(this)?.height ?? 0;
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
  useInlineLiveStore.setState({ holders: [], waiting: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useInlineLiveStore.setState({ holders: [], waiting: [] });
});

/** The nodes inside the surface's scroll area, as the panel draws them. */
function inSurface(children: ReactNode) {
  return render(
    <ViewContext.Provider value={ctx}>
      <div data-scroll-root>
        <SurfaceFrame top={null} toolbar={[]} footer={[]}>
          {children}
        </SurfaceFrame>
      </div>
    </ViewContext.Provider>,
  );
}

/** Every ResizeObserver fires (the boxes changed). */
function resize(): void {
  act(() => {
    for (const o of [...observers]) o();
  });
}

const text = (key: string): ViewNode => ({ key, text: { content: key } });
const col = (key: string, extra: Partial<ColumnData> = {}, children: ViewNode[] = [text(`${key}-t`)]): ColumnData => ({ key, children, ...extra });
const columns = (items: ColumnData[], collapse?: "stack" | "first"): ViewNode => ({ key: "cols", columns: { items, ...(collapse ? { collapse } : {}) } });

function layoutOf(): string | null {
  return screen.getByTestId("plugin-columns").getAttribute("data-layout");
}
function shownKeys(): (string | null)[] {
  return screen.getAllByTestId("plugin-column").map((c) => c.getAttribute("data-key"));
}

describe("columns: the rule", () => {
  it("needs 240 px a column (a wider fixed one its width) and 12 px gaps", () => {
    expect(COLUMN_MIN_WIDTH).toBe(240);
    expect(COLUMN_GAP).toBe(12);
    expect(columnsMinWidth([col("a"), col("b")])).toBe(492);
    expect(columnsMinWidth([col("a"), col("b"), col("c"), col("d")])).toBe(4 * 240 + 3 * 12);
    expect(columnsMinWidth([col("a", { width: 160 }), col("b", { weight: 3 })])).toBe(240 + 240 + 12);
    expect(columnsMinWidth([col("a", { width: 640 }), col("b", { width: 400 })])).toBe(1052);
  });

  it("is side by side from the minimum up, stacked below it and before the first measure", () => {
    const items = [col("a"), col("b")];
    expect(sideBySide(null, items)).toBe(false);
    expect(sideBySide(491, items)).toBe(false);
    expect(sideBySide(492, items)).toBe(true);
    expect(sideBySide(1200, items)).toBe(true);
    // The side panel (about 360 px) always stacks, narrow fixed columns too.
    expect(sideBySide(360, [col("a", { weight: 2 }), col("b")])).toBe(false);
    expect(sideBySide(491, [col("a", { width: 160 }), col("b", { width: 160 })])).toBe(false);
    expect(sideBySide(492, [col("a", { width: 160 }), col("b", { width: 160 })])).toBe(true);
    // One column (a view the daemon refuses) never goes side by side.
    expect(sideBySide(2000, [col("a")])).toBe(false);
  });

  it("shows every column side by side; stacked, every one (stack) or the first (first)", () => {
    const data = { items: [col("a"), col("b"), col("c")] };
    expect(shownColumns(data, true).map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(shownColumns(data, false).map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(shownColumns({ ...data, collapse: "stack" }, false).map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(shownColumns({ ...data, collapse: "first" }, false).map((c) => c.key)).toEqual(["a"]);
    expect(shownColumns({ ...data, collapse: "first" }, true).map((c) => c.key)).toEqual(["a", "b", "c"]);
  });

  it("sizes a fixed column exactly and a weighted one by weight, never under 240 px", () => {
    expect(columnStyle(col("a", { width: 320 }))).toEqual({ flex: "0 0 320px", width: 320, minWidth: 0 });
    expect(columnStyle(col("a", { weight: 3 }))).toEqual({ flex: "3 1 0px", minWidth: 240 });
    expect(columnStyle(col("a"))).toEqual({ flex: "1 1 0px", minWidth: 240 });
    // Out of range (refused by the daemon) is weight 1.
    for (const weight of [0, 7, -1, 1.5]) expect(columnWeight(col("a", { weight }))).toBe(1);
  });
});

describe("columns: rendered", () => {
  it("stacks in the panel and goes side by side when its own width fits, following resizes", () => {
    boxes.cols = { top: 0, height: 100, width: 360 };
    inSurface(<NodeList nodes={[columns([col("a", { weight: 2 }), col("b", { width: 200 })])]} />);
    expect(layoutOf()).toBe("stack");
    expect(screen.getByTestId("plugin-columns").className).toContain("flex-col");
    expect(screen.getByTestId("plugin-columns").className).toContain("gap-3");
    expect(shownKeys()).toEqual(["a", "b"]);
    expect(screen.getAllByTestId("plugin-column")[0]?.getAttribute("style")).toBeNull();
    // The page: 240 + 240 (a 200 px column needs 240) + 12 = 492 fits.
    boxes.cols = { top: 0, height: 100, width: 492 };
    resize();
    expect(layoutOf()).toBe("row");
    const [a, b] = screen.getAllByTestId("plugin-column");
    expect(a?.style.flex).toBe("2 1 0px");
    expect(a?.style.minWidth).toBe("240px");
    expect(b?.style.flex).toBe("0 0 200px");
    expect(screen.getByTestId("plugin-columns").className).toContain("gap-3");
    // Narrowed again (the panel resized): stacked.
    boxes.cols = { top: 0, height: 100, width: 491 };
    resize();
    expect(layoutOf()).toBe("stack");
  });

  it("collapse first shows only the first column where they stack, all where they fit", () => {
    boxes.cols = { top: 0, height: 100, width: 360 };
    inSurface(<NodeList nodes={[columns([col("summary"), col("detail", { weight: 2 })], "first")]} />);
    expect(screen.getByTestId("plugin-columns").getAttribute("data-collapse")).toBe("first");
    expect(shownKeys()).toEqual(["summary"]);
    expect(screen.queryByText("detail-t")).toBeNull();
    boxes.cols = { top: 0, height: 100, width: 900 };
    resize();
    expect(shownKeys()).toEqual(["summary", "detail"]);
    expect(screen.getByText("detail-t")).toBeTruthy();
  });

  it("keeps the last width while hidden (zero) instead of stacking", () => {
    boxes.cols = { top: 0, height: 100, width: 900 };
    inSurface(<NodeList nodes={[columns([col("a"), col("b")])]} />);
    expect(layoutOf()).toBe("row");
    boxes.cols = { top: 0, height: 0, width: 0 };
    resize();
    expect(layoutOf()).toBe("row");
  });

  it("stacks like the list around it: 6 px apart inside a section, its columns' nodes too", () => {
    boxes.cols = { top: 0, height: 100, width: 300 };
    inSurface(<NodeList nodes={[{ key: "s", section: { title: "S", children: [columns([col("a", {}, [text("a1"), text("a2")]), col("b")])] } }]} />);
    const node = screen.getByTestId("plugin-columns");
    expect(node.className).toContain("gap-1.5");
    expect(screen.getAllByTestId("plugin-column")[0]?.firstElementChild?.className).toContain("gap-1.5");
  });

  it("nests: a section in a column, columns in a pane, nodes reach every level", () => {
    boxes.outer = { top: 0, height: 100, width: 1000 };
    boxes.inner = { top: 0, height: 100, width: 600 };
    inSurface(
      <NodeList
        nodes={[
          {
            key: "outer",
            columns: {
              items: [
                col("o1", {}, [{ key: "sec", section: { title: "Inside", children: [{ key: "p", pane: { height: 300, children: [{ key: "inner", columns: { items: [col("i1"), col("i2")] } }] } }] } }]),
                col("o2"),
              ],
            },
          },
        ]}
      />,
    );
    const all = screen.getAllByTestId("plugin-columns");
    expect(all.map((c) => [c.getAttribute("data-key"), c.getAttribute("data-layout")])).toEqual([
      ["outer", "row"],
      ["inner", "row"],
    ]);
    for (const t of ["i1-t", "i2-t", "o2-t"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByTestId("plugin-pane").closest('[data-testid="plugin-section"]')).not.toBeNull();
  });
});

describe("pane heights", () => {
  const pane = (key: string, data: Partial<NonNullable<ViewNode["pane"]>>, children: ViewNode[] = [text(`${key}-t`)]): ViewNode => ({ key, pane: { children, ...data } });
  const el = (key: string) => document.querySelector<HTMLElement>(`[data-testid="plugin-pane"][data-key="${key}"]`);

  it("auto is as tall as its nodes (at least minHeight), not a fill box, and does not clip", () => {
    inSurface(<NodeList nodes={[pane("p", {}), pane("q", { height: "auto", minHeight: 200 })]} />);
    const p = el("p");
    expect(p?.getAttribute("data-height")).toBe("auto");
    expect(p?.style.height).toBe("");
    expect(p?.hasAttribute("data-fill-box")).toBe(false);
    expect(p?.className).not.toContain("overflow");
    expect(el("q")?.style.minHeight).toBe("200px");
  });

  it("px is that height, a fill box, scrolling inside unless noScroll (then cut)", () => {
    inSurface(<NodeList nodes={[pane("p", { height: 320 }), pane("q", { height: 200, noScroll: true })]} />);
    const p = el("p");
    expect(p?.style.height).toBe("320px");
    expect(p?.getAttribute("data-fill-box")).toBe("true");
    expect(p?.className).toContain("overflow-y-auto");
    expect(p?.getAttribute("data-scroll")).toBe("true");
    expect(el("q")?.className).toContain("overflow-hidden");
    expect(el("q")?.className).not.toContain("overflow-y-auto");
    expect(el("q")?.getAttribute("data-scroll")).toBe("false");
  });

  it("fill at the top level is the rest of the scroll area below it, at least 240 px or its minHeight", () => {
    boxes["scroll-root"] = { top: 0, height: 900, width: 360 };
    boxes.p = { top: 200, height: 0, width: 360 };
    inSurface(<NodeList nodes={[pane("p", { height: "fill" })]} />);
    expect(el("p")?.style.height).toBe(`${String(900 - 200 - FILL_BOTTOM)}px`);
    expect(el("p")?.getAttribute("data-fill-box")).toBe("true");
    // Little room left: the floor.
    boxes.p = { top: 800, height: 0, width: 360 };
    resize();
    expect(el("p")?.style.height).toBe(`${String(FILL_MIN)}px`);
    cleanup();
    inSurface(<NodeList nodes={[pane("p", { height: "fill", minHeight: 400 })]} />);
    expect(el("p")?.style.height).toBe("400px");
    cleanup();
    inSurface(<NodeList nodes={[pane("p", { height: "fill", minHeight: 120 })]} />);
    expect(el("p")?.style.height).toBe("120px");
  });

  it("fill inside a px pane is the rest of that pane below it, with no bottom space", () => {
    boxes["scroll-root"] = { top: 0, height: 2000, width: 800 };
    boxes.outer = { top: 100, height: 600, width: 800 };
    boxes.inner = { top: 250, height: 0, width: 800 };
    inSurface(<NodeList nodes={[pane("outer", { height: 600 }, [text("above"), pane("inner", { height: "fill", minHeight: 120 })])]} />);
    expect(el("inner")?.style.height).toBe("450px");
  });

  it("fill inside a fill pane follows the outer one as the scroll area resizes", () => {
    boxes["scroll-root"] = { top: 0, height: 1000, width: 800 };
    boxes.outer = { top: 100, height: 884, width: 800 };
    boxes.inner = { top: 140, height: 0, width: 800 };
    inSurface(<NodeList nodes={[pane("outer", { height: "fill" }, [text("above"), pane("inner", { height: "fill" })])]} />);
    expect(el("outer")?.style.height).toBe("884px");
    expect(el("inner")?.style.height).toBe("844px");
    boxes["scroll-root"] = { top: 0, height: 700, width: 800 };
    boxes.outer = { top: 100, height: 584, width: 800 };
    resize();
    expect(el("outer")?.style.height).toBe("584px");
    expect(el("inner")?.style.height).toBe("544px");
  });

  it("fill inside an auto pane looks past it to the scroll area", () => {
    boxes["scroll-root"] = { top: 0, height: 800, width: 360 };
    boxes.inner = { top: 300, height: 0, width: 360 };
    inSurface(<NodeList nodes={[pane("outer", {}, [pane("inner", { height: "fill" })])]} />);
    expect(el("inner")?.style.height).toBe(`${String(800 - 300 - FILL_BOTTOM)}px`);
  });

  it("a thread with fill in a px pane in a column fills the pane below its top; floor 240", () => {
    useThreadsStore.setState({ loaded: true, byId: { "s-a": { id: "s-a", owner: "plugin:hello", worktreePath: "/h", state: "disconnected", status: "idle", archivedAtMs: null } as ThreadView }, order: [], owned: ["s-a"] });
    boxes["scroll-root"] = { top: 0, height: 2000, width: 1000 };
    boxes.cols = { top: 0, height: 700, width: 1000 };
    boxes.chat = { top: 100, height: 600, width: 500 };
    boxes.th = { top: 140, height: 0, width: 500 };
    inSurface(
      <NodeList nodes={[columns([col("left", {}, [pane("chat", { height: 600, noScroll: true }, [text("hint"), { key: "th", thread: { threadId: "s-a", readOnly: true, height: "fill" } }])]), col("right")])]} />,
    );
    expect(layoutOf()).toBe("row");
    const th = screen.getByTestId("plugin-thread");
    expect(th.style.height).toBe("560px");
    boxes.th = { top: 600, height: 0, width: 500 };
    resize();
    expect(th.style.height).toBe(`${String(FILL_MIN)}px`);
  });
});

describe("fill boxes", () => {
  it("is the nearest sized pane, else the scroll area; the scroll area leaves its bottom padding", () => {
    expect(fillHeight(900, 200)).toBe(684);
    expect(fillHeight(600, 150, 240, 0)).toBe(450);
    expect(fillHeight(600, 500, 120, 0)).toBe(120);
    expect(fillHeight(600.6, 0.2, 240, 0)).toBe(600);
    const root = document.createElement("div");
    root.setAttribute("data-scroll-root", "");
    const pane = document.createElement("div");
    pane.setAttribute("data-fill-box", "true");
    const auto = document.createElement("div");
    const leaf = document.createElement("div");
    root.append(pane);
    pane.append(auto);
    auto.append(leaf);
    expect(fillBoxOf(leaf)).toEqual({ box: pane, bottom: 0 });
    // A pane never fills itself: it looks from its parent.
    expect(fillBoxOf(pane)).toEqual({ box: root, bottom: FILL_BOTTOM });
    expect(fillBoxOf(root)).toBeNull();
  });
});
