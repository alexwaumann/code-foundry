/**
 * The view's toolbar and footer, and the container node (docs/notes/plugins-layout-3-chrome.md):
 * the strips' frame and row, a form in a strip (one row, drafts and busy as in the body),
 * the container's widths, and where fill nodes end now that the body scrolls between the
 * strips. jsdom has no layout: a fake geometry gives the panel and the surface's scroll
 * area a height, as layout.test.tsx does.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { draftKeyOf, emptyEntry, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { FILL_BOTTOM } from "./height";
import { CONTAINER_NARROW_WIDTH, CONTAINER_WIDE_WIDTH, containerMaxWidth } from "./layout";
import { NodeList } from "./NodeList";
import { STRIP_KINDS, STRIP_MAX_NODES, stripItemClass } from "./strip";
import { SurfaceFrame } from "./SurfaceFrame";

const acts = vi.hoisted(() => ({ calls: [] as ActRequestView[], resolve: [] as (() => void)[] }));
vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.calls.push(req);
    return new Promise<number>((resolve) => {
      acts.resolve.push(() => {
        resolve(2);
      });
    });
  }),
}));

const INSTANCE = "hello/demo/thread:s-1";
const ctx: ViewCtx = { watchKey: "w", instance: INSTANCE, version: 1, plugin: "hello", viewTab: "layout", uiContext: emptyContext, inert: false };

/** Each fake element's box by data-testid or data-key: top (page coordinates) and height. */
let boxes: Record<string, { top: number; height: number }> = {};
let observers: (() => void)[] = [];

function boxOf(el: Element): { top: number; height: number } | undefined {
  const id = el.getAttribute("data-testid");
  if (id === "plugin-scroll") return boxes.body;
  if (el.hasAttribute("data-scroll-root")) return boxes.panel;
  const key = el.getAttribute("data-key");
  return key === null ? undefined : boxes[key];
}

beforeEach(() => {
  boxes = {};
  observers = [];
  acts.calls = [];
  acts.resolve = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const b = boxOf(this) ?? { top: 0, height: 0 };
    return { top: b.top, bottom: b.top + b.height, left: 0, right: 360, width: 360, height: b.height, x: 0, y: b.top, toJSON: () => ({}) };
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
  usePluginSurfacesStore.setState({ watches: { w: { ...emptyEntry({ plugin: "hello", surface: "demo" }), instance: INSTANCE, version: 1, phase: "live" } } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {} });
});

/** A surface's frame inside the panel's (scrolling) body, as PluginSurface draws it. */
function inPanel(frame: { toolbar?: ViewNode[]; footer?: ViewNode[]; stale?: boolean }, body: ReactNode = null) {
  return render(
    <ViewContext.Provider value={ctx}>
      <div data-scroll-root data-testid="panel-body">
        <SurfaceFrame top={<header data-testid="top">Header</header>} toolbar={frame.toolbar ?? []} footer={frame.footer ?? []} stale={frame.stale ?? false}>
          {body}
        </SurfaceFrame>
      </div>
    </ViewContext.Provider>,
  );
}

const text = (key: string): ViewNode => ({ key, text: { content: key } });
const search = (key = "q", extra: Partial<NonNullable<ViewNode["form"]>> = {}): ViewNode => ({
  key,
  form: {
    fields: [
      { key: `${key}-f`, name: "q", label: "Filter runs", description: "Matches titles", input: { placeholder: "Filter runs" } },
      { key: `${key}-mine`, name: "mine", label: "Mine", toggle: { value: false } },
    ],
    submit: { key: `${key}-go`, label: "Filter", icon: "search", iconOnly: true, action: { event: "filter" } },
    ...extra,
  },
});

function items(strip: "plugin-toolbar" | "plugin-footer"): (string | null)[][] {
  return Array.from(screen.getByTestId(strip).querySelectorAll('[data-testid="plugin-strip-item"]')).map((el) => [el.getAttribute("data-key"), el.getAttribute("data-kind")]);
}

