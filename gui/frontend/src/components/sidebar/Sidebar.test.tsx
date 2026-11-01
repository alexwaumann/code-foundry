import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";

// jsdom lays nothing out, so TanStack Virtual would render no rows: this stand-in renders
// every row at its estimated size (the real one's window over the rows is e2e's).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number; gap?: number; paddingStart?: number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = o.paddingStart ?? 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size + (o.gap ?? 0);
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined };
  },
}));
// The board stream and the viewer's dashboard are the stores'; nothing here reads them.
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));
vi.mock("./useLinkedPrs", async (orig) => ({ ...(await orig<typeof import("./useLinkedPrs")>()), useSidebarDashboard: () => undefined }));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { Sidebar } = await import("./Sidebar");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadsStore } = await import("@/stores/threads");
const { HOME, useUiStore } = await import("@/stores/ui");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, seedWorld, thread } = await import("@/test/projectsWorld");
const { EMBER_THREAD, putEmberThread, setEmberEnabled, EmberWorld } = await import("@/test/emberBoard");

/**
 * The sidebar over the mock daemon's world (src/test/projectsWorld.ts): s-2 waiting, s-6,
 * s-4 and s-3 idle, s-5 and s-1 working, s-8 and s-9 snoozed, s-7 archived. The order
 * rules are lib/tree.test.ts's and a row's lines SidebarRow.test.tsx's; this is the list
 * they make: its rows and headers, the keyboard, the footers, the menu pane.
 */

const DEFAULT_ORDER = ["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "# Archived 1"];

function cmd(name: string, title: string): CommandView {
  return { name, title, description: "", category: "View", args: [], keybindings: [], available: true } as CommandView;
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  // The mock's s-6 has a last activity a minute ago, which puts it first among the idle threads.
  // Every thread gets the list fields projectsWorld leaves out (no flags, no linked PRs).
  useThreadsStore.setState((st) => ({
    byId: Object.fromEntries(Object.entries(st.byId).map(([id, t]) => [id, { flags: [], linkedPullRequests: [], ...t, ...(id === "s-6" ? { lastActivityAtMs: Date.now() - 60_000 } : {}) }])),
    availability: "unknown",
  }) as never);
  setEmberEnabled(false);
  useUiStore.setState({ selection: HOME, cursorKey: null, sidebarVisible: true, workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
  useCommandsStore.setState({ commands: [cmd("thread.new", "New Thread"), cmd("thread.pin", "Pin Thread")] });
  daemon.commands = useCommandsStore.getState().commands;
});
afterEach(cleanup);

const list = () => screen.getByTestId("thread-list");
const rowOf = (key: string) => list().querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
/** Row keys in display order, headers as "# Label". */
const rowKeys = () =>
  [...list().querySelectorAll("[data-row-key]")].map((e) => (e.getAttribute("data-row-kind") === "header" ? `# ${e.textContent}` : (e.getAttribute("data-row-key") ?? "")));
const press = (key: string) => {
  fireEvent.keyDown(list(), { key });
};
const active = () => list().getAttribute("aria-activedescendant");
const live = (f: () => void) => {
  act(f);
};
const setThread = (id: string, o: Partial<ThreadView>) => {
  live(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), ...o } } }));
  });
};

