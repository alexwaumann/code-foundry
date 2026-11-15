/**
 * A plugin's copy action (docs/notes/toast-success-rule.md): from a visible control the
 * element shows the copy check for COPIED_MS and nothing is toasted; from a menu, which
 * closed as it ran, "Copied" is toasted; a failed copy toasts "Copy failed". The check's
 * colour in both schemes is e2e/copy-feedback.spec.ts's.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "@/lib/notify";
import type { ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { COPIED_MS } from "@/lib/useCopied";
import { usePluginCopiedStore } from "@/stores/pluginCopied";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";

const copyText = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));
const notify = vi.hoisted(() => vi.fn<(n: Notice) => number>(() => 1));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), notify }));

const ctx: ViewCtx = { watchKey: "w", instance: "p/s/global", viewTab: "", uiContext: emptyContext, inert: false };
const COPY = { copy: "CF-407" };

function nodes(list: ViewNode[]) {
  return render(
    <ViewContext.Provider value={ctx}>
      <NodeList nodes={list} />
    </ViewContext.Provider>,
  );
}

/** Lets the copy's promise land (and Radix's close, for a menu). */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Lets the check's moment pass. */
function lapse() {
  act(() => {
    vi.advanceTimersByTime(COPIED_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  usePluginCopiedStore.setState({ copied: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("a copy from a visible control: the check in place, no toast", () => {
  it("a labelled button swaps its icon for the check", async () => {
    nodes([{ key: "bar", actions: { buttons: [{ key: "b", label: "Copy key", icon: "clipboard", action: COPY }] } }]);
    const button = screen.getByTestId("plugin-button");
    fireEvent.click(button);
    await settle();
    expect(copyText).toHaveBeenCalledWith("CF-407");
    expect(button.dataset.copied).toBe("true");
    expect(button.querySelector("[data-copied]")?.getAttribute("class")).toContain("text-cf-success-text");
    expect(button.textContent).toBe("Copy key");
    expect(notify).not.toHaveBeenCalled();
    lapse();
    expect(button.dataset.copied).toBeUndefined();
  });

  it("an icon-only button is named Copied for the moment", async () => {
    nodes([{ key: "bar", actions: { buttons: [{ key: "b", label: "Copy key", icon: "clipboard", iconOnly: true, action: COPY }] } }]);
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await settle();
    expect(screen.getByRole("button", { name: "Copied" }).dataset.copied).toBe("true");
    expect(notify).not.toHaveBeenCalled();
    lapse();
    expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy();
  });

  it("a chip swaps its glyph for the check", async () => {
    nodes([{ key: "c", chips: { chips: [{ key: "x", label: "Build", status: "ok", action: COPY }] } }]);
    const chip = screen.getByTestId("plugin-chip");
    fireEvent.click(chip);
    await settle();
    expect(chip.dataset.copied).toBe("true");
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    lapse();
    expect(chip.dataset.copied).toBeUndefined();
  });

  it("a list row shows the check after its title; only that row", async () => {
    nodes([{ key: "l", list: { rows: [{ key: "a", title: "CF-407", action: COPY }, { key: "b", title: "CF-408", action: { copy: "CF-408" } }] } }]);
    const [first, second] = screen.getAllByTestId("plugin-row") as [HTMLElement, HTMLElement];
    fireEvent.click(first);
    await settle();
    expect(within(first).getByRole("img", { name: "Copied" })).toBeTruthy();
    expect(within(second).queryByTestId("plugin-copied")).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    lapse();
    expect(screen.queryByTestId("plugin-copied")).toBeNull();
  });

  it("a stat card shows the check beside its label", async () => {
    nodes([{ key: "st", stats: { cards: [{ key: "k", label: "Key", value: "CF-407", action: COPY }] } }]);
    fireEvent.click(screen.getByTestId("plugin-stat"));
    await settle();
    expect(within(screen.getByTestId("plugin-stat")).getByTestId("plugin-copied")).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a bar shows the check in its tooltip", async () => {
    nodes([{ key: "ch", bars: { title: "Builds", bars: [{ key: "b1", title: "#1", value: 3, action: COPY }] } }]);
    const plot = screen.getByTestId("plugin-bars-plot");
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: "Enter" });
    await settle();
    expect(copyText).toHaveBeenCalledWith("CF-407");
    expect(within(screen.getByTestId("plugin-bar-tip")).getByTestId("plugin-copied")).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a recopy restarts the moment", async () => {
    nodes([{ key: "bar", actions: { buttons: [{ key: "b", label: "Copy key", action: COPY }] } }]);
    const button = screen.getByTestId("plugin-button");
    fireEvent.click(button);
    await settle();
    act(() => {
      vi.advanceTimersByTime(COPIED_MS - 100);
    });
    fireEvent.click(button);
    await settle();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(button.dataset.copied).toBe("true");
    lapse();
    expect(button.dataset.copied).toBeUndefined();
  });

  it("a failed copy shows no check and toasts Copy failed", async () => {
    copyText.mockRejectedValueOnce(new Error("denied"));
    nodes([{ key: "bar", actions: { buttons: [{ key: "b", label: "Copy key", action: COPY }] } }]);
    fireEvent.click(screen.getByTestId("plugin-button"));
    await settle();
    expect(screen.getByTestId("plugin-button").dataset.copied).toBeUndefined();
    expect(notify).toHaveBeenCalledExactlyOnceWith({ level: "error", title: "Copy failed" });
  });
});

describe("a copy from a menu: the menu closed as it ran, so a toast", () => {
  it("a row's ⋯ item toasts Copied and marks nothing", async () => {
    nodes([{ key: "l", list: { rows: [{ key: "a", title: "CF-407", menu: { items: [{ key: "copy", label: "Copy key", action: COPY }] } }] } }]);
    fireEvent.pointerDown(screen.getByTestId("plugin-more"), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy key" }));
    await settle();
    await settle();
    expect(copyText).toHaveBeenCalledWith("CF-407");
    expect(notify).toHaveBeenCalledExactlyOnceWith({ level: "success", title: "Copied" });
    expect(screen.queryByTestId("plugin-copied")).toBeNull();
  });
});