describe("the frame", () => {
  it("pins the top and toolbar above the scrolling body and the footer below it", () => {
    inPanel({ toolbar: [text("t1")], footer: [text("f1")] }, <p data-testid="body">body</p>);
    const frame = screen.getByTestId("panel-body");
    const order = Array.from(frame.children).map((c) => c.getAttribute("data-testid"));
    expect(order).toEqual(["plugin-top", "plugin-scroll", "plugin-footer"]);
    const top = screen.getByTestId("plugin-top");
    expect(top.lastElementChild?.getAttribute("data-testid")).toBe("plugin-toolbar");
    expect(top.className).toContain("shrink-0");
    expect(screen.getByTestId("plugin-footer").className).toContain("shrink-0");
    // The body is the one that scrolls: the surface's own scroll root, inside the panel's.
    const scroll = screen.getByTestId("plugin-scroll");
    expect(scroll.hasAttribute("data-scroll-root")).toBe(true);
    expect(scroll.className).toContain("overflow-auto");
    expect(scroll.className).toContain("flex-1");
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.contains(screen.getByTestId("body"))).toBe(true);
  });

  it("draws a hairline toward the body and the panel's padding; no strip without nodes", () => {
    inPanel({ toolbar: [text("t1")], footer: [text("f1")] });
    const tb = screen.getByTestId("plugin-toolbar").className;
    const ft = screen.getByTestId("plugin-footer").className;
    for (const c of ["border-b", "border-pane-border", "px-4", "py-2", "@max-[340px]:px-3", "bg-pane"]) expect(tb).toContain(c);
    for (const c of ["border-t", "border-pane-border", "px-4", "py-2", "@max-[340px]:px-3", "bg-pane"]) expect(ft).toContain(c);
    expect(tb).not.toContain("border-t");
    expect(ft).not.toContain("border-b");
    cleanup();
    inPanel({});
    expect(screen.queryByTestId("plugin-toolbar")).toBeNull();
    expect(screen.queryByTestId("plugin-footer")).toBeNull();
  });

  it("dims the strips while the plugin is down", () => {
    inPanel({ toolbar: [text("t1")], footer: [text("f1")], stale: true });
    expect(screen.getByTestId("plugin-toolbar").className).toContain("opacity-60");
    expect(screen.getByTestId("plugin-footer").className).toContain("opacity-60");
  });
});

describe("the strips' row", () => {
  it("draws every strip kind in order, at most six", () => {
    const nodes: ViewNode[] = [
      search(),
      { key: "ch", chips: { chips: [{ key: "c1", label: "All", selected: true }] } },
      text("t"),
      { key: "pr", progress: { label: "Syncing" } },
      { key: "bar", actions: { align: "end", buttons: [{ key: "run", label: "Run", action: { event: "run" } }] } },
    ];
    inPanel({ toolbar: nodes, footer: [...nodes.slice(1).map((n) => ({ ...n, key: `f-${n.key}` })), text("f-6"), text("f-7")] });
    expect(items("plugin-toolbar")).toEqual([
      ["q", "form"],
      ["ch", "chips"],
      ["t", "text"],
      ["pr", "progress"],
      ["bar", "actions"],
    ]);
    // The daemon refuses a seventh; the GUI draws no more than six either way.
    expect(items("plugin-footer")).toHaveLength(STRIP_MAX_NODES);
    expect(STRIP_KINDS).toEqual(["text", "chips", "actions", "progress", "form"]);
    const row = screen.getByTestId("plugin-toolbar").firstElementChild?.className ?? "";
    for (const c of ["flex", "flex-wrap", "items-center", "gap-x-2"]) expect(row).toContain(c);
  });

  it("gives a form and a progress bar the free width and sends an end-aligned bar to the end", () => {
    expect(stripItemClass(search())).toContain("flex-1");
    expect(stripItemClass({ key: "p", progress: {} })).toContain("flex-1");
    expect(stripItemClass({ key: "a", actions: { align: "end", buttons: [] } })).toContain("ml-auto");
    expect(stripItemClass({ key: "a", actions: { buttons: [] } })).not.toContain("ml-auto");
    expect(stripItemClass(text("t"))).toBe("min-w-0");
    expect(stripItemClass({ key: "c", chips: { chips: [] } })).toBe("min-w-0");
  });

  it("lays a form out in one row: no visible label or description for a text field, the toggle's label beside it", () => {
    inPanel({ toolbar: [search()] });
    const form = screen.getByTestId("plugin-form");
    expect(form.getAttribute("data-strip")).toBe("true");
    expect(form.className).toContain("flex-wrap");
    expect(form.className).not.toContain("flex-col");
    const input = screen.getByTestId("plugin-input");
    expect(input.getAttribute("placeholder")).toBe("Filter runs");
    // The label still names the input for screen readers.
    expect(screen.getByLabelText("Filter runs")).toBe(input);
    expect(screen.getByText("Filter runs", { selector: "label" }).className).toContain("sr-only");
    expect(screen.queryByText("Matches titles")).toBeNull();
    expect(screen.getByText("Mine", { selector: "label" }).className).not.toContain("sr-only");
    // The same form in the body keeps its column, its label and its description.
    cleanup();
    inPanel({}, <NodeList nodes={[search()]} />);
    expect(screen.getByTestId("plugin-form").getAttribute("data-strip")).toBeNull();
    expect(screen.getByTestId("plugin-form").className).toContain("flex-col");
    expect(screen.getByText("Matches titles")).toBeTruthy();
  });

  it("shows a strip form's errors under the row", () => {
    inPanel({ footer: [search("q", { error: "the backend refused the filter" })] });
    const err = screen.getByTestId("plugin-form-error");
    expect(err.textContent).toBe("the backend refused the filter");
    expect(err.className).toContain("basis-full");
  });

  it("keeps a footer form's drafts per instance and view tab, and locks it while submitting and while busy", async () => {
    inPanel({ footer: [search()] });
    const input = screen.getByTestId<HTMLInputElement>("plugin-input");
    fireEvent.change(input, { target: { value: "fix" } });
    const dk = draftKeyOf(INSTANCE, "layout", "q");
    expect(usePluginSurfacesStore.getState().drafts[dk]).toEqual({ q: "fix" });
    // Enter submits through the plugin, with the draft's values; the form locks until the act returns.
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(acts.calls).toHaveLength(1);
    expect(acts.calls[0]).toMatchObject({ instance: INSTANCE, version: 1, key: "q-go", values: { q: "fix", mine: false } });
    expect(screen.getByTestId("plugin-form").getAttribute("aria-busy")).toBe("true");
    expect(input.disabled).toBe(true);
    await act(async () => {
      acts.resolve[0]?.();
      await Promise.resolve();
    });
    expect(input.disabled).toBe(false);
    // The draft stays until a newer view settles the submit (stores/pluginSurfaces settleSubmits).
    expect(usePluginSurfacesStore.getState().drafts[dk]).toEqual({ q: "fix" });
    expect(usePluginSurfacesStore.getState().submitted[dk]).toBe(1);
    cleanup();
    inPanel({ footer: [search("q", { busy: true })] });
    expect(screen.getByTestId<HTMLInputElement>("plugin-input").disabled).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>("plugin-input").value).toBe("fix");
  });

  it("renders the demo's Layout toolbar and footer", () => {
    const v = demoView("layout");
    inPanel({ toolbar: v.toolbar ?? [], footer: v.footer ?? [] });
    expect(items("plugin-toolbar")).toEqual([
      ["layout-search-form", "form"],
      ["layout-status", "chips"],
    ]);
    expect(items("plugin-footer")).toEqual([
      ["layout-count", "text"],
      ["layout-footer-bar", "actions"],
    ]);
    expect(screen.getByTestId("plugin-toolbar").querySelectorAll('[data-testid="plugin-chip"]')).toHaveLength(4);
    const clear = screen.getByTestId("plugin-footer").querySelector('[data-key="layout-clear"]') as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
  });
});