describe("Sidebar: the thread list", () => {
  it("is a flat listbox of thread rows: waiting on top, idle newest first, then the Working, Snoozed and Archived headers", () => {
    render(<Sidebar />);
    expect(rowKeys()).toEqual(DEFAULT_ORDER);
    expect(list().getAttribute("role")).toBe("listbox");
    expect(list().getAttribute("aria-label")).toBe("Threads");
    // No project, worktree or terminal rows: only threads and the footers' headers.
    expect(list().querySelectorAll('[data-row-kind]:not([data-row-kind="thread"]):not([data-row-kind="header"])')).toHaveLength(0);
    expect(screen.getByTestId("sidebar-band").textContent).toContain("Code Foundry");
  });

  it("the keyboard: Home is the first row, ↓ moves, Enter selects; End is the last row; ↑ skips the Working header", () => {
    render(<Sidebar />);
    press("Home");
    expect(active()).toBe("row-s:s-2");
    press("ArrowDown");
    expect(active()).toBe("row-s:s-6");
    press("Enter");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-6" });
    expect(rowOf("s:s-6")?.getAttribute("aria-selected")).toBe("true");
    press("End");
    expect(active()).toBe("row-s:s-1");
    press("ArrowUp");
    press("ArrowUp");
    expect(active()).toBe("row-s:s-3");
  });

  it("each row carries its badge: stopped (crashed or closing) reads idle, starting reads working; nothing says whether Claude runs", () => {
    setThread("s-5", { statusChangedAtMs: Date.now() - 5_000 });
    render(<Sidebar />);
    const badge = (id: string) => rowOf(`s:${id}`)?.querySelector("[data-thread-badge]")?.getAttribute("data-thread-badge");
    expect(["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"].map(badge)).toEqual(["busy", "attention", "idle", "idle", "busy", "idle"]);
    expect(rowOf("s:s-5")?.getAttribute("data-section")).toBe("working");
    expect(within(rowOf("s:s-5") as HTMLElement).getByTestId("row-status").textContent).toMatch(/^Working \d+[smhd]/);
    for (const id of ["s-3", "s-4", "s-6"]) expect(within(rowOf(`s:${id}`) as HTMLElement).getByTestId("thread-body").hasAttribute("data-offline")).toBe(false);
    expect(list().textContent).not.toMatch(/disconnected|starting|closing/i);
  });

  it("a stopped thread keeps its status: busy ends interrupted; a prompt stays on top, waiting, with its word and detail", () => {
    render(<Sidebar />);
    // The daemon's stop of a busy thread (internal/store/thread): error, interrupted.
    setThread("s-1", { state: "disconnected", status: "error", statusReason: "interrupted", statusChangedAtMs: Date.now() });
    const s1 = rowOf("s:s-1") as HTMLElement;
    expect(s1.querySelector("[data-thread-badge]")?.getAttribute("data-thread-badge")).toBe("error");
    expect(within(s1).getByTestId("row-status").textContent).toBe("Interrupted");
    expect(within(s1).getByTestId("row-detail").textContent).toBe("resend to continue");
    setThread("s-2", { state: "disconnected", status: "attention", statusReason: "permission: Bash zig build -Doptimize=ReleaseFast" });
    expect(rowKeys()[0]).toBe("s:s-2");
    const s2 = rowOf("s:s-2") as HTMLElement;
    expect(s2.querySelector("[data-thread-badge]")?.getAttribute("data-thread-badge")).toBe("attention");
    expect(within(s2).getByTestId("row-status").textContent).toBe("Permission");
    expect(within(s2).getByTestId("row-detail").textContent).toBe("Bash zig build -Doptimize=ReleaseFast");
  });

  it("empty once loaded: the list is simply empty, no placeholder", () => {
    seedWorld({ empty: true });
    render(<Sidebar />);
    expect(list().textContent).toBe("");
    expect(screen.queryByTestId("thread-list-empty")).toBeNull();
  });

  it("a daemon without ThreadService: no rows, the list says so and the status row says service unavailable", () => {
    useThreadsStore.setState({ byId: {}, order: [], loaded: false, availability: "unavailable", error: "unimplemented: codefoundry.v1.ThreadService" } as never);
    render(<Sidebar />);
    expect(list().querySelectorAll("[data-row-key]")).toHaveLength(0);
    expect(screen.getByTestId("thread-list-empty").textContent).toBe("Threads are unavailable on this daemon.");
    expect(screen.getByTestId("threads-unavailable").textContent).toBe("Threads: service unavailable");
  });
});

