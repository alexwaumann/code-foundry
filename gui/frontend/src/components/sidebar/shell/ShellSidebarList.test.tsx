import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragStartEvent } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

// jsdom lays nothing out: this stand-in draws every row at its estimate (the real measuring is e2e's).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number; gap?: number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size + (o.gap ?? 0);
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, measureElement: () => undefined, scrollToIndex: () => undefined, scrollToOffset: () => undefined };
  },
}));
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));
// Every verb a row, a menu or a button runs (the layout verbs reach it through shell/commands.ts).
const runs: { name: string; args: Record<string, string>; thread?: string }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), notify }));

const { ShellSidebarList } = await import("./ShellSidebarList");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useSettingsStore } = await import("@/stores/settings");
const { useShellSidebarStore } = await import("@/stores/shellSidebar");
const { HOME, useUiStore } = await import("@/stores/ui");
const { startSelectionBridge } = await import("@/stores/selectionBridge");
const { resetNeeds, useNeedsStore } = await import("@/stores/needs");
const { useThreadStore } = await import("@/stores/thread");
const { resetShellDrag, useShellDragStore } = await import("@/shell/drag/state");
// The Needs-you card reads its ask without a Watch: nothing comes back here.
vi.mock("@/api/threadSearch", async (orig) => ({ ...(await orig<typeof import("@/api/threadSearch")>()), readAskItems: () => new Promise(() => undefined) }));

/**
 * The shell's sidebar list (docs/notes/shell-16-sidebar.md): which rows it draws with which lines,
 * and which verb each click, button and menu item runs. Membership and order are
 * lib/shellSections.test.ts's.
 */

const thread = (o: Partial<ThreadView>) =>
  ({
    id: "s-1",
    name: "Write thread docs",
    projectId: "api",
    worktreePath: "/w/api",
    workspaceId: "",
    projectIds: ["api"],
    checkoutPaths: [],
    branch: "feat/sidebar",
    createdWorktree: false,
    pendingWorktreePath: "",
    pendingMove: null,
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    savedAtMs: null,
    createdBy: "",
    createdByName: "",
    parentId: "",
    linkedPullRequests: [],
    status: "idle",
    statusReason: "",
    state: "connected",
    backgroundShellsRunning: 0,
    ...o,
  }) as ThreadView;

const NO_PROJECT = { projectId: "", worktreePath: "", projectIds: [], branch: "" };
const LONG = "Investigate the flaky e2e run that only fails on the four-worker WebKit job after a rebase onto main";

const PROJECT = { id: "api", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/w/api", branch: "feat/sidebar", head: "a", isMain: true }] };

function setThreads(...ts: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
}

let stop: () => void = () => undefined;

beforeEach(async () => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string } } = {}) => {
    runs.push({ name, args, ...(opts.ctx ? { thread: opts.ctx.activeThreadId ?? "" } : {}) });
    return Promise.resolve({ message: "", resultJson: JSON.stringify({ rev: 0, changed: false }) });
  });
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  useShellSidebarStore.setState({ needsCollapsed: false, activeCollapsed: false });
  resetNeeds();
  useSettingsStore.setState({ snapshot: null });
  useUiStore.setState({ selection: HOME, cursorKey: null, workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
  useProjectsStore.setState({ byId: { api: PROJECT } as never, order: ["api"] });
  setThreads(
    thread({ id: "s-1" }),
    thread({ id: "s-2", name: "Fix stale PR badge", status: "attention", statusReason: "permission", statusChangedAtMs: Date.now() }),
    thread({ id: "s-3", name: "Plan the spring trip", ...NO_PROJECT }),
    thread({ id: "s-4", name: "Compare charting libraries", ...NO_PROJECT, backgroundShellsRunning: 2 }),
    thread({ id: "s-5", name: LONG }),
    thread({ id: "s-6", name: "A child's question", status: "attention", statusReason: "question", createdBy: "s-1" }),
  );
  await seedLayout(
    layoutOf([
      space(pane("p-1", [tab("t-1", "thread", "s-1", { key: "thread:s-1" }), tab("t-c", "compose", "", { key: "compose:draft:d-1", params: { draft: "d-1" } })], "t-c"), "p-1", {
        drafts: [
          { id: "d-1", label: "Release notes for the shell", params: { project: "api" } },
          { id: "d-2", label: "", params: {} },
        ],
      }),
    ]),
  );
  useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
  stop = startSelectionBridge();
});

