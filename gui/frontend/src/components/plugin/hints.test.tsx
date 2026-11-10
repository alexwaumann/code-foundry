/** Plugin tooltips (a plugin's `hint`, a status in words, text the host cut) and the input kinds. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, Field, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { tooltipText } from "@/test/tooltip";
import { ViewContext, type ViewCtx } from "./context";
import { LIVE_CHANGE_MS } from "./form";
import { NodeList } from "./NodeList";

const acts: ActRequestView[] = [];

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.push(req);
    return Promise.resolve();
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "p/s/global", viewTab: "", uiContext: emptyContext } as ViewCtx;

function inView(children: ReactNode) {
  return render(<ViewContext.Provider value={ctx}>{children}</ViewContext.Provider>);
}

function nodes(...list: ViewNode[]) {
  return inView(<NodeList nodes={list} />);
}

/** jsdom has no layout: makes `el` clip its text as `truncate` does. */
function cut(el: HTMLElement) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 180 });
  el.style.overflowX = "hidden";
}

function form(field: Field, submit = false): ViewNode {
  return { key: "f", form: { fields: [field], ...(submit ? { submit: { key: "save", label: "Save", action: { event: "save" } } } : {}) } };
}

beforeEach(() => {
  acts.length = 0;
  usePluginSurfacesStore.setState({ watches: { w: { instance: "p/s/global", version: 1 } } } as never);
});

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {} } as never);
  vi.useRealTimers();
});

describe("a plugin's hint", () => {
  it("shows on a labelled button, also a disabled one", () => {
    nodes({ key: "bar", actions: { buttons: [{ key: "b", label: "Deploy", disabled: true, hint: "Tests are still running", action: { event: "go" } }] } });
    const tip = screen.getByRole("button", { name: "Deploy" }).parentElement as HTMLElement;
    tip.tabIndex = 0;
    expect(tooltipText(tip)).toBe("Tests are still running");
  });

  it("shows under an icon-only button's label", () => {
    nodes({ key: "bar", actions: { buttons: [{ key: "b", label: "Refresh", icon: "refresh-cw", iconOnly: true, hint: "Last try failed", action: { event: "go" } }] } });
    const tip = screen.getByRole("button", { name: "Refresh" }).parentElement as HTMLElement;
    tip.tabIndex = 0;
    expect(tooltipText(tip)).toBe("Refresh\nLast try failed");
  });

  it("shows on a chip without the chip being cut", () => {
    nodes({ key: "c", chips: { chips: [{ key: "x", label: "Build", hint: "Took 3 retries" }] } });
    expect(tooltipText(screen.getByTestId("plugin-chip"))).toBe("Took 3 retries");
  });

  it("replaces a link's URL and marks plain text", () => {
    nodes({ key: "t", text: { content: { spans: [{ text: "docs", url: "https://example.com", hint: "The API guide" }, { text: "plain", hint: "Exactly 1,204" }] } } });
    expect(tooltipText(screen.getByRole("link", { name: "docs" }))).toBe("The API guide");
    const plain = screen.getByText("plain");
    plain.tabIndex = 0;
    expect(tooltipText(plain)).toBe("Exactly 1,204");
  });

  it("shows on a pill", () => {
    nodes({ key: "s", section: { title: "Runs", pill: { label: "3", hint: "3 waiting for a runner" }, children: [] } });
    const pill = screen.getByTestId("plugin-pill");
    pill.tabIndex = 0;
    expect(tooltipText(pill)).toBe("3 waiting for a runner");
  });
});

describe("a status glyph", () => {
  const row = (extra: object) => ({ key: "l", list: { rows: [{ key: "r", title: "Build", glyph: { status: "failed" as const }, ...extra }] } });
  const dot = () => {
    const el = (document.querySelector("[data-status]") as HTMLElement).parentElement as HTMLElement;
    el.tabIndex = 0;
    return el;
  };

  it("says its status in words", () => {
    nodes(row({}));
    expect(tooltipText(dot())).toBe("Failed");
  });

  it("says nothing when a pill beside it already does", () => {
    nodes(row({ pill: { label: "failed", tone: "error" } }));
    expect(tooltipText(dot())).toBeNull();
  });

  it("prefers the plugin's hint", () => {
    nodes({ key: "l", list: { rows: [{ key: "r", title: "Build", glyph: { status: "failed", hint: "Exit code 2" } }] } });
    expect(tooltipText(dot())).toBe("Exit code 2");
  });
});

