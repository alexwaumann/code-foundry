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
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined, scrollToOffset: () => undefined };
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
  return { name, title, description: "", category: "View", args: [], keybindings: [], available: true };
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  // The mock's s-6 has a last activity a minute ago, which puts it first among the idle threads.
  // Every thread gets the list fields projectsWorld leaves out (no flags, no linked PRs).
  useThreadsStore.setState((st) => ({
    byId: Object.fromEntries(Object.entries(st.byId).map(([id, t]) => [id, Object.assign({ flags: [], linkedPullRequests: [] }, t, id === "s-6" ? { lastActivityAtMs: Date.now() - 60_000 } : {})])),
  }));
  setEmberEnabled(false);
  useUiStore.setState({ selection: HOME, cursorKey: null, sidebarVisible: true, workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
  useCommandsStore.setState({ commands: [cmd("thread.new", "New Thread"), cmd("thread.pin", "Pin Thread")] });
  daemon.commands = [...useCommandsStore.getState().commands];
});
afterEach(() => {
  cleanup();
});

const list = () => screen.getByTestId("thread-list");
const rowOf = (key: string) => list().querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
/**
 * Row keys in display order, the footers' headers as "# Label". The main list's own headers
 * (Needs you, Active: sidebar/shell's tests) are left out, so this reads the order and the footers.
 */