afterEach(() => {
  stop();
  cleanup();
  vi.clearAllMocks();
  resetLayout();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const list = () => screen.getByTestId("thread-list");
const rowOf = (key: string) => list().querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`) as HTMLElement;
const rowKeys = () => [...list().querySelectorAll("[data-row-key]")].map((e) => e.getAttribute("data-row-key"));

describe("the shell sidebar list", () => {
  it("lists Needs you (the user's own asks only), then Active with the drafts on top, never a thread twice", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    expect(rowKeys()).toEqual(["h:needs", "s:s-2", "h:active", "d:d-1", "d:d-2", "s:s-5", "s:s-4", "s:s-3", "s:s-1"]);
    // s-6 was started by a thread: in no section, though it asks.
    expect(rowOf("s:s-6")).toBeNull();
    expect(within(screen.getByTestId("needs-header")).getByTestId("needs-count").textContent).toBe("1");
    // Active shows its count only while collapsed.
    expect(within(screen.getByTestId("active-header")).queryByTestId("active-count")).toBeNull();
  });

  it("a Needs you row: the project and the kind of ask, then the title; no controls", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const row = rowOf("s:s-2");
    expect(within(row).getByTestId("row-project").textContent).toBe("code-foundry");
    expect(within(row).getByTestId("row-ask").textContent).toBe("Permission");
    expect(within(row).getByTestId("thread-name").textContent).toBe("Fix stale PR badge");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(within(row).queryByTestId("row-line-3")).toBeNull();
  });

  it("a project thread's row: project and time, then the title, then the branch; the hover controls sit in line 1", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const row = rowOf("s:s-1");
    const line1 = within(row).getByTestId("row-line-1");
    expect(within(line1).getByTestId("row-project").textContent).toBe("code-foundry");
    expect(within(line1).getByTestId("row-actions")).toBeTruthy();
    expect(within(line1).getByTestId("row-hover-slot")).toBeTruthy();
    expect(within(row).getByTestId("thread-name").textContent).toBe("Write thread docs");
    expect(within(row).getByTestId("row-branch").textContent).toBe("feat/sidebar");
    // Line order: place, title, branch.
    const body = within(row).getByTestId("thread-body");
    expect([...body.children].map((c) => c.getAttribute("data-testid"))).toEqual(["row-line-1", "thread-name", "row-line-3"]);
  });

  it("a thread with no project: the house and No project; no third line unless it has counts", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const bare = rowOf("s:s-3");
    expect(within(bare).getByTestId("row-place-icon").getAttribute("data-place")).toBe("none");
    expect(within(bare).getByTestId("row-project").textContent).toBe("No project");
    expect(within(bare).queryByTestId("row-line-3")).toBeNull();
    const busy = rowOf("s:s-4");
    const line3 = within(busy).getByTestId("row-line-3");
    expect(within(line3).queryByTestId("row-branch")).toBeNull();
    expect(within(line3).getByTestId("row-bg-shells").textContent).toBe("2");
  });

  it("a long title wraps at full width, cut after two lines", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const name = within(rowOf("s:s-5")).getByTestId("thread-name");
    expect(name.textContent).toBe(LONG);
    expect(name.className).toContain("line-clamp-2");
    // Nothing shares the title's line.
    expect(name.parentElement?.getAttribute("data-testid")).toBe("thread-body");
  });

  it("a click on a thread adds its tab in the focused pane, or focuses it: thread.open", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.click(rowOf("s:s-3"));
    await settle();
    expect(runs).toEqual([{ name: "thread.open", args: { id: "s-3", focus: "true" } }]);
    // A Needs you row opens its thread the same way.
    fireEvent.click(rowOf("s:s-2"));
    await settle();
    expect(runs.at(-1)).toEqual({ name: "thread.open", args: { id: "s-2", focus: "true" } });
  });

  it("a Needs you row's title opens its popup instead (docs/notes/shell-17-needs-you.md); its first line still goes to the thread", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.click(within(rowOf("s:s-2")).getByTestId("thread-name"));
    await settle();
    expect(useNeedsStore.getState().popup).toBe("s-2");
    expect(useNeedsStore.getState().dismissed).toBe("sidebar:s-2");
    expect(runs).toEqual([]);
    act(() => {
      useNeedsStore.setState({ popup: null });
    });
    fireEvent.click(within(rowOf("s:s-2")).getByTestId("row-line-1"));
    await settle();
    expect(runs).toEqual([{ name: "thread.open", args: { id: "s-2", focus: "true" } }]);
    expect(useNeedsStore.getState().popup).toBeNull();
  });

  it("the keyboard on a Needs you row shows its card, and Enter opens its popup", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    list().focus();
    // Home: the first row, s-2.
    fireEvent.keyDown(list(), { key: "Home" });
    expect(useUiStore.getState().cursorKey).toBe("s:s-2");
    expect((await screen.findByTestId("needs-card")).getAttribute("data-thread-id")).toBe("s-2");
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(useNeedsStore.getState().popup).toBe("s-2");
    expect(runs).toEqual([]);
    expect(screen.queryByTestId("needs-card")).toBeNull();
    // A press in the list puts the pointer in charge again: no card follows the cursor.
    act(() => {
      useNeedsStore.setState({ popup: null });
    });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "ArrowUp" });
    expect(await screen.findByTestId("needs-card")).toBeTruthy();
    fireEvent.pointerDown(list());
    expect(screen.queryByTestId("needs-card")).toBeNull();
  });

  it("drafts read as drafts with a thread row's lines: the place, the label or a placeholder, the mark; a click opens it, Discard ends it", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const d1 = rowOf("d:d-1");
    const d2 = rowOf("d:d-2");
    // Line 1: the project with its icon, as a thread row shows it, or "No project" with its icon.
    expect(within(within(d1).getByTestId("row-line-1")).getByTestId("row-project").textContent).toBe("code-foundry");
    expect(within(d1).getByTestId("row-place-icon")).toBeTruthy();
    const none = within(within(d2).getByTestId("row-line-1")).getByTestId("row-project");
    expect(none.textContent).toBe("No project");
    expect(none.getAttribute("data-no-project")).toBe("true");
    expect(within(none).getByTestId("row-place-icon").getAttribute("data-place")).toBe("none");
    // Then the title, then where a thread shows its branch: the pencil and "Draft".
    expect(within(d1).getByTestId("draft-label").textContent).toBe("Release notes for the shell");
    expect(within(d2).getByTestId("draft-label").textContent).toBe("Untitled draft");
    expect(within(d2).getByTestId("draft-label").className).toContain("text-cf-sidebar-muted-foreground");
    const line3 = within(d1).getByTestId("row-line-3");
    expect(line3.textContent).toBe("Draft");
    expect(within(line3).getByTestId("row-draft-mark")).toBeTruthy();
    // The focused tab is d-1's composer: its row is the selected one.
    expect(d1.getAttribute("aria-selected")).toBe("true");
    // Both are tinted amber at rest, not only on hover; the selected one more strongly.
    expect(rowOf("d:d-2").className).toContain("bg-cf-warning-surface");
    expect(d1.className).toContain("bg-cf-warning/20");
    expect(rowOf("s:s-1").className).not.toContain("cf-warning");
    fireEvent.click(rowOf("d:d-2"));
    await settle();
    expect(runs).toEqual([{ name: "composer.draft.open", args: { draft: "d-2", focus: "true" } }]);
    fireEvent.click(within(d1).getByTestId("row-discard-draft"));
    await settle();
    expect(runs.at(-1)).toEqual({ name: "composer.draft.discard", args: { draft: "d-1" } });
    // Discard does not also open it.
    expect(runs).toHaveLength(2);
  });

  it("a draft's menu: Open and Discard", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.contextMenu(rowOf("d:d-1"));
    const menu = await screen.findByTestId("draft-menu");
    fireEvent.click(within(menu).getByTestId("draft-menu-discard"));
    await settle();
    expect(runs).toEqual([{ name: "composer.draft.discard", args: { draft: "d-1" } }]);
  });

  it("the scope button names the scope in force and switches the global setting", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    const button = screen.getByTestId("needs-scope");
    expect(button.textContent).toBe("All spaces");
    fireEvent.click(button);
    await settle();
    expect(runs).toEqual([{ name: "settings.set", args: { key: "sidebar.needs_scope", value: "space" } }]);
    act(() => {
      useSettingsStore.setState({ snapshot: { values: { "sidebar.needs_scope": "space" } } as never });
    });
    expect(screen.getByTestId("needs-scope").textContent).toBe("This space");
    fireEvent.click(screen.getByTestId("needs-scope"));
    await settle();
    expect(runs.at(-1)).toEqual({ name: "settings.set", args: { key: "sidebar.needs_scope", value: "all" } });
  });

  it("collapsing Needs you keeps its count and hides its rows; Active shows its count once collapsed", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.click(screen.getByTestId("needs-header"));
    expect(rowOf("s:s-2")).toBeNull();
    expect(screen.getByTestId("needs-count").textContent).toBe("1");
    expect(useShellSidebarStore.getState().needsCollapsed).toBe(true);
    fireEvent.click(screen.getByTestId("active-header"));
    expect(rowOf("s:s-1")).toBeNull();
    expect(screen.getByTestId("active-count").textContent).toBe("6");
  });

  it("the row's menu has Open ▸ first; for a closed thread its diff opens by the daemon's rule (the focused pane)", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.contextMenu(rowOf("s:s-5"));
    const menu = await screen.findByTestId("row-menu");
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
    expect(items[0]).toBe("Open");
    expect(items).not.toContain("New terminal here");
    fireEvent.keyDown(within(menu).getByTestId("row-menu-open"), { key: "ArrowRight" });
    const sub = await screen.findByTestId("row-menu-open-surfaces");
    expect([...sub.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toEqual(["Diff", "New terminal tab"]);
    fireEvent.click(within(sub).getByText("Diff"));
    await settle();
    // With the row's thread as the context, whatever the window shows.
    expect(runs).toEqual([{ name: "view.open.diff", args: { thread: "s-5" }, thread: "s-5" }]);
  });

  it("Move to space ▸ in the row's menu lists the spaces and moves the thread with thread.space.move", async () => {
    await seedLayout({ ...layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1")]), "p-1"), space(null, "", { id: "sp-b", name: "Review" })]), rev: 2 });
    render(<ShellSidebarList bodyHeight={800} />);
    fireEvent.contextMenu(rowOf("s:s-5"));
    const menu = await screen.findByTestId("row-menu");
    fireEvent.keyDown(within(menu).getByTestId("row-menu-move-to-space"), { key: "ArrowRight" });
    const sub = await screen.findByTestId("row-menu-move-to-space-spaces");
    expect([...sub.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toEqual(["Mainhere", "Review", "New space"]);
    fireEvent.click(within(sub).getByText("Review"));
    await settle();
    expect(runs).toEqual([{ name: "thread.space.move", args: { id: "s-5", space: "sp-b" }, thread: "s-5" }]);
    // The row leaving the list is the result: no toast (docs/notes/toast-success-rule.md).
    expect(notify).not.toHaveBeenCalled();
  });

  it("lists the current space's threads and follows a space switch; Needs you keeps every space's asks", async () => {
    const two = (current: string) => ({
      ...layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1")]), "p-1"), space(null, "", { id: "sp-b", name: "Review" })]),
      currentSpaceId: current,
      // s-3 and s-2 live in Review.
      threads: ["s-3", "s-2"].map((id) => ({ threadId: id, spaceId: "sp-b", quick: null, remembered: [], rememberedPaneId: "", info: null })),
    });
    await seedLayout({ ...two("sp-a"), rev: 2 });
    render(<ShellSidebarList bodyHeight={800} />);
    expect(rowKeys()).toEqual(["h:needs", "s:s-2", "h:active", "s:s-5", "s:s-4", "s:s-1"]);
    await act(async () => {
      await seedLayout({ ...two("sp-b"), rev: 3 });
    });
    expect(rowKeys()).toEqual(["h:needs", "s:s-2", "h:active", "s:s-3"]);
    // With the scope on this space, Review's ask stays (it is this space's); Main's view loses it.
    act(() => {
      useSettingsStore.setState({ snapshot: { values: { "sidebar.needs_scope": "space" } } as never });
    });
    expect(rowKeys()).toEqual(["h:needs", "s:s-2", "h:active", "s:s-3"]);
    await act(async () => {
      await seedLayout({ ...two("sp-a"), rev: 4 });
    });
    expect(rowKeys()).toEqual(["h:needs", "h:active", "s:s-5", "s:s-4", "s:s-1"]);
  });
});

/**
 * Snoozed and Archived rows drag as the others do (docs/notes/preview-tabs-2-row-drag.md). What a
 * drop runs is shell/drag/threadSource.test.ts's; here, which rows are drag sources and with what.
 */
describe("a Needs you row's lines, one per open request (docs/notes/needs-you-line-items.md)", () => {
  const req = (n: number, o: { question?: boolean; summary?: string } = {}) => ({ requestId: `req-${String(n)}`, itemId: `item-${String(n)}`, question: o.question ?? false, toolName: o.question ? "AskUserQuestion" : "Bash", summary: o.summary ?? `Bash cmd ${String(n)}` });
  const pending = (id: string, ...ps: ReturnType<typeof req>[]) => {
    act(() => {
      useThreadStore.setState((s) => ({ pending: { ...s.pending, [id]: { threadId: id, seq: 1, pending: ps } } }));
    });
  };
  const lines = (key: string) => within(rowOf(key)).queryAllByTestId("needs-line").map((l) => `${l.getAttribute("data-kind") ?? ""} ${l.textContent}`);

  it("several requests: a line each, oldest first, and \"N items\" for the status", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-2", req(1, { summary: "Bash git push --force-with-lease" }), req(2, { summary: "Bash gh pr edit 482" }), req(3, { question: true, summary: "Which base branch?" }));
    expect(lines("s:s-2")).toEqual(["permission Permission: git push --force-with-lease", "permission Permission: gh pr edit 482", "question Question: Which base branch?"]);
    const ask = within(rowOf("s:s-2")).getByTestId("row-ask");
    expect(ask.textContent).toBe("3 items");
    expect(ask.getAttribute("data-kind")).toBe("items");
    // The row is measured as drawn (no fixed height), so the lines make it taller.
    expect((rowOf("s:s-2").parentElement as HTMLElement).style.height).toBe("");
  });

  it("one request: no lines, the status word as before", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-2", req(1));
    expect(within(rowOf("s:s-2")).queryByTestId("needs-lines")).toBeNull();
    expect(within(rowOf("s:s-2")).getByTestId("row-ask").textContent).toBe("Permission");
  });

  it("only under Needs you: an Active row with open requests shows none", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-1", req(1), req(2));
    expect(rowOf("s:s-1").getAttribute("data-section")).not.toBe("needs");
    expect(within(rowOf("s:s-1")).queryByTestId("needs-lines")).toBeNull();
  });

  it("a line opens the popup on its request, and not the thread", async () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-2", req(1), req(2), req(3));
    fireEvent.click(within(rowOf("s:s-2")).getAllByTestId("needs-line")[1] as HTMLElement);
    await settle();
    expect(useNeedsStore.getState()).toMatchObject({ popup: "s-2", popupRequest: "req-2", dismissed: "sidebar:s-2#req-2" });
    expect(runs).toEqual([]);
    // The title still opens it on the oldest.
    act(() => {
      useNeedsStore.setState({ popup: null });
    });
    fireEvent.click(within(rowOf("s:s-2")).getByTestId("thread-name"));
    expect(useNeedsStore.getState()).toMatchObject({ popup: "s-2", popupRequest: null });
  });

  it("past four requests: three lines and \"+N more\", which opens the popup on the first not listed", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-2", ...[1, 2, 3, 4, 5, 6].map((n) => req(n)));
    expect(lines("s:s-2")).toHaveLength(3);
    const more = within(rowOf("s:s-2")).getByTestId("needs-line-more");
    expect(more.textContent).toBe("+3 more");
    expect(within(rowOf("s:s-2")).getByTestId("row-ask").textContent).toBe("6 items");
    fireEvent.click(more);
    expect(useNeedsStore.getState()).toMatchObject({ popup: "s-2", popupRequest: "req-4" });
  });

  it("a request answered leaves its line at once", () => {
    render(<ShellSidebarList bodyHeight={800} />);
    pending("s-2", req(1), req(2), req(3));
    act(() => {
      useThreadStore.setState({ answering: { "s-2": { "req-1": true } } });
    });
    expect(lines("s:s-2")).toEqual(["permission Permission: cmd 2", "permission Permission: cmd 3"]);
    expect(within(rowOf("s:s-2")).getByTestId("row-ask").textContent).toBe("2 items");
  });
});

// After a drag, dnd-kit swallows the next click for 50 ms (docs/notes/testing-gotchas.md): new describes go above this one.
describe("dragging Snoozed and Archived rows", () => {
  const started: DragStartEvent["active"]["data"]["current"][] = [];
  /** dnd-kit's context with ShellDnd's sensor (4px), recording each drag's source. */
  function Dnd({ children }: { children: ReactNode }) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
    return (
      <DndContext
        sensors={sensors}
        onDragStart={({ active }) => {
          started.push(active.data.current);
        }}
      >
        {children}
      </DndContext>
    );
  }
  /** Presses on the row and moves 10px: a drag starts if the row is a source. */
  const drag = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { clientX: 20, clientY: 10 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 10 });
  };

  beforeEach(() => {
    started.length = 0;
    useUiStore.setState({ snoozedCollapsed: false, archivedCollapsed: false });
    setThreads(
      thread({ id: "s-1" }),
      thread({ id: "s-7", name: "Spike a canvas sidebar", archivedAtMs: Date.now() - 60_000 }),
      thread({ id: "s-8", name: "Refactor the gh poller", snoozedUntilMs: Date.now() + 3_600_000 }),
    );
  });
  afterEach(() => {
    resetShellDrag();
  });

  // First: after a drag, dnd-kit swallows the next click for 50 ms (docs/notes/testing-gotchas.md).
  it("a click opens the thread as the space's preview (thread.open --preview), archived or snoozed; an active row's does not", async () => {
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    fireEvent.click(rowOf("s:s-7"));
    await settle();
    fireEvent.click(rowOf("s:s-8"));
    await settle();
    fireEvent.click(rowOf("s:s-1"));
    await settle();
    expect(runs).toEqual([
      { name: "thread.open", args: { id: "s-7", focus: "true", preview: "true" } },
      { name: "thread.open", args: { id: "s-8", focus: "true", preview: "true" } },
      { name: "thread.open", args: { id: "s-1", focus: "true" } },
    ]);
  });

  it("the keyboard's activate on an Archived or Snoozed row opens it as a preview too", async () => {
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    list().focus();
    for (const [key, press] of [
      ["s:s-7", "Enter"],
      ["s:s-8", " "],
    ] as const) {
      act(() => {
        useUiStore.getState().setCursor(key);
      });
      fireEvent.keyDown(list(), { key: press });
      await settle();
    }
    expect(runs).toEqual([
      { name: "thread.open", args: { id: "s-7", focus: "true", preview: "true" } },
      { name: "thread.open", args: { id: "s-8", focus: "true", preview: "true" } },
    ]);
  });

  it("keep their one line and carry the drag instructions, as an active row does", () => {
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    const [active, snoozed, archived] = [rowOf("s:s-1"), rowOf("s:s-8"), rowOf("s:s-7")];
    expect(snoozed.dataset.section).toBe("snoozed");
    expect(archived.dataset.section).toBe("archived");
    // The one-line look: the quiet name and the time, no status or branch lines.
    expect(within(archived).getByTestId("row-archived-age")).toBeTruthy();
    expect(within(snoozed).getByTestId("row-snooze-left")).toBeTruthy();
    expect(within(archived).queryByTestId("row-line-1")).toBeNull();
    const instructions = active.getAttribute("aria-describedby");
    expect(instructions).toBeTruthy();
    expect(snoozed.getAttribute("aria-describedby")).toBe(instructions);
    expect(archived.getAttribute("aria-describedby")).toBe(instructions);
  });

  it("a pointer drag lifts the row's thread; an archived one says so", () => {
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    drag(rowOf("s:s-7"));
    drag(rowOf("s:s-8"));
    expect(started).toEqual([
      { kind: "thread", thread: "s-7", archived: true },
      { kind: "thread", thread: "s-8" },
    ]);
  });

  it("no drag starts while the row's name is being edited", () => {
    useUiStore.setState({ renamingThreadId: "s-7" });
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    drag(screen.getByTestId("rename-input"));
    expect(started).toEqual([]);
    act(() => {
      useUiStore.setState({ renamingThreadId: null });
    });
  });

  it("the dragged row dims, as the other rows do", () => {
    render(
      <Dnd>
        <ShellSidebarList bodyHeight={800} />
      </Dnd>,
    );
    expect(rowOf("s:s-7").className).not.toContain("opacity-60");
    act(() => {
      useShellDragStore.setState({ source: { kind: "thread", thread: "s-7", archived: true } });
    });
    expect(rowOf("s:s-7").className).toContain("opacity-60");
    expect(rowOf("s:s-8").className).not.toContain("opacity-60");
  });

});
