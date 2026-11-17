import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

// jsdom lays nothing out: this stand-in draws every icon at its estimate (the real window and the scrolling are e2e's).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number; gap?: number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size + (i < o.count - 1 ? (o.gap ?? 0) : 0);
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, measureElement: () => undefined, scrollToIndex: () => undefined, scrollToOffset: () => undefined };
  },
}));
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));
vi.mock("@/components/sidebar/useLinkedPrs", async (orig) => ({ ...(await orig<typeof import("@/components/sidebar/useLinkedPrs")>()), useSidebarDashboard: () => undefined }));
const runs: { name: string; args: Record<string, string> }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
vi.mock("@/api/threadSearch", async (orig) => ({ ...(await orig<typeof import("@/api/threadSearch")>()), readAskItems: () => new Promise(() => undefined) }));

const { Sidebar } = await import("../Sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { toggleSidebar } = await import("@/keys/bindings");
const { resetLayout } = await import("@/stores/layout");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useSettingsStore } = await import("@/stores/settings");
const { useShellSidebarStore } = await import("@/stores/shellSidebar");
const { HOME, useUiStore } = await import("@/stores/ui");
const { startSelectionBridge } = await import("@/stores/selectionBridge");
const { resetNeeds, useNeedsStore } = await import("@/stores/needs");
const { useThreadStore } = await import("@/stores/thread");
const { railGroupHeight } = await import("./railLook");