describe("text the host cut", () => {
  it.each<[string, ViewNode, string]>([
    ["a chip's label", { key: "c", chips: { chips: [{ key: "x", label: "A very long stage" }] } }, "A very long stage"],
    ["a section's title", { key: "s", section: { title: "A very long title", children: [] } }, "A very long title"],
    ["a progress label", { key: "p", progress: { label: "A very long step" } }, "A very long step"],
    ["a divider's label", { key: "d", divider: { label: "A very long group" } }, "A very long group"],
    ["a log's title", { key: "l", log: { title: "A very long log", text: "x" } }, "A very long log"],
  ])("%s shows whole only while cut", (_name, node, text) => {
    nodes(node);
    const el = screen.getByText(text);
    el.tabIndex = 0;
    expect(tooltipText(el)).toBeNull();
    cleanup();
    nodes(node);
    const again = screen.getByText(text);
    again.tabIndex = 0;
    cut(again);
    expect(tooltipText(again)).toBe(text);
  });
});

describe("input kinds", () => {
  it("draws a multi-line input at its rows; Enter adds a line and cmd+Enter submits", () => {
    nodes(form({ key: "n", name: "notes", label: "Notes", input: { kind: "multiline", rows: 6 } }, true));
    const box = screen.getByTestId("plugin-input");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("rows")).toBe("6");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true); // not prevented: the line break goes in
    expect(acts).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(acts.map((a) => a.key)).toEqual(["save"]);
  });

  it("defaults a multi-line input to four rows", () => {
    nodes(form({ key: "n", name: "notes", input: { kind: "multiline" } }));
    expect(screen.getByTestId("plugin-input").getAttribute("rows")).toBe("4");
  });

  it("draws a number input", () => {
    nodes(form({ key: "n", name: "port", input: { kind: "number", value: "8080" } }));
    expect(screen.getByTestId("plugin-input").getAttribute("type")).toBe("number");
  });
});

describe("a live input", () => {
  const live: Field = { key: "q", name: "q", input: { live: true }, change: { event: "filter" } };

  it("sends its text once typing pauses, with the form's values", async () => {
    vi.useFakeTimers();
    nodes(form(live));
    const box = screen.getByTestId("plugin-input");
    fireEvent.change(box, { target: { value: "a" } });
    fireEvent.change(box, { target: { value: "ab" } });
    expect(acts).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_CHANGE_MS);
    });
    expect(acts.map((a) => [a.key, a.value, a.values])).toEqual([["q", "ab", { q: "ab" }]]);
  });

  it("does not send the same text again on blur", async () => {
    vi.useFakeTimers();
    nodes(form(live));
    const box = screen.getByTestId("plugin-input");
    fireEvent.change(box, { target: { value: "ab" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_CHANGE_MS);
    });
    fireEvent.blur(box);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_CHANGE_MS);
    });
    expect(acts).toHaveLength(1);
  });

  it("sends what is waiting when focus leaves", async () => {
    vi.useFakeTimers();
    nodes(form(live));
    const box = screen.getByTestId("plugin-input");
    fireEvent.change(box, { target: { value: "ab" } });
    await act(async () => {
      fireEvent.blur(box);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acts.map((a) => a.value)).toEqual(["ab"]);
  });

  it("sends nothing while typing without live: only on blur", async () => {
    vi.useFakeTimers();
    nodes(form({ ...live, input: {} }));
    fireEvent.change(screen.getByTestId("plugin-input"), { target: { value: "ab" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_CHANGE_MS * 2);
    });
    expect(acts).toEqual([]);
  });
});