describe("Sidebar: the Working footer", () => {
  const header = () => screen.getByTestId("working-header");

  it("a header with its count collapses and expands its rows; the selection stays; the keyboard skips hidden rows", () => {
    render(<Sidebar />);
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("working-label").textContent).toBe("Working");
    expect(screen.getByTestId("working-count").textContent).toBe("2");
    expect(header().getAttribute("aria-label") ?? header().textContent).toBe("Working 2");
    // Not an option of the listbox: the row is presentation.
    expect(rowOf("h:working")?.getAttribute("role")).toBe("presentation");

    fireEvent.click(rowOf("s:s-1")?.querySelector('[data-testid="thread-body"]') ?? (rowOf("s:s-1") as HTMLElement));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(useUiStore.getState().workingCollapsed).toBe(true);
    expect(rowOf("s:s-1")).toBeNull();
    expect(rowOf("s:s-5")).toBeNull();
    expect(screen.getByTestId("working-count").textContent).toBe("2");
    expect(rowKeys()).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "# Snoozed 2", "# Archived 1"]);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });

    // End reaches the main list's last row and ↓ stays there.
    press("End");
    expect(active()).toBe("row-s:s-3");
    press("ArrowDown");
    expect(active()).toBe("row-s:s-3");

    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(rowKeys().slice(4)).toEqual(["# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "# Archived 1"]);
  });

  it("collapsed from the start (the persisted choice) it shows no rows", () => {
    useUiStore.setState({ workingCollapsed: true });
    render(<Sidebar />);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(rowOf("s:s-1")).toBeNull();
    expect(rowOf("s:s-2")).not.toBeNull();
  });

  it("counts threads as they start and stop working; a pinned working thread stays on top; the header goes with the last one", () => {
    render(<Sidebar />);
    live(() => {
      addThreads(thread("s-job", { name: "Job 1", state: "connected", status: "busy", createdAtMs: Date.now() + 1, flags: [], linkedPullRequests: [] }));
    });
    expect(screen.getByTestId("working-count").textContent).toBe("3");
    expect(rowKeys().slice(4, 8)).toEqual(["# Working 3", "s:s-job", "s:s-5", "s:s-1"]);
    setThread("s-job", { pinned: true });
    expect(rowKeys()[0]).toBe("s:s-job");
    expect(rowOf("s:s-job")?.getAttribute("data-section")).toBe("pinned");
    expect(screen.getByTestId("working-count").textContent).toBe("2");
    setThread("s-1", { status: "idle" });
    expect(screen.getByTestId("working-count").textContent).toBe("1");
    expect(rowOf("s:s-1")?.getAttribute("data-section")).toBe("idle");
    setThread("s-5", { state: "disconnected", status: "idle" });
    expect(screen.queryByTestId("working-header")).toBeNull();
    expect(rowKeys().filter((k) => k.startsWith("#"))).toEqual(["# Snoozed 2", "# Archived 1"]);
  });
});

describe("Sidebar: the row menu", () => {
  it("Pin runs thread.pin for the row; pinned, the row moves to the top with its glyph; Unpin moves it back", async () => {
    daemon.handlers.set("thread.pin", (inv) => {
      setThread(inv.context.activeThreadId, { pinned: inv.args.pinned === "true" });
      return { message: "", resultJson: "" };
    });
    render(<Sidebar />);
    const openMenu = async (key: string) => {
      fireEvent.contextMenu(rowOf(key) as HTMLElement);
      return screen.findByTestId("row-menu");
    };
    fireEvent.click(within(await openMenu("s:s-3")).getByTestId("menu-pin"));
    await vi.waitFor(() => {
      expect(rowKeys().slice(0, 2)).toEqual(["s:s-3", "s:s-2"]);
    });
    expect(lastInvocation("thread.pin")).toMatchObject({ args: { pinned: "true" }, context: { activeThreadId: "s-3" } });
    expect(rowOf("s:s-3")?.getAttribute("data-section")).toBe("pinned");
    expect(within(rowOf("s:s-3") as HTMLElement).getByTestId("row-pinned")).toBeTruthy();

    const menu = await openMenu("s:s-3");
    expect(within(menu).getByTestId("menu-pin").textContent).toBe("Unpin");
    fireEvent.click(within(menu).getByTestId("menu-pin"));
    await vi.waitFor(() => {
      expect(rowKeys().slice(0, 4)).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3"]);
    });
    expect(rowOf("s:s-3")?.getAttribute("data-section")).toBe("idle");
  });
});

