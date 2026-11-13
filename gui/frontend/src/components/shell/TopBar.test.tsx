import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// The verbs the top bar runs: layout verbs through runCommandForResult, space.remove through
// invokeConfirmed (the dialog was the question). The commands' answers carry a rev and the space.
const runs: { name: string; args: Record<string, string> }[] = [];
const asked: string[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
const invokeConfirmed = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult, invokeConfirmed }));
const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));

const { TopBar } = await import("./TopBar");
const { RemoveSpaceDialog } = await import("./RemoveSpaceDialog");
const { resetLayout } = await import("@/stores/layout");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadsStore } = await import("@/stores/threads");
const { resetFocusHistory, useFocusHistoryStore } = await import("@/stores/focusHistory");
const { useShellDragStore, resetShellDrag } = await import("@/shell/drag/state");

const command = (name: string, title: string): CommandView => ({ name, title, description: "", category: "View", args: [], keybindings: [], available: true });

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({
    id,
    name: id,
    projectId: "",
    worktreePath: "",
    workspaceId: "",
    projectIds: [],
    checkoutPaths: [],
    branch: "",
    createdWorktree: false,
    pendingWorktreePath: "",
    pendingMove: null,
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    createdBy: "",
    createdByName: "",
    parentId: "",
    flags: [],
    linkedPullRequests: [],
    status: "idle",
    state: "connected",
    ...o,
  }) as ThreadView;

/** Three spaces: Main (two panes), Release (one pane), Reviews (empty). s-2 and s-3 live in Release. */
const LAYOUT = {
  ...layoutOf([
    space(row("s-r", [pane("p-1", [tab("t-a", "thread", "s-1")]), pane("p-2", [tab("t-d", "diff", "s-1")])]), "p-1", { id: "sp-a", name: "Main" }),
    space(pane("p-9", [tab("t-x", "thread", "s-2")]), "p-9", { id: "sp-b", name: "Release 0.22" }),
    space(null, "", { id: "sp-c", name: "Reviews" }),
  ]),
  threads: [
    { threadId: "s-2", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null },
    { threadId: "s-3", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null },
    { threadId: "s-4", spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null },
  ],
};

