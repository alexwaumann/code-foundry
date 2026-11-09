/**
 * A list's interactive rows in jsdom (docs/notes/plugin-list-rows.md): which act goes with
 * which key, action and value; the change shown at once, kept until a view settles it and
 * dropped when the plugin refuses; alt+↑/↓; the title editor's commit and cancel rules and
 * its conflict with a row's own action; the add input's one-in-flight and clear rules; and
 * a pointer drag's sequence over a faked geometry (the real one is e2e).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, ListData, Row, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { emptyEntry, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";

const acts = vi.hoisted(() => ({ calls: [] as ActRequestView[], settle: [] as ((ok: boolean) => void)[] }));
vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.calls.push(req);
    return new Promise<number>((resolve, reject) => {
      acts.settle.push((ok) => {
        if (ok) resolve(req.version);
        else reject(new Error("plugin refused: no"));
      });
    });
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/thread:s-1", plugin: "hello", viewTab: "todo", uiContext: emptyContext, inert: false };

function setVersion(version: number): void {
  usePluginSurfacesStore.setState((s) => ({ watches: { w: { ...(s.watches.w ?? emptyEntry({ plugin: "hello", surface: "demo" })), instance: ctx.instance, version, phase: "live" } } }));
}

beforeEach(() => {
  acts.calls = [];
  acts.settle = [];
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {}, details: {}, choices: {} });
  setVersion(1);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const base: Row[] = [
  { key: "a", title: "Alpha", editable: true },
  { key: "b", title: "Beta", checked: true },
  { key: "c", title: "Gamma", editable: true, action: { event: "open", data: "c" } },
];

function list(data: Partial<ListData> = {}, rows: Row[] = base): ViewNode {
  return { key: "todo", list: { rows, checkable: true, reorderable: true, add: { placeholder: "Add a task" }, ...data } };
}

function view(node: ViewNode, inert = false) {
  return (
    <ViewContext.Provider value={{ ...ctx, inert }}>
      <NodeList nodes={[node]} />
    </ViewContext.Provider>
  );
}

function rowsShown(): string {
  return screen
    .getAllByTestId("plugin-row")
    .map((r) => `${r.dataset.key ?? ""}${r.dataset.checked ? "✓" : ""}`)
    .join(" ");
}

const row = (key: string) => screen.getAllByTestId("plugin-row").find((r) => r.dataset.key === key) as HTMLElement;
const titleOf = (key: string) => row(key).querySelector('[data-testid="plugin-row-title"]')?.textContent;

async function answer(ok: boolean): Promise<void> {
  await act(async () => {
    acts.settle.shift()?.(ok);
    await Promise.resolve();
  });
}

describe("checkbox", () => {
  it("sends the new state and shows it at once; a refusal goes back", async () => {
    render(view(list()));
    expect(rowsShown()).toBe("a b✓ c");
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[0] as HTMLElement);
    expect(acts.calls).toMatchObject([{ key: "a", action: "check", value: "true", version: 1 }]);
    expect(rowsShown()).toBe("a✓ b✓ c");
    expect(row("a").querySelector(".line-through")).not.toBeNull();
    await answer(false);
    expect(rowsShown()).toBe("a b✓ c");
  });

  it("unticks with false; a row's checkbox never runs the row's action", () => {
    render(view(list()));
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[1] as HTMLElement);
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[2] as HTMLElement);
    expect(acts.calls.map((c) => [c.key, c.action, c.value])).toEqual([
      ["b", "check", "false"],
      ["c", "check", "true"],
    ]);
  });

  it("once taken, the tick stays until a view shows it or a newer view comes", async () => {
    const { rerender } = render(view(list()));
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[0] as HTMLElement);
    await answer(true);
    // The view at the answer does not show it yet: still shown.
    expect(rowsShown()).toBe("a✓ b✓ c");
    // A newer view that disagrees wins.
    setVersion(2);
    rerender(view(list({}, [...base])));
    expect(rowsShown()).toBe("a b✓ c");
  });

  it("a view showing the tick settles it", async () => {
    const { rerender } = render(view(list()));
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[0] as HTMLElement);
    await answer(true);
    rerender(view(list({}, [{ ...(base[0] as Row), checked: true }, ...base.slice(1)])));
    expect(rowsShown()).toBe("a✓ b✓ c");
    // Settled: the plugin unticking it later shows at once.
    setVersion(2);
    rerender(view(list()));
    expect(rowsShown()).toBe("a b✓ c");
  });

  it("an answered change lets go after the hold however the views go", async () => {
    vi.useFakeTimers();
    render(view(list()));
    fireEvent.click(screen.getAllByTestId("plugin-row-check")[0] as HTMLElement);
    await answer(true);
    expect(rowsShown()).toBe("a✓ b✓ c");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(rowsShown()).toBe("a b✓ c");
  });

  it("is disabled while the plugin is down, as is the add input", () => {
    render(view(list({}, [{ key: "a", title: "A" }]), true));
    expect(screen.getByTestId("plugin-row-check")).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "Add a task" })).toHaveProperty("disabled", true);
  });
});

describe("keyboard reorder", () => {
  it("alt+↓ and alt+↑ move the focused row one place and send its new upper neighbour", async () => {
    render(view(list()));
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    expect(acts.calls.at(-1)).toMatchObject({ key: "a", action: "move", value: "b" });
    expect(rowsShown()).toBe("b✓ a c");
    fireEvent.keyDown(row("c"), { key: "ArrowUp", altKey: true });
    expect(acts.calls.at(-1)).toMatchObject({ key: "c", action: "move", value: "b" });
    expect(rowsShown()).toBe("b✓ c a");
    await answer(false);
    // The first move refused: only the second stays (c under b, where it was).
    expect(rowsShown()).toBe("a b✓ c");
  });

  it("does nothing at an end, without alt, or when the list is not reorderable", () => {
    const { rerender } = render(view(list()));
    fireEvent.keyDown(row("a"), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(row("c"), { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(row("b"), { key: "ArrowDown" });
    expect(acts.calls).toEqual([]);
    rerender(view(list({ reorderable: false })));
    fireEvent.keyDown(row("a"), { key: "ArrowDown", altKey: true });
    expect(acts.calls).toEqual([]);
    expect(screen.queryByTestId("plugin-row-grip")).toBeNull();
  });
});

describe("rename in place", () => {
  it("double-click on the title, Enter commits the trimmed text, shown until the view has it", async () => {
    render(view(list()));
    fireEvent.doubleClick(row("a").querySelector('[data-testid="plugin-row-title"] span') as HTMLElement);
    const input = screen.getByTestId("plugin-row-edit");
    expect((input as HTMLInputElement).value).toBe("Alpha");
    fireEvent.change(input, { target: { value: "  Alpha two " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(acts.calls).toMatchObject([{ key: "a", action: "edit", value: "Alpha two" }]);
    expect(screen.queryByTestId("plugin-row-edit")).toBeNull();
    expect(titleOf("a")).toBe("Alpha two");
    await answer(false);
    expect(titleOf("a")).toBe("Alpha");
  });

  it.each([
    ["Escape cancels", (i: HTMLElement) => { fireEvent.change(i, { target: { value: "X" } }); fireEvent.keyDown(i, { key: "Escape" }); }, []],
    ["an empty title commits nothing", (i: HTMLElement) => { fireEvent.change(i, { target: { value: "  " } }); fireEvent.keyDown(i, { key: "Enter" }); }, []],
    ["an unchanged title commits nothing", (i: HTMLElement) => { fireEvent.keyDown(i, { key: "Enter" }); }, []],
    ["leaving the field commits", (i: HTMLElement) => { fireEvent.change(i, { target: { value: "Blurred" } }); fireEvent.blur(i); }, ["Blurred"]],
  ])("%s", (_, go, want) => {
    render(view(list()));
    row("a").focus();
    fireEvent.keyDown(row("a"), { key: "F2" });
    go(screen.getByTestId("plugin-row-edit"));
    expect(acts.calls.map((c) => c.value)).toEqual(want);
    expect(screen.queryByTestId("plugin-row-edit")).toBeNull();
  });

  it("Enter starts it on a row without an action; on a row with one Enter runs it and only F2 renames", () => {
    render(view(list()));
    fireEvent.keyDown(row("a"), { key: "Enter" });
    expect(screen.queryByTestId("plugin-row-edit")).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId("plugin-row-edit"), { key: "Escape" });

    fireEvent.doubleClick(row("c").querySelector('[data-testid="plugin-row-title"] span') as HTMLElement);
    expect(screen.queryByTestId("plugin-row-edit")).toBeNull();
    fireEvent.keyDown(row("c"), { key: "Enter" });
    expect(acts.calls.map((c) => [c.key, c.action])).toEqual([["c", undefined]]);
    expect(screen.queryByTestId("plugin-row-edit")).toBeNull();
    fireEvent.keyDown(row("c"), { key: "F2" });
    expect(screen.getByTestId("plugin-row-edit")).toHaveProperty("value", "Gamma");
  });

  it("a row that is not editable has no editor", () => {
    render(view(list()));
    fireEvent.keyDown(row("b"), { key: "F2" });
    fireEvent.doubleClick(row("b").querySelector('[data-testid="plugin-row-title"] span') as HTMLElement);
    expect(screen.queryByTestId("plugin-row-edit")).toBeNull();
  });
});

describe("add input", () => {
  const input = () => screen.getByRole("textbox", { name: "Add a task" });

  it("Enter sends the trimmed text on the list's key; one at a time; clears once taken", async () => {
    render(view(list()));
    fireEvent.change(input(), { target: { value: "  Buy milk " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(acts.calls).toMatchObject([{ key: "todo", action: "add", value: "Buy milk" }]);
    expect(acts.calls).toHaveLength(1);
    await answer(true);
    expect((input() as HTMLInputElement).value).toBe("");
  });

  it("keeps the text when the plugin refuses, and what was typed meanwhile when it takes", async () => {
    render(view(list()));
    fireEvent.change(input(), { target: { value: "Taken" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await answer(false);
    expect((input() as HTMLInputElement).value).toBe("Taken");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "Taken, and more" } });
    await answer(true);
    expect((input() as HTMLInputElement).value).toBe("Taken, and more");
  });

  it("empty text sends nothing; Escape leaves the input", () => {
    render(view(list()));
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(acts.calls).toEqual([]);
    input().focus();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(document.activeElement).not.toBe(input());
  });

  it("sits above the rows, or below them with bottom; an empty list keeps it", () => {
    const { rerender } = render(view(list()));
    const order = () => [...screen.getByTestId("plugin-list-rows").children].map((c) => c.getAttribute("data-testid") ?? c.firstElementChild?.getAttribute("data-testid"));
    expect(order()).toEqual(["plugin-list-add", "plugin-list"]);
    rerender(view(list({ add: { bottom: true } })));
    expect(order()).toEqual(["plugin-list", "plugin-list-add"]);
    rerender(view(list({ emptyText: "Nothing to do" }, [])));
    expect(screen.getByTestId("plugin-list-empty").textContent).toBe("Nothing to do");
    expect(screen.queryByTestId("plugin-list-add")).not.toBeNull();
  });
});

describe("pointer drag", () => {
  // Rows 30 px tall from y 100 (a, b, c by data-key).
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = ["a", "b", "c"].indexOf(this.dataset.key ?? "");
      const top = i < 0 ? 100 : 100 + i * 30;
      const height = i < 0 ? 90 : 30;
      return { top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  const grip = (key: string) => row(key).querySelector('[data-testid="plugin-row-grip"]') as HTMLElement;

  it("lifts after 4 px, shows the drop line, and the release sends the move", () => {
    render(view(list()));
    fireEvent.pointerDown(grip("a"), { button: 0, clientY: 110 });
    fireEvent.pointerMove(window, { clientY: 112 });
    expect(screen.queryByTestId("plugin-row-lifted")).toBeNull();
    fireEvent.pointerMove(window, { clientY: 170 });
    expect(screen.getByTestId("plugin-row-lifted").getAttribute("data-key")).toBe("a");
    expect(row("a").className).toContain("opacity-35");
    // The line is placed in the viewport over the lifted copy: the box's top (100) plus 60.
    expect(screen.getByTestId("plugin-row-drop").style.top).toBe("160px");
    fireEvent.pointerUp(window, { clientY: 170 });
    expect(acts.calls).toMatchObject([{ key: "a", action: "move", value: "b" }]);
    expect(rowsShown()).toBe("b✓ a c");
    expect(screen.queryByTestId("plugin-row-lifted")).toBeNull();
  });

  it("Escape, a release where it was, or a click on the grip moves nothing and never runs the row's action", () => {
    render(view(list()));
    fireEvent.pointerDown(grip("a"), { button: 0, clientY: 110 });
    fireEvent.pointerMove(window, { clientY: 170 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("plugin-row-lifted")).toBeNull();
    fireEvent.pointerUp(window, { clientY: 170 });
    fireEvent.pointerDown(grip("b"), { button: 0, clientY: 140 });
    fireEvent.pointerMove(window, { clientY: 150 });
    fireEvent.pointerUp(window, { clientY: 150 });
    fireEvent.click(grip("c"));
    expect(acts.calls).toEqual([]);
  });
});

it("the demo's Todo tab renders its lists interactive", () => {
  const v = demoView("todo");
  render(
    <ViewContext.Provider value={ctx}>
      <NodeList nodes={v.nodes} />
    </ViewContext.Provider>,
  );
  expect(screen.getAllByTestId("plugin-row-check").length).toBe(7);
  expect(screen.getAllByTestId("plugin-row-grip").length).toBe(5);
  expect(screen.queryByRole("textbox", { name: "Add a task" })).not.toBeNull();
});