/**
 * The collapsed sidebar's rail (docs/notes/sidebar-rail.md): which icons it draws for which rows
 * and sections, and that an icon does what its expanded row does (click, hover card, menu, keys).
 * The geometry, the scrolling and its fades are e2e (sidebar-rail.spec.ts).
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

const PROJECT = { id: "api", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/w/api", branch: "feat/sidebar", head: "a", isMain: true }] };
const cmd = (name: string, title: string): CommandView => ({ name, title, description: "", category: "View", args: [], keybindings: [], available: true });
const ask = (id: string, reason: string, at = Date.now()) => thread({ id, name: `Ask ${id}`, status: "attention", statusReason: reason, statusChangedAtMs: at });

function setThreads(...ts: ThreadView[]): void {
  act(() => {
    useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
  });
}

let stop: () => void = () => undefined;

beforeEach(async () => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: JSON.stringify({ rev: 0, changed: false }) });
  });
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  useShellSidebarStore.setState({ needsCollapsed: false, activeCollapsed: false });
  resetNeeds();
  useSettingsStore.setState({ snapshot: null });
  useCommandsStore.setState({ commands: [cmd("thread.new", "New Thread"), cmd("search.open", "Search Threads"), cmd("ui.palette.open", "Command Palette"), cmd("view.usage", "Usage"), cmd("view.help", "Help"), cmd("view.settings", "Settings")] });
  useUiStore.setState({ selection: HOME, cursorKey: null, sidebarExpanded: false, workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
  useProjectsStore.setState({ byId: { api: PROJECT } as never, order: ["api"] });
  setThreads(
    thread({ id: "s-1" }),
    ask("s-2", "permission"),
    thread({ id: "s-3", name: "Broke", status: "error", statusReason: "error: boom" }),
    thread({ id: "s-4", name: "Pinned", pinned: true }),
    thread({ id: "s-5", name: "Busy", status: "busy" }),
  );
  await seedLayout(
    layoutOf([
      space(pane("p-1", [tab("t-1", "thread", "s-1", { key: "thread:s-1" })], "t-1"), "p-1", { drafts: [{ id: "d-1", label: "Release notes", params: {} }] }),
    ]),
  );
  useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
  stop = startSelectionBridge();
});

afterEach(() => {
  stop();
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  resetLayout();
});

function show() {
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>,
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const rail = () => screen.getByTestId("sidebar-rail");
const list = () => screen.getByTestId("rail-list");
const keysIn = (testId: string) => [...screen.getByTestId(testId).querySelectorAll("[data-row-key]")].map((e) => e.getAttribute("data-row-key"));
const icon = (key: string) => rail().querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`) as HTMLElement;
const glyph = (key: string) => within(icon(key)).getByTestId("rail-row-icon");
const separators = () => [...rail().querySelectorAll('[data-testid="rail-separator"]')];

describe("the sidebar's toggle", () => {
  it("switches between the expanded list and the rail; nothing hides the sidebar any more", () => {
    useUiStore.setState({ sidebarExpanded: true });
    show();
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    act(() => {
      toggleSidebar();
    });
    expect(useUiStore.getState().sidebarExpanded).toBe(false);
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(rail()).toBeTruthy();
    act(() => {
      toggleSidebar();
    });
    expect(useUiStore.getState().sidebarExpanded).toBe(true);
    expect(screen.getByTestId("sidebar")).toBeTruthy();
  });

  it("a rename from the rail (F2) opens the expanded list, where the rename field is", () => {
    show();
    list().focus();
    fireEvent.keyDown(list(), { key: "End" });
    fireEvent.keyDown(list(), { key: "F2" });
    expect(useUiStore.getState().sidebarExpanded).toBe(true);
    expect(useUiStore.getState().renamingThreadId).toBe("s-1");
    expect(screen.getByTestId("rename-input")).toBeTruthy();
  });
});

describe("the rail's icons", () => {
  it("lists Needs you, then Active in the expanded list's order (pinned first, the drafts below them); no headers", () => {
    show();
    expect(keysIn("rail-needs")).toEqual(["s:s-2"]);
    expect(keysIn("rail-active")).toEqual(["s:s-4", "d:d-1", "s:s-3", "s:s-1"]);
    expect(rail().querySelector('[data-row-kind="header"]')).toBeNull();
    // Working is a footer: no row of it on the rail.
    expect(icon("s:s-5")).toBeNull();
  });

  it.each([
    ["s:s-2", "input", "text-cf-warning-text", "lucide-shield-question-mark"],
    ["s:s-3", "error", "text-cf-error-text", "lucide-circle-alert"],
    ["s:s-1", "thread", "text-cf-sidebar-muted-foreground", "lucide-message-square"],
    ["d:d-1", "draft", "text-cf-sidebar-muted-foreground", "lucide-pencil-line"],
  ])("%s's icon: %s in %s", (key, kind, tone, lucide) => {
    show();
    const g = glyph(key);
    expect(g.getAttribute("data-kind")).toBe(kind);
    expect(g.getAttribute("class")).toContain(tone);
    expect(g.getAttribute("class")).toContain(lucide);
  });

  it("a Needs you icon is its ask's: a plan, a question", () => {
    setThreads(ask("s-2", "plan"), ask("s-6", "question", Date.now() - 1000));
    show();
    expect(keysIn("rail-needs")).toEqual(["s:s-2", "s:s-6"]);
    expect(glyph("s:s-2").getAttribute("data-kind")).toBe("plan");
    expect(glyph("s:s-6").getAttribute("data-kind")).toBe("question");
  });

  it("a pinned thread carries the pin on its icon's corner; the others none", () => {
    show();
    expect(within(icon("s:s-4")).getByTestId("rail-pinned")).toBeTruthy();
    expect(within(icon("s:s-1")).queryByTestId("rail-pinned")).toBeNull();
  });

  it("the open thread's icon takes the selected fill", () => {
    show();
    expect(icon("s:s-1").getAttribute("aria-selected")).toBe("true");
    expect(icon("s:s-1").className).toContain("bg-cf-sidebar-row-selected");
    expect(icon("s:s-3").className).not.toContain("bg-cf-sidebar-row-selected");
  });

  it("collapsed Needs you and Active headers in the expanded list still list their rows here (the rail has no headers)", () => {
    useShellSidebarStore.setState({ needsCollapsed: true, activeCollapsed: true });
    show();
    expect(keysIn("rail-needs")).toEqual(["s:s-2"]);
    expect(keysIn("rail-active")).toHaveLength(4);
  });

  it("Needs you is at most four icons tall; more scroll inside it", () => {
    setThreads(...Array.from({ length: 6 }, (_, i) => ask(`n-${String(i)}`, "permission", Date.now() - i * 1000)));
    show();
    expect(keysIn("rail-needs")).toHaveLength(6);
    expect(screen.getByTestId("rail-needs").style.height).toBe(`${String(railGroupHeight(4))}px`);
    setThreads(ask("n-0", "permission"), ask("n-1", "permission", Date.now() - 1000));
    expect(screen.getByTestId("rail-needs").style.height).toBe(`${String(railGroupHeight(2))}px`);
  });
});

describe("the rail's separators", () => {
  it("menu, Ember (absent here), Needs you, a separator, Active, a separator, Working, a separator, the footer", () => {
    show();
    // Needs you's, the bottom sections', the footer's.
    expect(separators()).toHaveLength(3);
    expect(screen.getByTestId("rail-needs").nextElementSibling?.getAttribute("data-testid")).toBe("rail-separator");
  });

  it("no Needs you: neither its group nor its separator", () => {
    setThreads(thread({ id: "s-1" }));
    show();
    expect(screen.queryByTestId("rail-needs")).toBeNull();
    // Only the footer's: no Working, Snoozed or Archived either.
    expect(separators()).toHaveLength(1);
  });
});

describe("Working, Snoozed and Archived", () => {
  const HOUR = 3_600_000;
  const sections = () => {
    setThreads(
      thread({ id: "s-1" }),
      thread({ id: "w-1", name: "Index the docs", status: "busy" }),
      thread({ id: "w-2", name: "Refactor sidebar tree", status: "busy" }),
      thread({ id: "z-1", name: "Bump wails", snoozedUntilMs: Date.now() + 4 * 24 * HOUR }),
      thread({ id: "z-2", name: "Refactor the gh poller", snoozedUntilMs: Date.now() + 2 * HOUR + 5 * 60_000 }),
      thread({ id: "a-1", name: "Spike a canvas sidebar", archivedAtMs: Date.now() - HOUR }),
      thread({ id: "a-2", name: "Old spike", archivedAtMs: Date.now() - 2 * HOUR }),
    );
  };
  /** Opens a section's card as hovering does (Radix's trigger opens on focus too), past its open delay. */
  const openCard = async (section: string) => {
    act(() => {
      screen.getByTestId(`rail-${section}`).focus();
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    return screen.getByTestId(`rail-${section}-card`);
  };
  const cardKeys = (card: HTMLElement) => [...card.querySelectorAll("[data-row-key]")].map((e) => e.getAttribute("data-row-key"));

  it("an icon each while the expanded sidebar would show the section, named with its count, no count drawn", () => {
    sections();
    show();
    expect(screen.getByTestId("rail-working").getAttribute("aria-label")).toBe("Working · 2");
    expect(screen.getByTestId("rail-working").textContent).toBe("");
    expect(screen.getByTestId("rail-working").querySelector("svg")?.getAttribute("class")).toContain("text-cf-info-text");
    expect(screen.getByTestId("rail-snoozed").getAttribute("aria-label")).toBe("Snoozed · 2");
    expect(screen.getByTestId("rail-archived").getAttribute("aria-label")).toBe("Archived · 2");
  });

  it("none while the sections are empty", () => {
    setThreads(thread({ id: "s-1" }));
    show();
    expect(screen.queryByTestId("rail-working")).toBeNull();
    expect(screen.queryByTestId("rail-snoozed")).toBeNull();
    expect(screen.queryByTestId("rail-archived")).toBeNull();
  });

  it("no card until hovered or focused", () => {
    sections();
    show();
    expect(screen.queryByTestId("rail-working-card")).toBeNull();
  });

  it.each([
    ["working", "Working", ["s:w-2", "s:w-1"]],
    // The soonest wake first.
    ["snoozed", "Snoozed", ["s:z-2", "s:z-1"]],
    ["archived", "Archived", ["s:a-1", "s:a-2"]],
  ])("%s's card: its name and count on top, then its rows in the expanded sidebar's order", async (section, label, keys) => {
    sections();
    useUiStore.setState({ sidebarExpanded: true, workingCollapsed: false, snoozedCollapsed: false, archivedCollapsed: false });
    show();
    expect(keysIn(`sidebar-${section}-rows`)).toEqual(keys);
    cleanup();
    useUiStore.setState({ sidebarExpanded: false });
    show();
    const card = await openCard(section);
    expect(within(card).getByTestId("rail-card-label").textContent).toBe(label);
    expect(within(card).getByTestId("rail-card-count").textContent).toBe("2");
    expect(cardKeys(card)).toEqual(keys);
    expect(within(card).getByRole("listbox").getAttribute("aria-label")).toBe(label);
  });

  it("the rows are the expanded sidebar's: a Working row's project, status, name and branch; a Snoozed row's wake time; an Archived row's one line", async () => {
    sections();
    show();
    const working = await openCard("working");
    const row = working.querySelector('[data-row-key="s:w-1"]') as HTMLElement;
    expect(within(row).getByTestId("row-project").textContent).toBe("code-foundry");
    expect(within(row).getByTestId("thread-name").textContent).toBe("Index the docs");
    expect(within(row).getByTestId("row-branch").textContent).toBe("feat/sidebar");
    expect(within(row).getByTestId("thread-body").getAttribute("data-status-line")).toBe("working");
    cleanup();
    show();
    const snoozed = await openCard("snoozed");
    expect((snoozed.querySelector('[data-row-key="s:z-2"]') as HTMLElement).textContent).toContain("Refactor the gh poller");
    expect((snoozed.querySelector('[data-row-key="s:z-2"]') as HTMLElement).textContent).toContain("2h");
    cleanup();
    show();
    const archived = await openCard("archived");
    expect((archived.querySelector('[data-row-key="s:a-1"]') as HTMLElement).textContent).toContain("Spike a canvas sidebar");
  });

  it("lists the rows while the section is collapsed in the expanded sidebar, and leaves that state alone", async () => {
    sections();
    useUiStore.setState({ workingCollapsed: true, snoozedCollapsed: true, archivedCollapsed: true });
    show();
    expect(cardKeys(await openCard("working"))).toEqual(["s:w-2", "s:w-1"]);
    expect(cardKeys(await openCard("archived"))).toEqual(["s:a-1", "s:a-2"]);
    expect(useUiStore.getState()).toMatchObject({ workingCollapsed: true, snoozedCollapsed: true, archivedCollapsed: true });
  });

  it("a row's click opens its thread as the expanded row's does, and the card closes", async () => {
    sections();
    show();
    const card = await openCard("archived");
    fireEvent.click(card.querySelector('[data-row-key="s:a-2"]') as HTMLElement);
    await settle();
    // An Archived row opens the thread as the space's preview tab.
    expect(runs.at(-1)).toMatchObject({ name: "thread.open", args: { id: "a-2" } });
    expect(runs.at(-1)?.args.preview).toBe("true");
    expect(screen.queryByTestId("rail-archived-card")).toBeNull();
  });

  it("a right click on a row shows the row's own menu, and the card stays open under it", async () => {
    sections();
    show();
    const card = await openCard("working");
    fireEvent.contextMenu(card.querySelector('[data-row-key="s:w-2"]') as HTMLElement);
    const menu = await screen.findByTestId("row-menu");
    expect(menu.getAttribute("data-thread")).toBe("w-2");
    expect([...menu.querySelectorAll('[role="menuitem"]')][0]?.textContent).toBe("Open");
    // The icon's blur would shut the card; the menu holds it.
    act(() => {
      screen.getByTestId("rail-working").blur();
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(screen.getByTestId("rail-working-card")).toBeTruthy();
    expect(useUiStore.getState().cursorKey).toBe("s:w-2");
  });
});

describe("the rail's menu and footer", () => {
  it("New thread and search in the menu pane; palette, usage and settings and the daemon's dot at the bottom; no help", () => {
    show();
    expect(within(screen.getByTestId("rail-menu")).getByTestId("rail-new-thread").getAttribute("aria-label")).toBe("New Thread");
    expect(within(screen.getByTestId("rail-menu")).getByTestId("rail-search").getAttribute("aria-label")).toBe("Search Threads");
    const footer = screen.getByTestId("rail-footer");
    expect(within(footer).getByTestId("status-palette")).toBeTruthy();
    expect(within(footer).getByTestId("status-usage")).toBeTruthy();
    expect(within(footer).getByTestId("status-settings")).toBeTruthy();
    expect(within(footer).queryByTestId("status-help")).toBeNull();
    expect(within(footer).getByTestId("status")).toBeTruthy();
    expect(within(footer).queryByTestId("version")).toBeNull();
  });

  it("search opens the thread find", async () => {
    show();
    fireEvent.click(screen.getByTestId("rail-search"));
    await settle();
    expect(useUiStore.getState().palette).toMatchObject({ open: true, page: "search" });
  });
});

describe("an icon behaves as its row", () => {
  it("a click opens the thread as a row click does (a Needs you icon too): thread.open", async () => {
    show();
    fireEvent.click(icon("s:s-3"));
    await settle();
    expect(runs).toEqual([{ name: "thread.open", args: { id: "s-3", focus: "true" } }]);
    fireEvent.click(icon("s:s-2"));
    await settle();
    expect(runs.at(-1)).toEqual({ name: "thread.open", args: { id: "s-2", focus: "true" } });
  });

  it("a right click shows the row's menu (Open ▸ first); a draft's, Open and Discard", async () => {
    show();
    fireEvent.contextMenu(icon("s:s-3"));
    const menu = await screen.findByTestId("row-menu");
    expect(menu.getAttribute("data-thread")).toBe("s-3");
    expect([...menu.querySelectorAll('[role="menuitem"]')][0]?.textContent).toBe("Open");
    fireEvent.keyDown(menu, { key: "Escape" });
    cleanup();
    show();
    fireEvent.contextMenu(icon("d:d-1"));
    const draft = await screen.findByTestId("draft-menu");
    expect([...draft.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toEqual(["Open", "Discard"]);
  });

  it("hovering an Active icon shows the row's thread card, beside the rail", () => {
    vi.useFakeTimers();
    show();
    fireEvent.pointerMove(icon("s:s-3"), { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const card = screen.getAllByTestId("thread-tooltip")[0] as HTMLElement;
    expect(card.getAttribute("data-thread-id")).toBe("s-3");
    expect(card.getAttribute("data-side")).toBe("right");
  });

  it("the keyboard walks the icons as the rows: a Needs you icon under the cursor shows its card, Enter opens its popup", async () => {
    show();
    list().focus();
    fireEvent.keyDown(list(), { key: "Home" });
    expect(useUiStore.getState().cursorKey).toBe("s:s-2");
    expect(list().getAttribute("aria-activedescendant")).toBe("row-s:s-2");
    expect((await screen.findByTestId("needs-card")).getAttribute("data-thread-id")).toBe("s-2");
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(useNeedsStore.getState().popup).toBe("s-2");
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(list().getAttribute("aria-activedescendant")).toBe("row-s:s-4");
    fireEvent.keyDown(list(), { key: "End" });
    expect(list().getAttribute("aria-activedescendant")).toBe("row-s:s-1");
  });
});