describe("Sidebar: Regenerate name", () => {
  it("runs thread.regenerate-name for the row; the old name shows muted and italic while it runs, then the new one", async () => {
    daemon.handlers.set("thread.regenerate-name", (inv) => {
      setThread(inv.args.id ?? "", { naming: true });
      return { message: "", resultJson: "" };
    });
    useCommandsStore.setState((s) => ({ commands: [...s.commands, cmd("thread.regenerate-name", "Regenerate Thread Name")] }));
    render(<Sidebar />);
    fireEvent.contextMenu(rowOf("s:s-3") as HTMLElement);
    fireEvent.click(within(await screen.findByTestId("row-menu")).getByTestId("menu-regenerate-name"));
    const name = () => within(rowOf("s:s-3") as HTMLElement).getByTestId("thread-name");
    await vi.waitFor(() => {
      expect(name().getAttribute("data-provisional")).toBe("true");
    });
    expect(name().textContent).toBe("Fix resize race");
    expect(lastInvocation("thread.regenerate-name")).toMatchObject({ args: { id: "s-3" }, context: { activeThreadId: "s-3" } });
    setThread("s-3", { naming: false, name: "Regenerated thread name" });
    expect(name().textContent).toBe("Regenerated thread name");
    expect(name().getAttribute("data-provisional")).toBeNull();
  });
});

describe("Sidebar: the menu pane", () => {
  const current = () => [...screen.getByTestId("sidebar-menu").querySelectorAll('[aria-current="page"]')].map((e) => e.getAttribute("data-testid"));

  it("marks the current page: New thread on a composer, Projects, Pull Requests", () => {
    useUiStore.setState({ selection: { kind: "compose", projectId: "" } as never });
    render(<Sidebar />);
    expect(screen.queryByTestId("sidebar-toolbar")).toBeNull();
    expect(current()).toEqual(["sidebar-new-thread"]);
    expect(screen.getByTestId("sidebar-new-thread").className).toContain("bg-cf-sidebar-row-selected");
    for (const id of ["nav-projects", "nav-pullrequests"]) {
      fireEvent.click(screen.getByTestId(id));
      expect(current()).toEqual([id]);
      expect(screen.getByTestId(id).className).toContain("bg-cf-sidebar-row-selected");
    }
    live(() => {
      useUiStore.getState().select({ kind: "compose", projectId: "repo-cf" } as never);
    });
    expect(current()).toEqual(["sidebar-new-thread"]);
  });
});

describe("Sidebar: Ember's row", () => {
  it("the arrows reach it from the thread list: Home lands on it, Enter opens its chat, ↓ leaves for the first thread and ↑ comes back", () => {
    setEmberEnabled(true);
    const { byId, order } = useThreadsStore.getState();
    putEmberThread({}, order.map((id) => byId[id] as ThreadView));
    new EmberWorld().publish();
    render(<Sidebar />);
    const cursorOnEmber = () => screen.getByTestId("sidebar-ember").getAttribute("data-cursor");
    press("Home");
    expect(active()).toBe("row-ember");
    expect(cursorOnEmber()).toBe("true");
    press("Enter");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: EMBER_THREAD });
    press("ArrowDown");
    expect(active()).toBe("row-s:s-2");
    expect(cursorOnEmber()).toBeNull();
    press("ArrowUp");
    expect(active()).toBe("row-ember");
    expect(cursorOnEmber()).toBe("true");
  });
});
