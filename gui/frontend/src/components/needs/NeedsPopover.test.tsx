import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const runCommandForResult = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
// The card's read without a Watch: nothing to show here.
vi.mock("@/api/threadSearch", async (orig) => ({ ...(await orig<typeof import("@/api/threadSearch")>()), readAskItems: () => new Promise(() => undefined) }));

const { NeedsPopover } = await import("./NeedsPopover");
const { thread } = await import("@/test/projectsWorld");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useSettingsStore } = await import("@/stores/settings");
const { HOME, useUiStore } = await import("@/stores/ui");
const { resetNeeds, useNeedsStore } = await import("@/stores/needs");

/**
 * The top bar's Needs you control for a collapsed sidebar (docs/notes/shell-17-needs-you.md):
 * when it shows, its count in the section's scope, and what its popover's rows do.
 */

const ask = (id: string, at: number, o: Partial<ThreadView> = {}) => thread(id, { name: `Thread ${id}`, status: "attention", statusReason: "permission: Bash ls", statusChangedAtMs: at, state: "connected", ...o });

function setThreads(...ts: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
}

beforeEach(async () => {
  resetNeeds();
  resetLayout();
  useSettingsStore.setState({ snapshot: null });
  useUiStore.setState({ selection: HOME, sidebarVisible: false });
  // s-a and s-b live in Main (the current space), s-c in Release; s-kid was started by s-a.
  setThreads(ask("s-a", 10), ask("s-b", 30), ask("s-c", 20), thread("s-idle", { statusReason: "at prompt" }), ask("s-kid", 40, { createdBy: "s-a" }));
  const layout = layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-idle")]), "p-1", { id: "sp-a", name: "Main" }), space(null, "", { id: "sp-b", name: "Release" })]);
  await seedLayout({
    ...layout,
    threads: ["s-a", "s-b", "s-c", "s-idle", "s-kid"].map((id) => ({ threadId: id, spaceId: id === "s-c" ? "sp-b" : "sp-a", quick: null, remembered: [], rememberedPaneId: "", info: null })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLayout();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("the top bar's Needs you control", () => {
  it("shows only while the sidebar is collapsed", () => {
    useUiStore.setState({ sidebarVisible: true });
    const { rerender } = render(<NeedsPopover />);
    expect(screen.queryByTestId("needs-control")).toBeNull();
    act(() => {
      useUiStore.setState({ sidebarVisible: false });
    });
    rerender(<NeedsPopover />);
    expect(screen.getByTestId("needs-control")).toBeTruthy();
  });

  it("counts the user's own threads that need them, in every space by default", () => {
    render(<NeedsPopover />);
    expect(screen.getByTestId("needs-control-count").textContent).toBe("3");
    expect(screen.getByTestId("needs-control").getAttribute("aria-label")).toBe("3 threads need you");
  });

  it("follows the section's scope: this space's only", () => {
    useSettingsStore.setState({ snapshot: { values: { "sidebar.needs_scope": "space" } } as never });
    render(<NeedsPopover />);
    expect(screen.getByTestId("needs-control-count").textContent).toBe("2");
  });

  it("stays (without a count) while only another space's threads wait and the scope is this space's", async () => {
    useSettingsStore.setState({ snapshot: { values: { "sidebar.needs_scope": "space" } } as never });
    setThreads(ask("s-c", 20), thread("s-idle", { statusReason: "at prompt" }));
    render(<NeedsPopover />);
    expect(screen.queryByTestId("needs-control-count")).toBeNull();
    fireEvent.click(screen.getByTestId("needs-control"));
    expect((await screen.findByTestId("needs-popover-empty")).textContent).toBe("Nothing in this space needs you.");
  });

  it("is not there when nothing waits", () => {
    setThreads(thread("s-idle", { statusReason: "at prompt" }));
    render(<NeedsPopover />);
    expect(screen.queryByTestId("needs-control")).toBeNull();
  });

  it("opens the list: the title opens the popup, the rest of a row goes to the thread", async () => {
    render(<NeedsPopover />);
    fireEvent.click(screen.getByTestId("needs-control"));
    const pop = await screen.findByTestId("needs-popover");
    const rows = within(pop).getAllByTestId("needs-popover-row");
    expect(rows.map((r) => r.getAttribute("data-thread-id"))).toEqual(["s-b", "s-c", "s-a"]);
    expect(within(pop).getByTestId("needs-popover-count").textContent).toBe("3");
    expect(within(pop).getByTestId("needs-scope").getAttribute("data-scope")).toBe("all");

    fireEvent.click(within(rows[0] as HTMLElement).getByTestId("thread-name"));
    expect(useNeedsStore.getState().popup).toBe("s-b");
    expect(useNeedsStore.getState().dismissed).toBe("popover:s-b");
    expect(useNeedsStore.getState().popover).toBe(false);
    await settle();
    expect(screen.queryByTestId("needs-popover")).toBeNull();

    act(() => {
      useNeedsStore.setState({ popup: null });
    });
    fireEvent.click(screen.getByTestId("needs-control"));
    const row = (await screen.findAllByTestId("needs-popover-row"))[1] as HTMLElement;
    fireEvent.click(within(row).getByTestId("row-line-1"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-c" });
    expect(useNeedsStore.getState().popup).toBeNull();
  });

  it("a row takes the keyboard: Enter opens its popup", async () => {
    render(<NeedsPopover />);
    fireEvent.click(screen.getByTestId("needs-control"));
    const row = (await screen.findAllByTestId("needs-popover-row"))[2] as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(useNeedsStore.getState().popup).toBe("s-a");
  });
});
