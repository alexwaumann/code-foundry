/**
 * The renderer defects the showcase plugin's GUI pass found
 * (docs/notes/plugins-12-renderer-defects.md), one test (or more) each.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Field, ViewNode } from "@/api/plugin";
import { useStreamSlotsStore } from "@/api/streamSlots";
import type { ThreadView } from "@/api/threads";
import { emptyContext } from "@/stores/context";
import { chooserKeyOf, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ViewContext, type ViewCtx } from "./context";
import { SurfaceHeader } from "./Header";
import { useInlineLiveStore } from "./live";
import { NodeList } from "./NodeList";

const ctx: ViewCtx = { watchKey: "w", instance: "showcase/gallery/global", plugin: "showcase", viewTab: "forms", uiContext: emptyContext, inert: false };

function inView(children: ReactNode) {
  return render(<ViewContext.Provider value={ctx}>{children}</ViewContext.Provider>);
}

function form(fields: Field[]): ViewNode {
  return { key: "f", form: { fields, submit: { key: "save", label: "Save", action: { event: "save" } } } };
}

function thread(id: string, archived = false): ThreadView {
  return { id, owner: "plugin:showcase", worktreePath: "/h", state: "disconnected", status: "idle", archivedAtMs: archived ? 1 : null } as ThreadView;
}

const selection = useUiStore.getState().selection;

beforeEach(() => {
  useInlineLiveStore.setState({ holders: [], waiting: [] });
});

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {}, details: {}, choices: {} });
  useInlineLiveStore.setState({ holders: [], waiting: [] });
  useStreamSlotsStore.setState({ open: 0, waiting: [] });
  useUiStore.setState({ selection });
  vi.restoreAllMocks();
});

describe("forms", () => {
  it("marks required fields from the first paint (#15)", () => {
    inView(
      <NodeList
        nodes={[
          form([
            { key: "h", name: "handle", label: "Handle", required: true, input: {} },
            { key: "e", name: "email", label: "Email", input: {} },
          ]),
        ]}
      />,
    );
    const fields = screen.getAllByTestId("plugin-field");
    expect(fields[0]?.querySelector('[data-testid="plugin-required"]')).not.toBeNull();
    expect(fields[1]?.querySelector('[data-testid="plugin-required"]')).toBeNull();
    expect(screen.getAllByTestId("plugin-input")[0]?.getAttribute("aria-required")).toBe("true");
    // No error before the user has been there.
    expect(screen.queryByTestId("plugin-field-error")).toBeNull();
  });

  it("keeps an empty dropdown controlled: the placeholder, and cleared again when the plugin's value empties (#3)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const colour = (value: string[]): ViewNode =>
      form([
        {
          key: "c",
          name: "colour",
          label: "Colour",
          select: { placeholder: "Pick a colour", value, options: [{ key: "g", value: "green", label: "Green" }, { key: "r", value: "red", label: "Red" }] },
        },
      ]);
    const r = inView(<NodeList nodes={[colour([])]} />);
    expect(screen.getByTestId("plugin-select").textContent).toContain("Pick a colour");
    r.rerender(
      <ViewContext.Provider value={ctx}>
        <NodeList nodes={[colour(["green"])]} />
      </ViewContext.Provider>,
    );
    expect(screen.getByTestId("plugin-select").textContent).toContain("Green");
    r.rerender(
      <ViewContext.Provider value={ctx}>
        <NodeList nodes={[colour([])]} />
      </ViewContext.Provider>,
    );
    expect(screen.getByTestId("plugin-select").textContent).toContain("Pick a colour");
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => /uncontrolled|controlled/.test(m))).toEqual([]);
  });

  it("draws a multiple select without a style as a dropdown with its placeholder; list keeps checkboxes (#4)", () => {
    const options = [
      { key: "go", value: "go", label: "Go" },
      { key: "ts", value: "ts", label: "TypeScript" },
      { key: "rs", value: "rs", label: "Rust" },
    ];
    inView(
      <NodeList
        nodes={[
          form([
            { key: "l", name: "langs", label: "Languages", select: { multiple: true, placeholder: "Any", options } },
            { key: "t", name: "tags", label: "Tags", select: { multiple: true, style: "list", options } },
          ]),
        ]}
      />,
    );
    const [langs, tags] = screen.getAllByTestId("plugin-select");
    expect(langs?.getAttribute("data-style")).toBe("multi-dropdown");
    expect(langs?.textContent).toContain("Any");
    expect(tags?.getAttribute("data-style")).toBe("checks");
    if (!langs) throw new Error("no select");
    fireEvent.click(langs);
    const list = screen.getByTestId("plugin-select-options");
    const go = list.querySelector('[data-value="go"]');
    const rs = list.querySelector('[data-value="rs"]');
    if (!go || !rs) throw new Error("no options");
    fireEvent.click(go);
    fireEvent.click(rs);
    const dk = `${ctx.instance}\u0000forms\u0000f`;
    expect(usePluginSurfacesStore.getState().drafts[dk]).toEqual({ langs: ["go", "rs"] });
    expect(langs.textContent).toContain("Go, Rust");
  });
});

describe("chips, glyphs and rows", () => {
  it("draws no glyph for a chip without a status, and says which chip is selected (#10, #16)", () => {
    inView(
      <NodeList
        nodes={[
          {
            key: "c",
            chips: {
              chips: [
                { key: "a", label: "no status", selected: true, action: { event: "pick" } },
                { key: "b", label: "pending", status: "pending", action: { event: "pick" } },
              ],
            },
          },
        ]}
      />,
    );
    const [plain, pending] = screen.getAllByTestId("plugin-chip");
    expect(plain?.querySelector("svg")).toBeNull();
    expect(pending?.querySelector("svg")).not.toBeNull();
    expect(plain?.getAttribute("aria-pressed")).toBe("true");
    expect(pending?.getAttribute("aria-pressed")).toBe("false");
  });

  it("draws pending and skipped dots differently (#11)", () => {
    inView(
      <NodeList
        nodes={[
          {
            key: "l",
            list: {
              rows: [
                { key: "p", title: "Status pending", glyph: { status: "pending" } },
                { key: "s", title: "Status skipped", glyph: { status: "skipped" } },
              ],
            },
          },
        ]}
      />,
    );
    const pending = document.querySelector('[data-status="pending"]');
    const skipped = document.querySelector('[data-status="skipped"]');
    expect(pending?.className).toContain("border");
    expect(skipped?.className).not.toContain("border");
    expect(skipped?.firstElementChild).not.toBeNull();
  });

  it("marks selected rows: aria-pressed on clickable rows, aria-current otherwise (#16)", () => {
    inView(
      <NodeList
        nodes={[
          {
            key: "l",
            list: {
              rows: [
                { key: "a", title: "A", selected: true, action: { event: "pick" } },
                { key: "b", title: "B", action: { event: "pick" } },
                { key: "c", title: "C", selected: true },
              ],
            },
          },
        ]}
      />,
    );
    const [a, b, c] = screen.getAllByTestId("plugin-row");
    expect(a?.getAttribute("aria-pressed")).toBe("true");
    expect(b?.getAttribute("aria-pressed")).toBe("false");
    expect(c?.getAttribute("aria-pressed")).toBeNull();
    expect(c?.getAttribute("aria-current")).toBe("true");
  });
});

describe("narrow layouts", () => {
  it("truncates a long button label inside the row instead of overflowing it (#8)", () => {
    const label = "A long label that has to wrap or truncate at 280 px wide panels";
    inView(<NodeList nodes={[{ key: "a", actions: { buttons: [{ key: "long", label, action: { event: "x" } }] } }]} />);
    const b = screen.getByTestId("plugin-button");
    expect(b.className).toContain("max-w-full");
    expect(b.querySelector(".truncate")?.textContent).toBe(label);
  });

  it("caps the pairs' label column and wraps long labels (#12)", () => {
    inView(<NodeList nodes={[{ key: "p", pairs: { items: [{ key: "x", label: "A label that is forty characters long!!!", value: "value" }] } }]} />);
    const dl = screen.getByTestId("plugin-pairs");
    expect(dl.className).toContain("grid-cols-[fit-content(40%)_minmax(0,1fr)]");
    expect(dl.querySelector("dt")?.className).not.toContain("whitespace-nowrap");
  });

  it("clamps the header's sub-line to two lines, not one (#7)", () => {
    render(<SurfaceHeader header={{ title: "Showcase", subline: "A sub-line long enough to need a second line at 280 px" }} fallbackTitle="Showcase" icon="" />);
    const text = screen.getByTestId("plugin-subline-text");
    expect(text.className).toContain("line-clamp-2");
    expect(text.className).not.toContain("truncate");
  });
});

describe("thread nodes", () => {
  it("shows an archived thread read-only with an Archived line (#14)", () => {
    useThreadsStore.setState({ loaded: true, byId: { "s-arch": thread("s-arch", true) }, order: [], owned: ["s-arch"] });
    inView(<NodeList nodes={[{ key: "t", thread: { threadId: "s-arch" } }]} />);
    const node = screen.getByTestId("plugin-thread");
    expect(node.getAttribute("data-read-only")).toBe("true");
    expect(screen.getByTestId("plugin-thread-archived").textContent).toContain("Archived");
  });

  it("holds at most two live inline streams; Attach on the third pauses the oldest (#1b)", () => {
    useThreadsStore.setState({ loaded: true, byId: { a: thread("a"), b: thread("b"), c: thread("c") }, order: [], owned: ["a", "b", "c"] });
    inView(
      <NodeList
        nodes={[
          { key: "ta", thread: { threadId: "a" } },
          { key: "tb", thread: { threadId: "b" } },
          { key: "tc", thread: { threadId: "c" } },
        ]}
      />,
    );
    const live = () => screen.getAllByTestId("plugin-thread").map((n) => n.getAttribute("data-live") === "true");
    expect(live()).toEqual([true, true, false]);
    const paused = screen.getByTestId("plugin-live-paused");
    expect(paused.getAttribute("data-reason")).toBe("budget");
    // The overlay's z-10 stays inside its node: scrolled under the sticky header, it must
    // not paint over it (found in the release-readiness run).
    expect(paused.closest('[data-testid="plugin-thread"]')?.classList.contains("isolate")).toBe(true);
    fireEvent.click(screen.getByTestId("plugin-live-attach"));
    expect(live()).toEqual([false, true, true]);
  });

  it("adds no stream for the thread the content pane shows (it shares that Watch)", () => {
    useThreadsStore.setState({ loaded: true, byId: { a: thread("a"), b: thread("b"), c: thread("c") }, order: [], owned: ["a", "b", "c"] });
    useUiStore.setState({ selection: { kind: "thread", id: "c" } });
    inView(
      <NodeList
        nodes={[
          { key: "ta", thread: { threadId: "a" } },
          { key: "tb", thread: { threadId: "b" } },
          { key: "tc", thread: { threadId: "c" } },
        ]}
      />,
    );
    expect(screen.getAllByTestId("plugin-thread").map((n) => n.getAttribute("data-live") === "true")).toEqual([true, true, true]);
    expect(useInlineLiveStore.getState().holders).toHaveLength(2);
  });

  it("lets go while the user is leaving the view tab (its choice in flight) (#1a)", () => {
    useThreadsStore.setState({ loaded: true, byId: { a: thread("a") }, order: [], owned: ["a"] });
    usePluginSurfacesStore.setState({
      watches: { w: { plugin: "showcase", surface: "gallery", instance: ctx.instance, phase: "live", message: "", pluginState: "running", version: 1, hostRendered: false, error: null, view: { nodes: [], tabs: { active: "owned", items: [{ key: "owned", label: "Owned" }, { key: "text", label: "Text" }] } } } },
    });
    inView(<NodeList nodes={[{ key: "ta", thread: { threadId: "a" } }]} />);
    expect(screen.getByTestId("plugin-thread").getAttribute("data-live")).toBe("true");
    act(() => {
      usePluginSurfacesStore.setState({ choices: { w: { [chooserKeyOf(ctx.instance, "", "")]: { key: "text", seq: 1, version: 1, answered: false } } } });
    });
    expect(screen.getByTestId("plugin-thread").getAttribute("data-live")).toBeNull();
    expect(useInlineLiveStore.getState().holders).toEqual([]);
  });

  it("offers no Attach over the budget while streams wait for a connection (it would pause one that streams) (live 8)", () => {
    useThreadsStore.setState({ loaded: true, byId: { a: thread("a"), b: thread("b"), c: thread("c") }, order: [], owned: ["a", "b", "c"] });
    useStreamSlotsStore.setState({ open: 5, waiting: ["thread:b"] });
    inView(
      <NodeList
        nodes={[
          { key: "ta", thread: { threadId: "a" } },
          { key: "tb", thread: { threadId: "b" } },
          { key: "tc", thread: { threadId: "c" } },
        ]}
      />,
    );
    const paused = screen.getAllByTestId("plugin-live-paused").find((p) => p.getAttribute("data-reason") === "budget");
    expect(paused).toBeDefined();
    expect(screen.queryByTestId("plugin-live-attach")).toBeNull();
    act(() => {
      useStreamSlotsStore.setState({ open: 4, waiting: [] });
    });
    expect(screen.getByTestId("plugin-live-attach")).toBeTruthy();
  });

  it("says it waits for a connection when the app's stream slots are full (#1c)", () => {
    useThreadsStore.setState({ loaded: true, byId: { a: thread("a") }, order: [], owned: ["a"] });
    useStreamSlotsStore.setState({ open: 5, waiting: ["thread:a"] });
    inView(<NodeList nodes={[{ key: "ta", thread: { threadId: "a" } }]} />);
    expect(screen.getByTestId("plugin-live-paused").getAttribute("data-reason")).toBe("connections");
  });
});