describe("container", () => {
  it("caps narrow at 680 px and wide at 1080 px, centred; full (or unknown) has no cap", () => {
    expect([containerMaxWidth("narrow"), containerMaxWidth("wide"), containerMaxWidth("full"), containerMaxWidth(undefined)]).toEqual([CONTAINER_NARROW_WIDTH, CONTAINER_WIDE_WIDTH, null, null]);
    expect([CONTAINER_NARROW_WIDTH, CONTAINER_WIDE_WIDTH]).toEqual([680, 1080]);
    inPanel(
      {},
      <NodeList
        nodes={[
          { key: "n", container: { width: "narrow", children: [text("n1")] } },
          { key: "w", container: { width: "wide", children: [text("w1")] } },
          { key: "f", container: { width: "full", children: [text("f1")] } },
          { key: "u", container: { children: [text("u1")] } },
          { key: "x", container: { width: "huge" as "full", children: [] } },
        ]}
      />,
    );
    const all = screen.getAllByTestId("plugin-container");
    expect(all.map((c) => [c.getAttribute("data-key"), c.getAttribute("data-width"), c.style.maxWidth])).toEqual([
      ["n", "narrow", "680px"],
      ["w", "wide", "1080px"],
      ["f", "full", ""],
      ["u", "full", ""],
      ["x", "huge", ""],
    ]);
    for (const c of all) {
      expect(c.className).toContain("mx-auto");
      expect(c.className).toContain("w-full");
    }
    expect(all[0]?.textContent).toBe("n1");
  });

  it("lays its nodes out like the list around it: 12 px at the top level, 6 px in a section", () => {
    inPanel({}, <NodeList nodes={[{ key: "c", container: { width: "narrow", children: [text("a"), text("b")] } }, { key: "s", section: { title: "S", children: [{ key: "c2", container: { children: [text("x")] } }] } }]} />);
    const [top, inSection] = screen.getAllByTestId("plugin-container");
    expect(top?.firstElementChild?.className).toContain("gap-3");
    expect(inSection?.firstElementChild?.className).toContain("gap-1.5");
  });
});

describe("fill between the strips", () => {
  it("fills the body's scroll area, which ends at the footer, not the panel", () => {
    // The panel's body is 900 px; the header, tabs and toolbar take 140 and the footer 48,
    // so the surface's scroll area is 712 px.
    boxes.panel = { top: 0, height: 900 };
    boxes.body = { top: 140, height: 712 };
    boxes.p = { top: 140 + 60, height: 0 };
    inPanel({ toolbar: [text("t")], footer: [text("f")] }, <NodeList nodes={[text("above"), { key: "p", pane: { height: "fill", children: [] } }]} />);
    const pane = document.querySelector<HTMLElement>('[data-key="p"]');
    expect(pane?.style.height).toBe(`${String(712 - 60 - FILL_BOTTOM)}px`);
    // Without strips the scroll area is the panel's height less the header.
    boxes.body = { top: 92, height: 808 };
    boxes.p = { top: 92 + 60, height: 0 };
    act(() => {
      for (const o of [...observers]) o();
    });
    expect(pane?.style.height).toBe(`${String(808 - 60 - FILL_BOTTOM)}px`);
  });
});
