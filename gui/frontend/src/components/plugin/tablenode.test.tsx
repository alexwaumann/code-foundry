/** The table node (docs/notes/plugin-table.md): columns by width, sort acts, group collapse, the truncation tooltip, row actions and menus. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { it, trackTests } from "@/test/isolate";
import type { ActRequestView, ViewNode } from "@/api/plugin";
import type { TableData } from "@/api/pluginTable";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { tooltipText } from "@/test/tooltip";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";

interface Host {
  acts: ActRequestView[];
  refuse: boolean;
  copies: string[];
}
const host: Host = vi.hoisted((): Host => ({ acts: [], refuse: false, copies: [] }));

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    host.acts.push(req);
    return host.refuse ? Promise.reject(new Error("plugin refused")) : Promise.resolve(2);
  }),
}));

vi.mock("@/stores/pluginSurfaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/pluginSurfaces")>()),
  copyElementText: vi.fn((text: string) => {
    host.copies.push(text);
    return Promise.resolve();
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/global", viewTab: "run-list", uiContext: emptyContext, inert: false };

/** The table box's outer width (jsdom has no layout). */
let boxWidth = 1102;
let observers: (() => void)[] = [];

function nodes(list: ViewNode[], c: ViewCtx = ctx) {
  return render(
    <ViewContext.Provider value={c}>
      <NodeList nodes={list} />
    </ViewContext.Provider>,
  );
}

function resize(w: number) {
  boxWidth = w;
  act(() => {
    for (const o of observers) o();
  });
}