const rowKeys = () =>
  [...list().querySelectorAll("[data-row-key]")]
    .map((e) => (e.getAttribute("data-row-kind") === "header" ? `# ${e.textContent}` : (e.getAttribute("data-row-key") ?? "")))
    .filter((k) => !/^# (Needs you|Active)/.test(k));
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

  it("empty once loaded: the list is simply empty, no placeholder", () => {
    seedWorld({ empty: true });
    render(<Sidebar />);
    expect(list().textContent).toBe("");
    expect(screen.queryByTestId("thread-list-empty")).toBeNull();
  });

  it("a thread list that failed before it loaded: no rows, the list says why", () => {
    useThreadsStore.setState({ byId: {}, order: [], loaded: false, error: "deadline exceeded" });
    render(<Sidebar />);
    expect(list().querySelectorAll("[data-row-key]")).toHaveLength(0);
    expect(screen.getByTestId("thread-list-empty").textContent).toBe("Cannot list threads: deadline exceeded. Retrying…");
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

});

describe("Sidebar: the Snoozed and Archived footers", () => {
  it("Snoozed: collapsed by default with its count; expanded, one-line rows with the time left, soonest first; gone once none is snoozed", () => {
    setThread("s-8", { statusReason: "finished" });
    // The mock's s-9 wakes in 4 days and an hour.
    setThread("s-9", { snoozedUntilMs: Date.now() + (4 * 24 * 60 + 60) * 60_000 });
    render(<Sidebar />);
    const header = () => screen.getByTestId("snoozed-header");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("snoozed-label").textContent).toBe("Snoozed");
    expect(screen.getByTestId("snoozed-count").textContent).toBe("2");
    expect(header().getAttribute("aria-label") ?? header().textContent).toBe("Snoozed 2");
    expect(rowOf("s:s-8")).toBeNull();
    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(useUiStore.getState().snoozedCollapsed).toBe(false);
    expect(rowKeys()).toEqual(["s:s-2", "s:s-6", "s:s-4", "s:s-3", "# Working 2", "s:s-5", "s:s-1", "# Snoozed 2", "s:s-8", "s:s-9", "# Archived 1"]);
    const s8 = rowOf("s:s-8") as HTMLElement;
    expect(s8.getAttribute("data-section")).toBe("snoozed");
    expect(within(s8).getByTestId("thread-name").textContent).toBe("Refactor the gh poller");
    expect(within(s8).getByTestId("row-snooze-left").textContent).toBe("2h");
    expect(within(s8).getByTestId("row-snooze-icon")).toBeTruthy();
    expect(within(rowOf("s:s-9") as HTMLElement).getByTestId("row-snooze-left").textContent).toBe("4d");
    expect(within(s8).queryByTestId("row-line-1")).toBeNull();
    expect(within(s8).queryByTestId("row-actions")).toBeNull();
    // Both unsnoozed (as from the CLI): no section; s-8 is its finished turn again.
    setThread("s-8", { snoozedUntilMs: null });
    setThread("s-9", { snoozedUntilMs: null });
    expect(screen.queryByTestId("sidebar-snoozed")).toBeNull();
    expect(rowOf("s:s-8")?.getAttribute("data-section")).toBe("done");
  });

  it("Archived: collapsed by default with its count, last; expanded, the one-line row with its age; gone with no archived thread, back with one", () => {
    render(<Sidebar />);
    const header = () => screen.getByTestId("archived-header");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("archived-label").textContent).toBe("Archived");
    expect(screen.getByTestId("archived-count").textContent).toBe("1");
    expect(header().getAttribute("aria-label") ?? header().textContent).toBe("Archived 1");
    expect(rowOf("h:archived")?.getAttribute("role")).toBe("presentation");
    expect(rowOf("s:s-7")).toBeNull();
    expect(rowKeys().at(-1)).toBe("# Archived 1");
    fireEvent.click(header());
    expect(useUiStore.getState().archivedCollapsed).toBe(false);
    const s7 = rowOf("s:s-7") as HTMLElement;
    expect(s7.getAttribute("data-section")).toBe("archived");
    expect(within(s7).getByTestId("thread-name").textContent).toBe("Spike a canvas sidebar");
    expect(within(s7).getByTestId("row-archived-age").textContent).toBe("1h");
    expect(within(s7).queryByTestId("row-line-1")).toBeNull();
    // Unarchived (as from the CLI): no section; s-7 is back in the main list.
    setThread("s-7", { archivedAtMs: null, statusReason: "finished" });
    expect(screen.queryByTestId("sidebar-archived")).toBeNull();
    expect(screen.queryByTestId("archived-header")).toBeNull();
    expect(rowOf("s:s-7")?.getAttribute("data-section")).toBe("done");
    setThread("s-7", { archivedAtMs: Date.now() });
    expect(screen.getByTestId("archived-count").textContent).toBe("1");
  });

  describe("the open thread's row under a collapsed header", () => {
    const open = (id: string) => {
      act(() => {
        useUiStore.getState().select({ kind: "thread", id });
      });
    };

    it.each([
      ["Snoozed", "s-8", "snoozed", "2"],
      ["Archived", "s-7", "archived", "1"],
    ])("%s: the row shows under the collapsed header, selected, and goes when the window moves on", (_name, id, section, count) => {
      render(<Sidebar />);
      expect(rowOf(`s:${id}`)).toBeNull();
      open(id);
      const row = rowOf(`s:${id}`) as HTMLElement;
      expect(screen.getByTestId(`sidebar-${section}-rows`).contains(row)).toBe(true);
      expect(row.getAttribute("data-section")).toBe(section);
      expect(row.getAttribute("aria-selected")).toBe("true");
      // The header stays collapsed, with every thread's count.
      expect(screen.getByTestId(`${section}-header`).getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId(`${section}-count`).textContent).toBe(count);
      open("s-2");
      expect(rowOf(`s:${id}`)).toBeNull();
      expect(screen.getByTestId(`${section}-count`).textContent).toBe(count);
      open(id);
      act(() => {
        useUiStore.getState().select(HOME);
      });
      expect(rowOf(`s:${id}`)).toBeNull();
    });

    it("only the open thread's: the section's others stay out, and expanding shows them as ever", () => {
      render(<Sidebar />);
      open("s-9");
      expect(rowKeys()).toEqual([...DEFAULT_ORDER.slice(0, -1), "s:s-9", "# Archived 1"]);
      fireEvent.click(screen.getByTestId("snoozed-header"));
      expect(rowKeys()).toEqual([...DEFAULT_ORDER.slice(0, -1), "s:s-8", "s:s-9", "# Archived 1"]);
      fireEvent.click(screen.getByTestId("snoozed-header"));
      expect(rowKeys()).toEqual([...DEFAULT_ORDER.slice(0, -1), "s:s-9", "# Archived 1"]);
    });

    it("the arrows start from it and walk to it, and past it to the next footer's", () => {
      render(<Sidebar />);
      open("s-8");
      list().focus();
      press("ArrowUp");
      expect(active()).toBe("row-s:s-1");
      press("ArrowDown");
      expect(active()).toBe("row-s:s-8");
      expect(rowOf("s:s-8")?.getAttribute("data-cursor")).toBe("true");
      // The last row: it stays.
      press("ArrowDown");
      expect(active()).toBe("row-s:s-8");
      press("End");
      expect(active()).toBe("row-s:s-8");
    });

    it("Working is not affected: a working thread open under its collapsed header has no row", () => {
      useUiStore.setState({ workingCollapsed: true });
      render(<Sidebar />);
      open("s-5");
      expect(rowOf("s:s-5")).toBeNull();
      expect(screen.getByTestId("working-header").getAttribute("aria-expanded")).toBe("false");
    });

    it("a child thread never shows, snoozed or archived; its creator's row does not come either", () => {
      addThreads(thread("child-z", { createdBy: "s-8", snoozedUntilMs: Date.now() + 60_000 }), thread("child-a", { createdBy: "s-7", archivedAtMs: Date.now() }));
      render(<Sidebar />);
      for (const id of ["child-z", "child-a"]) {
        open(id);
        expect(rowOf(`s:${id}`)).toBeNull();
        expect(rowOf("s:s-8")).toBeNull();
        expect(rowOf("s:s-7")).toBeNull();
      }
      expect(screen.getByTestId("snoozed-count").textContent).toBe("2");
      expect(screen.getByTestId("archived-count").textContent).toBe("1");
    });

    it.each([
      // Woken: the top of Active, not Needs you (docs/notes/shell-model.md, "Sidebar").
      ["woken", "s-8", { snoozedUntilMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() }, "snoozed", "attention"],
      ["unarchived", "s-7", { archivedAtMs: null, statusReason: "finished" }, "archived", "done"],
    ])("%s while open, it just moves to the main list", (_name, id, change, from, to) => {
      render(<Sidebar />);
      open(id);
      setThread(id, change as Partial<ThreadView>);
      expect(screen.getByTestId("thread-list").querySelectorAll(`[data-row-key="s:${id}"]`)).toHaveLength(1);
      expect(rowOf(`s:${id}`)?.getAttribute("data-section")).toBe(to);
      expect(rowOf(`s:${id}`)?.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByTestId("sidebar-main").contains(rowOf(`s:${id}`))).toBe(true);
      if (from === "snoozed") expect(screen.getByTestId("snoozed-count").textContent).toBe("1");
      else expect(screen.queryByTestId("sidebar-archived")).toBeNull();
    });
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
  it("has New thread, current on a composer, and no Pull Requests or Projects rows (they are tabs); no title band", () => {
    useUiStore.setState({ selection: { kind: "compose", projectId: "" } as never });
    render(<Sidebar />);
    expect(current()).toEqual(["sidebar-new-thread"]);
    expect(screen.getByTestId("sidebar-new-thread").className).toContain("bg-cf-sidebar-row-selected");
    expect(screen.queryByTestId("nav-pullrequests")).toBeNull();
    expect(screen.queryByTestId("nav-projects")).toBeNull();
    expect(screen.queryByTestId("sidebar-band")).toBeNull();
    expect(list().hasAttribute("data-shell-list")).toBe(true);
  });
  const current = () => [...screen.getByTestId("sidebar-menu").querySelectorAll('[aria-current="page"]')].map((e) => e.getAttribute("data-testid"));

});

describe("Sidebar: Ember's row", () => {
  it("the arrows reach it from the thread list: Home lands on it, Enter opens its chat, ↓ leaves for the first thread and ↑ comes back", () => {
    setEmberEnabled(true);
    const { byId, order } = useThreadsStore.getState();
    putEmberThread({}, order.map((id) => byId[id] as ThreadView));
    new EmberWorld().publish();
    render(<Sidebar />);
    // The thread list never lists Ember itself: its row is the pinned one above.
    expect(rowOf(`s:${EMBER_THREAD}`)).toBeNull();
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