function setThreads(...ts: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(async () => {
  runs.length = 0;
  asked.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: JSON.stringify({ rev: 1, changed: true, space: name === "space.new" ? "sp-new" : "" }) });
  });
  invokeConfirmed.mockImplementation(async (name: string, args: Record<string, string>, _ctx: unknown, _caller: unknown, opts: { ask?: (r: unknown) => Promise<boolean> } = {}) => {
    runs.push({ name, args });
    // The daemon asks first; the dialog's own question answers it.
    if (opts.ask && (await opts.ask({ title: name, message: "", confirmLabel: "Remove", command: name, args }))) asked.push(name);
    return { message: "", resultJson: "" };
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  resetLayout();
  resetFocusHistory();
  resetShellDrag();
  useCommandsStore.setState({ commands: [command("view.back", "Back"), command("view.forward", "Forward")] });
  // s-1 needs the user in Main, s-2 and s-3 in Release; s-4 too but another thread started it; s-5 is archived;
  // s-6 in Main finished its turn (Active's, not Needs you's).
  const ask = { status: "attention", statusReason: "permission: Bash ls" } as const;
  setThreads(
    thread("s-1", ask),
    thread("s-2", ask),
    thread("s-3", { status: "attention", statusReason: "question: Which?" }),
    thread("s-4", { ...ask, createdBy: "s-1" }),
    thread("s-5", { ...ask, archivedAtMs: 1 }),
    thread("s-6", { status: "attention", statusReason: "finished" }),
  );
  await seedLayout(LAYOUT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLayout();
});

const tabs = () => screen.getAllByTestId("space-tab");
const tabOf = (id: string) => tabs().find((t) => t.dataset.spaceId === id) ?? (() => {
  throw new Error(`no tab ${id}`);
})();

describe("the top bar", () => {
  it("shows the app name, the sidebar toggle, back and forward, the spaces in order and +", () => {
    render(<TopBar />);
    expect(screen.getByTestId("top-bar-app-name").textContent).toBe("Code Foundry");
    expect(screen.getByTestId("top-bar-sidebar-toggle")).toBeTruthy();
    expect(screen.getByTestId("top-bar-back")).toBeTruthy();
    expect(screen.getByTestId("top-bar-forward")).toBeTruthy();
    expect(tabs().map((t) => t.textContent)).toEqual(["Main1", "Release 0.222", "Reviews"]);
    expect(tabOf("sp-a").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("top-bar-new-space")).toBeTruthy();
  });

  it("puts the Needs you control after back and forward, so they do not move when the sidebar collapses", async () => {
    const { useUiStore } = await import("@/stores/ui");
    const before = useUiStore.getState().sidebarVisible;
    try {
      useUiStore.setState({ sidebarVisible: true });
      render(<TopBar />);
      expect(screen.queryByTestId("needs-control")).toBeNull();
      act(() => {
        useUiStore.setState({ sidebarVisible: false });
      });
      const control = screen.getByTestId("needs-control");
      const history = screen.getByTestId("top-bar-history");
      expect(history.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByTestId("top-bar-sidebar-toggle").compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      useUiStore.setState({ sidebarVisible: before });
    }
  });

  it("counts the threads Needs you lists for each space: not a thread's threads, archived ones nor a finished turn", () => {
    render(<TopBar />);
    expect(within(tabOf("sp-a")).getByTestId("space-tab-count").textContent).toBe("1");
    expect(within(tabOf("sp-b")).getByTestId("space-tab-count").getAttribute("aria-label")).toBe("2 threads need you");
    expect(within(tabOf("sp-c")).queryByTestId("space-tab-count")).toBeNull();
  });

  it("draws each space's glyph from its own panes", () => {
    render(<TopBar />);
    expect(tabs().map((t) => within(t).getByTestId("space-icon").getAttribute("data-panes"))).toEqual(["2", "1", "1"]);
  });

  it("is the window's drag band, all but its controls", () => {
    render(<TopBar />);
    expect(screen.getByTestId("top-bar").className).toContain("[--wails-draggable:drag]");
    for (const el of [tabOf("sp-a"), screen.getByTestId("top-bar-new-space"), screen.getByTestId("top-bar-history")]) expect(el.className).toContain("[--wails-draggable:no-drag]");
  });

  it("switches space on a click, and not to the one it shows", async () => {
    render(<TopBar />);
    fireEvent.click(tabOf("sp-b"));
    fireEvent.click(tabOf("sp-a"));
    await settle();
    expect(runs).toEqual([{ name: "space.switch", args: { space: "sp-b", focus: "true" } }]);
  });

  it("+ makes a space, shown at once, its name ready to type", async () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("top-bar-new-space"));
    await settle();
    expect(runs).toEqual([{ name: "space.new", args: { focus: "true" } }]);
  });

  it("renames on a double click: Enter renames with space.rename, Escape keeps the name", async () => {
    render(<TopBar />);
    fireEvent.doubleClick(tabOf("sp-b"));
    const field = screen.getByTestId<HTMLInputElement>("space-name-field");
    fireEvent.change(field, { target: { value: "Release 0.23" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(runs).toEqual([{ name: "space.rename", args: { name: "Release 0.23", space: "sp-b" } }]);
    fireEvent.doubleClick(tabOf("sp-c"));
    const again = screen.getByTestId<HTMLInputElement>("space-name-field");
    fireEvent.change(again, { target: { value: "Nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    await settle();
    expect(runs).toHaveLength(1);
    expect(screen.queryByTestId("space-name-field")).toBeNull();
  });

  it("its menu renames and removes; the last space cannot be removed", async () => {
    render(<TopBar />);
    fireEvent.contextMenu(tabOf("sp-b"));
    const menu = await screen.findByTestId("space-tab-menu");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toEqual(["Rename…", "Remove space…"]);
    fireEvent.click(within(menu).getByTestId("space-tab-rename"));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByTestId("space-name-field")).toBeTruthy();

    cleanup();
    await seedLayout({ ...layoutOf([space(null, "", { id: "sp-a", name: "Main" })]), rev: 5 });
    render(<TopBar />);
    fireEvent.contextMenu(tabOf("sp-a"));
    const only = await screen.findByTestId("space-tab-menu");
    expect(within(only).getByTestId("space-tab-remove").getAttribute("aria-disabled")).toBe("true");
    expect(within(only).getByTestId("space-tab-remove").textContent).toBe("The last space stays");
  });

  it("marks the space tab a dragged tab or pane is over", () => {
    render(<TopBar />);
    act(() => {
      useShellDragStore.setState({ source: { kind: "tab", tab: "t-d", pane: "p-2" }, space: "sp-b" });
    });
    expect(tabOf("sp-b").dataset.dropTarget).toBe("true");
    expect(tabOf("sp-c").dataset.dropTarget).toBeUndefined();
  });

  it("dims back and forward while the focus history has nowhere to go", () => {
    render(<TopBar />);
    expect(screen.getByTestId<HTMLButtonElement>("top-bar-back").disabled).toBe(true);
    act(() => {
      // An earlier focus in another space: back goes there.
      useFocusHistoryStore.setState({ entries: [{ space: "sp-b", pane: "p-9", tab: "t-x" }, { space: "sp-a", pane: "p-1", tab: "t-a" }], index: 1 });
    });
    expect(screen.getByTestId<HTMLButtonElement>("top-bar-back").disabled).toBe(false);
    expect(screen.getByTestId<HTMLButtonElement>("top-bar-forward").disabled).toBe(true);
  });
});

describe("the remove space dialog", () => {
  async function openFor(spaceId: string) {
    render(
      <>
        <TopBar />
        <RemoveSpaceDialog />
      </>,
    );
    fireEvent.contextMenu(tabOf(spaceId));
    const menu = await screen.findByTestId("space-tab-menu");
    fireEvent.click(within(menu).getByTestId("space-tab-remove"));
    return screen.findByTestId("remove-space-dialog");
  }

  it("says what closes and how many threads it holds, and moves them to the space on its left by default", async () => {
    const dialog = await openFor("sp-b");
    expect(within(dialog).getByText("Remove space “Release 0.22”?")).toBeTruthy();
    // s-2 and s-3 are the user's; s-4 was started by a thread.
    expect(within(dialog).getByTestId("remove-space-summary").textContent).toBe("Its 1 tab and panes close. It holds 2 threads.");
    expect(within(dialog).getByTestId("remove-space-target").textContent).toBe("Main");
    fireEvent.click(within(dialog).getByTestId("remove-space-submit"));
    await settle();
    expect(runs).toEqual([{ name: "space.remove", args: { space: "sp-b", to: "sp-a" } }]);
    // The daemon's own question is answered by the dialog, so no second dialog asks.
    expect(asked).toEqual(["space.remove"]);
    expect(screen.queryByTestId("remove-space-dialog")).toBeNull();
  });

  it("archives them all instead when asked", async () => {
    const dialog = await openFor("sp-b");
    fireEvent.click(within(dialog).getByTestId("remove-space-archive"));
    fireEvent.click(within(dialog).getByTestId("remove-space-submit"));
    await settle();
    expect(runs).toEqual([{ name: "space.remove", args: { space: "sp-b", archive: "true" } }]);
  });

  it("asks nothing about threads for a space without any", async () => {
    const dialog = await openFor("sp-c");
    expect(within(dialog).getByTestId("remove-space-summary").textContent).toBe("It holds no threads.");
    expect(within(dialog).queryByTestId("remove-space-choice")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("remove-space-submit"));
    await settle();
    expect(runs).toEqual([{ name: "space.remove", args: { space: "sp-c", to: "sp-b" } }]);
  });
});