/** Lets an act's promise and Radix's menu close land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const demo = demoView("run-list").nodes;
const builds = demo.find((n) => n.key === "builds") as ViewNode & { table: TableData };
const tests = demo.find((n) => n.key === "tests") as ViewNode;

function table(t: Partial<TableData>, key = "t"): ViewNode {
  return { key, table: { columns: [{ key: "c-name", label: "Name" }, { key: "c-n", label: "N", width: 40, align: "end", sortable: true }], ...t } };
}

const headers = (scope: HTMLElement) => [...scope.querySelectorAll("[data-col]")].filter((el) => el.closest("[data-testid=plugin-table-row]") === null).map((el) => el.textContent);
const actKeys = (): string[] => host.acts.map((a: ActRequestView) => a.key);
const actPairs = (): string[] => host.acts.map((a: ActRequestView) => `${a.key} ${a.value ?? ""}`);
const rowKeys = () => screen.queryAllByTestId("plugin-table-row").map((r) => r.dataset.key);

// A test that times out under load must not run on into the next (src/test/isolate.ts).
trackTests();

beforeEach(() => {
  host.acts.length = 0;
  host.refuse = false;
  host.copies.length = 0;
  boxWidth = 1102;
  observers = [];
  usePluginSurfacesStore.setState({ watches: { w: { instance: "hello/demo/global", version: 1 } } } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.dataset.testid === "plugin-table-box" ? boxWidth : 0;
    return { top: 0, bottom: 28, left: 0, right: w, width: w, height: 28, x: 0, y: 0, toJSON: () => ({}) };
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
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {}, collapsed: {} } as never);
});

describe("the columns a table shows", () => {
  it("follow its width: every column and the buttons expanded; at the side panel's width the least important dropped and the buttons folded", () => {
    nodes([builds]);
    const box = screen.getByTestId("plugin-table-box");
    expect(headers(box)).toEqual(["#", "Status", "Branch", "Cause", "Started by", "Duration", "Age"]);
    expect(box.dataset.folded).toBeUndefined();
    const failed = screen.getAllByTestId("plugin-table-row").find((r) => r.dataset.key === "b-1285") as HTMLElement;
    expect(within(failed).getByRole("button", { name: "Rerun" })).toBeTruthy();
    expect(failed.querySelectorAll("[data-col]")).toHaveLength(7);

    resize(370);
    expect(headers(box)).toEqual(["#", "Branch", "Duration", "Age"]);
    expect(box.dataset.folded).toBe("true");
    expect(within(failed).queryByRole("button", { name: "Rerun" })).toBeNull();
    // A dropped column's cells are not in the DOM.
    expect([...failed.querySelectorAll("[data-col]")].map((c) => (c as HTMLElement).dataset.col)).toEqual(["b-num", "b-branch", "b-dur", "b-age"]);
  });

  it("draws a cell's glyph, value and pill, the heading and count, and end-aligned columns", () => {
    nodes([builds]);
    expect(screen.getByRole("heading").textContent).toBe("Builds(1288)");
    const first = screen.getAllByTestId("plugin-table-row")[0] as HTMLElement;
    expect(first.dataset.key).toBe("b-1288");
    const num = first.querySelector("[data-col=b-num]") as HTMLElement;
    expect(num.querySelector("[data-status=running]")).not.toBeNull();
    expect(num.textContent).toBe("#1288");
    expect((first.querySelector("[data-col=b-status] [data-testid=plugin-pill]") as HTMLElement).textContent).toBe("running");
    const dur = first.querySelector("[data-col=b-dur]") as HTMLElement;
    expect(dur.className).toContain("justify-end");
    expect(dur.className).toContain("text-code");
    expect((first.querySelector("[data-col=b-age]") as HTMLElement).className).toContain("text-caption");
  });

  it("shows the empty text without rows, and nothing in the box without one", () => {
    nodes([table({ rows: [], emptyText: "No builds yet" })]);
    expect(screen.getByTestId("plugin-table-empty").textContent).toBe("No builds yet");
    cleanup();
    nodes([table({})]);
    expect(screen.queryByTestId("plugin-table-empty")).toBeNull();
    expect(headers(screen.getByTestId("plugin-table-box"))).toEqual(["Name", "N"]);
  });

  it("shows a cut cell whole in its tooltip, and an uncut one has none", () => {
    nodes([table({ rows: [{ key: "r1", cells: { "c-name": "A rather long name for a narrow column" } }, { key: "r2", cells: { "c-name": "Short" } }] })]);
    const [long, short] = [...document.querySelectorAll<HTMLElement>("[data-testid=plugin-table-row] [data-col=c-name] .truncate")];
    if (!long || !short) throw new Error("no cells");
    for (const [el, w] of [[long, 180], [short, 100]] as const) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
      Object.defineProperty(el, "scrollWidth", { configurable: true, value: w });
      el.style.overflowX = "hidden";
      el.tabIndex = 0; // tooltipText opens it on keyboard focus
    }
    expect(tooltipText(long)).toBe("A rather long name for a narrow column");
    act(() => {
      long.blur();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tooltipText(short)).toBeNull();
  });
});

describe("sorting", () => {
  it("a header click sends a sort act with the column and the direction it asks for; the host never sorts", async () => {
    nodes([builds]);
    const before = rowKeys();
    // A header's button by its column and name. A by-role query over the whole table costs
    // seconds in jsdom, which a slow machine turned into this test's timeout.
    const header = (col: string, name: string) => {
      const cell = screen.getByTestId("plugin-table-box").querySelector(`[data-col=${col}]`) as HTMLElement;
      return within(cell).getByRole("button", { name });
    };
    fireEvent.click(header("b-dur", "Sort by Duration"));
    await settle();
    expect(host.acts).toEqual([expect.objectContaining({ key: "b-dur", action: "sort", value: "desc" })]);
    expect(rowKeys()).toEqual(before);
    // The sorted column (the asked one, while the plugin has not answered) asks for its
    // other direction; an unsorted one for its first.
    fireEvent.click(header("b-dur", "Duration, sorted descending"));
    fireEvent.click(header("b-branch", "Sort by Branch"));
    fireEvent.click(header("b-num", "Sort by #"));
    await settle();
    expect(actPairs().slice(1)).toEqual(["b-dur asc", "b-branch asc", "b-num desc"]);
  });

  it("draws the view's arrow, the asked one while the plugin has not answered, and goes back when it refuses", async () => {
    const r = nodes([builds]);
    const num = () => screen.getByTestId("plugin-table-box").querySelector("[data-col=b-num]") as HTMLElement;
    const dur = () => screen.getByTestId("plugin-table-box").querySelector("[data-col=b-dur]") as HTMLElement;
    expect([num().dataset.sort, dur().dataset.sort]).toEqual(["desc", undefined]);
    fireEvent.click(within(dur()).getByRole("button"));
    expect([num().dataset.sort, dur().dataset.sort]).toEqual([undefined, "desc"]);
    await settle();
    // The plugin's view sorted by duration.
    const sorted = { ...builds, table: { ...builds.table, sort: { column: "b-dur", dir: "desc" as const } } };
    r.rerender(
      <ViewContext.Provider value={ctx}>
        <NodeList nodes={[sorted]} />
      </ViewContext.Provider>,
    );
    expect([num().dataset.sort, dur().dataset.sort]).toEqual([undefined, "desc"]);
    expect(dur().querySelector("svg")).not.toBeNull();
    host.refuse = true;
    fireEvent.click(within(num()).getByRole("button"));
    expect(num().dataset.sort).toBe("desc");
    await settle();
    expect([num().dataset.sort, dur().dataset.sort]).toEqual([undefined, "desc"]);
  });

  it("is inert while the plugin is down, and only sortable headers are buttons", () => {
    nodes([builds], { ...ctx, inert: true });
    const head = screen.getByTestId("plugin-table-box").firstElementChild as HTMLElement;
    expect(within(head).getAllByRole("button").map((b) => b.textContent)).toEqual(["#", "Branch", "Duration"]);
    fireEvent.click(within(head).getByRole("button", { name: "Sort by Branch" }));
    expect(host.acts).toEqual([]);
    expect(within(head).getByRole("button", { name: "Sort by Branch" })).toHaveProperty("disabled", true);
  });
});

describe("groups", () => {
  it("label each run of rows with its count; a collapsed one's rows are not drawn; a click toggles it, and the toggle outlives the next view", () => {
    const r = nodes([tests]);
    const labels = () => screen.getAllByTestId("plugin-table-group").map((g) => `${g.textContent}${g.getAttribute("aria-expanded") === "true" ? "" : " ▸"}`);
    expect(labels()).toEqual(["Failed2", "Flaky1", "Passed142 ▸"]);
    expect(rowKeys()).toEqual(["t-TestCleanupKeepsDirty", "t-TestWorktreeRemoveRace", "t-TestWatchReconnects"]);
    fireEvent.click(screen.getByRole("button", { name: /Passed/ }));
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    expect(labels()).toEqual(["Failed2 ▸", "Flaky1", "Passed142"]);
    expect(rowKeys()).toHaveLength(1 + 8);
    // A new view (the plugin rendered again): the user's toggles stay.
    r.rerender(
      <ViewContext.Provider value={ctx}>
        <NodeList nodes={[structuredClone(tests)]} />
      </ViewContext.Provider>,
    );
    expect(labels()).toEqual(["Failed2 ▸", "Flaky1", "Passed142"]);
    expect(host.acts).toEqual([]);
  });

  it("keeps toggles per view tab", () => {
    nodes([tests], { ...ctx, viewTab: "other" });
    expect(screen.getAllByTestId("plugin-table-group").map((g) => g.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
  });
});

describe("a row's action and menu", () => {
  const failed = () => screen.getAllByTestId("plugin-table-row").find((r) => r.dataset.key === "b-1285") as HTMLElement;
  const entries = (menu: HTMLElement) =>
    [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute("role") === "separator" ? "---" : el.textContent));

  it("a click or Enter runs the row's action", () => {
    nodes([builds]);
    fireEvent.click(failed());
    fireEvent.keyDown(failed(), { key: "Enter" });
    expect(actKeys()).toEqual(["b-1285", "b-1285"]);
  });

  it("a right-click opens its menu with the folded buttons first; a pick acts with the item's key", async () => {
    nodes([builds]);
    resize(370);
    fireEvent.contextMenu(failed());
    const menu = screen.getByTestId("plugin-row-menu");
    expect(entries(menu)).toEqual(["Rerun", "---", "Rebuild", "Open console", "---", "Open in CI", "Copy link"]);
    fireEvent.click(menu.querySelector('[data-key="b-1285-console"]') as HTMLElement);
    await settle();
    expect(actKeys()).toEqual(["b-1285-console"]);
  });

  it("wide, the ⋯ holds only the menu and the button acts on its own (not the row's click)", async () => {
    nodes([builds]);
    fireEvent.pointerDown(within(failed()).getByRole("button", { name: "More options" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(entries(screen.getByTestId("plugin-more-menu"))).toEqual(["Rebuild", "Open console", "---", "Open in CI", "Copy link"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    fireEvent.click(within(failed()).getByRole("button", { name: "Rerun" }));
    await settle();
    expect(actKeys()).toEqual(["b-1285-rerun"]);
  });

  it("a row without a menu or buttons has no ⋯ and no right-click menu; one without an action is not focusable", () => {
    nodes([table({ rows: [{ key: "r1", cells: { "c-name": "One" } }] })]);
    const row = screen.getByTestId("plugin-table-row");
    expect(within(row).queryByRole("button", { name: "More options" })).toBeNull();
    expect(row.tabIndex).toBe(-1);
    fireEvent.contextMenu(row);
    expect(screen.queryByTestId("plugin-row-menu")).toBeNull();
  });

  it("shows a selected row selected", () => {
    nodes([table({ rows: [{ key: "r1", selected: true, action: { event: "open" } }, { key: "r2" }] })]);
    const [a, b] = screen.getAllByTestId("plugin-table-row");
    expect([a?.dataset.selected, a?.getAttribute("aria-pressed"), b?.dataset.selected]).toEqual(["true", "true", undefined]);
  });
});
