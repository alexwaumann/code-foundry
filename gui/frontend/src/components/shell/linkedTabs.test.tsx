import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// The verbs the menus and the row run, and the tab they focus (shell/linkedRun.ts reaches both).
const runs: { name: string; args: Record<string, string>; thread: string }[] = [];
const focused: string[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), notify }));
const focusTabNow = vi.hoisted(() => vi.fn());
vi.mock("@/shell/commands", async (orig) => ({ ...(await orig<typeof import("@/shell/commands")>()), focusTabNow }));

const { PanePlusMenu } = await import("./PanePlusMenu");
const { LinkedRow } = await import("./LinkedRow");
const { LinkedTip } = await import("./PaneTabStrip");
const { ThreadSurfaceItems } = await import("./ThreadSurfaceItems");
const { ThreadHeader } = await import("@/components/thread/ThreadHeader");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useTerminalsStore } = await import("@/stores/terminals");
const { setShellFrame } = await import("@/stores/shellView");
const { setTabCut, useTabCut } = await import("@/shell/tabCut");
const { diffKey, prKey } = await import("@/shell/linked");

const thread = (o: Partial<ThreadView>) =>
  ({
    id: "s-1",
    name: "Refactor sidebar tree",
    projectId: "api",
    worktreePath: "/w/api",
    workspaceId: "",
    projectIds: ["api"],
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
    linkedPullRequests: [],
    status: "idle",
    state: "connected",
    ...o,
  }) as ThreadView;

function setThreads(...ts: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
}

const PROJECT = (id: string) => ({ id, name: id, git: true, githubSlug: "", remotes: [], worktrees: [{ path: `/w/${id}`, branch: "main", head: "a", isMain: true }] });

/** A thread beside a pane of its diff and pull request; the second pane's composer has no thread. */
const LAYOUT = layoutOf([
  space(
    row("s-r", [
      pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" }), tab("t-th2", "thread", "s-2", { key: "thread:s-2" })]),
      pane("p-2", [tab("t-d", "diff", "s-1", { key: diffKey("s-1", "api", "/w/api"), title: "Diff" }), tab("t-pr", "pullrequest", "s-1", { key: prKey("o/api", 12) }), tab("t-term", "terminal", "s-1", { key: "term:t-x", name: "make dev", params: { terminal: "t-x" } }), tab("t-c", "compose", "", { key: "compose" })], "t-d"),
    ]),
    "p-1",
  ),
]);

beforeEach(async () => {
  runs.length = 0;
  focused.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string } } = {}) => {
    runs.push({ name, args, thread: opts.ctx?.activeThreadId ?? "" });
    return Promise.resolve({ message: "", resultJson: "" });
  });
  focusTabNow.mockImplementation((id: string) => {
    focused.push(id);
    return Promise.resolve(true);
  });
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  useTabCut.setState({ cut: {} });
  useTerminalsStore.setState({ byId: {}, order: [], loaded: true });
  useProjectsStore.setState({ byId: { api: PROJECT("api"), web: PROJECT("web") } as never, order: ["api", "web"] });
  setThreads(thread({ linkedPullRequests: [{ slug: "o/api", number: 12, url: "", linkedAt: null }] }), thread({ id: "s-2", name: "Write thread docs", status: "attention" }));
  await seedLayout(LAYOUT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLayout();
});

/** A tick for Radix (a picked item runs as the menu closes) and the async action. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** The menu's items, labels and separators in order ("—" a separator, "# x" a label). */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"], [data-slot="dropdown-menu-label"]')].map((e) =>
    e.getAttribute("role") === "separator" ? "—" : e.getAttribute("data-slot") === "dropdown-menu-label" ? `# ${e.textContent}` : e.textContent,
  );
}

function openPlus(paneId: string): HTMLElement {
  render(<PanePlusMenu paneId={paneId} />);
  fireEvent.pointerDown(screen.getByTestId("pane-plus"), { button: 0, ctrlKey: false });
  return screen.getByTestId("pane-plus-menu");
}

describe("the pane's + menu", () => {
  it("with a thread's tab active: that thread's submenu, then the general items", () => {
    const menu = openPlus("p-1");
    expect(entries(menu)).toEqual(["# This thread", "Refactor sidebar tree", "—", "New thread⌘N", "Terminal", "Pull Requests", "Projects"]);
  });

  it("without a thread tab: only the general items", () => {
    expect(entries(openPlus("p-2"))).toEqual(["New thread⌘N", "Terminal", "Pull Requests", "Projects"]);
  });

  it("opens each general item in its pane", async () => {
    for (const [item, verb] of [
      ["new-thread", "composer.new"],
      ["terminal", "terminal.new-free"],
      ["prs", "view.pullrequests"],
      ["projects", "view.projects"],
    ] as const) {
      const menu = openPlus("p-2");
      fireEvent.click(within(menu).getByText((_, el) => el?.getAttribute("data-item") === item));
      await settle();
      expect(runs.at(-1), item).toEqual({ name: verb, args: { pane: "p-2" }, thread: "" });
      cleanup();
    }
  });

  it("the thread's submenu opens its surfaces in this pane, and focuses an open one where it is", async () => {
    const menu = openPlus("p-1");
    fireEvent.keyDown(within(menu).getByTestId("plus-thread"), { key: "ArrowRight" });
    const sub = await screen.findByTestId("plus-thread-surfaces");
    expect(entries(sub)).toEqual(["Diffopen", "PR #12open", "—", "# Terminals", "make devopen", "New terminal tab"]);
    fireEvent.click(within(sub).getByText("New terminal tab"));
    await settle();
    expect(runs).toEqual([{ name: "terminal.new", args: { pane: "p-1" }, thread: "s-1" }]);
  });

  it("lists the running terminals no tab shows under Terminal; one gets a tab in this pane", async () => {
    const term = (id: string, labels: Record<string, string>, extra: object = {}) => ({ id, argv: ["/bin/zsh"], cwd: "/w/api", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels, liveCwd: "", foreground: "", lastCommand: "", ...extra });
    useTerminalsStore.setState({
      byId: {
        "t-x": term("t-x", { kind: "shell", thread: "s-1" }),
        "t-dev": term("t-dev", { kind: "shell", project: "api", worktree: "/w/api" }, { foreground: "make dev" }),
        "t-home": term("t-home", { kind: "shell" }, { cwd: "/Users/me/notes" }),
      } as never,
      order: ["t-x", "t-dev", "t-home"],
    });
    const menu = openPlus("p-2");
    // t-x has a tab (and a thread): not listed. The others are named as their tab would be.
    expect(entries(menu)).toEqual(["New thread⌘N", "Terminal", "make dev", "zsh · notes", "Pull Requests", "Projects"]);
    fireEvent.click(within(menu).getByText("make dev"));
    await settle();
    expect(runs).toEqual([{ name: "ui.focus.terminal", args: { id: "t-dev", pane: "p-2" }, thread: "" }]);
  });
});

describe("the + menu of a pane of terminals (docs/notes/shell-25f-sizes.md)", () => {
  // A thread beside a pane holding only a terminal: 480 + 12 + 300 = 792 wide; anything else in
  // the terminal's pane raises its minimum to 480, so the row needs 972.
  const TERMS = layoutOf([space(row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" })]), pane("p-t", [tab("t-term", "terminal", "s-1", { key: "term:t-x", params: { terminal: "t-x" } })])]), "p-1")], 2);
  const grid = (w: number) => {
    setShellFrame({ w, h: 800, rects: {}, gutters: [] });
  };
  afterEach(() => {
    setShellFrame(null);
  });

  it("lists only Terminal while nothing else would fit there", async () => {
    await seedLayout(TERMS);
    grid(900);
    expect(entries(openPlus("p-t"))).toEqual(["Terminal"]);
  });

  it("lists everything once the pane could grow to a pane's minimum", async () => {
    await seedLayout(TERMS);
    grid(972);
    expect(entries(openPlus("p-t"))).toEqual(["New thread⌘N", "Terminal", "Pull Requests", "Projects"]);
  });

  it("a pane that is not all terminals lists everything, however narrow the grid", async () => {
    await seedLayout(TERMS);
    grid(500);
    expect(entries(openPlus("p-1"))).toEqual(["# This thread", "Refactor sidebar tree", "—", "New thread⌘N", "Terminal", "Pull Requests", "Projects"]);
  });
});

describe("a thread's surfaces (Open ▸ and the + submenu)", () => {
  function items(threadId: string, paneId = "") {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="m">
          <ThreadSurfaceItems
            threadId={threadId}
            spaceId="sp-a"
            pane={paneId}
            onPick={(a) => {
              void import("@/shell/linkedRun").then(({ runLinked }) => runLinked(a));
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    return screen.getByTestId("m");
  }

  it("lists a diff per checkout and every linked pull request, each marked open only when its tab is", () => {
    setThreads(
      thread({
        projectIds: ["api", "web"],
        checkoutPaths: [{ projectId: "web", path: "/w/web" }],
        linkedPullRequests: [
          { slug: "o/api", number: 12, url: "", linkedAt: null },
          { slug: "o/web", number: 30, url: "", linkedAt: null },
        ],
      }),
    );
    // Newest linked first: the stored order reversed.
    expect(entries(items("s-1"))).toEqual(["Diff · apiopen", "Diff · web", "PR #30", "PR #12open", "—", "# Terminals", "make devopen", "New terminal tab"]);
  });

  it("a thread with no project and no pull request has only its terminals", () => {
    setThreads(thread({ id: "s-3", projectId: "", worktreePath: "/Users/me", projectIds: [] }));
    expect(entries(items("s-3"))).toEqual(["# Terminals", "New terminal tab"]);
  });

  it("opens a closed surface by the rules (no pane) and focuses an open one", async () => {
    setThreads(thread({ projectIds: ["api", "web"], checkoutPaths: [{ projectId: "web", path: "/w/web" }] }));
    const m = items("s-1");
    fireEvent.click(within(m).getByText("Diff · web"));
    await settle();
    fireEvent.click(within(m).getByText("Diff · api"));
    await settle();
    fireEvent.click(within(m).getByText("make dev"));
    await settle();
    expect(runs).toEqual([{ name: "view.open.diff", args: { thread: "s-1", path: "/w/web" }, thread: "" }]);
    expect(focused).toEqual(["t-d", "t-term"]);
  });

  it("opens a pull request in the + menu's pane", async () => {
    setThreads(thread({ linkedPullRequests: [{ slug: "o/api", number: 13, url: "", linkedAt: null }] }));
    fireEvent.click(within(items("s-1", "p-1")).getByText("PR #13"));
    await settle();
    expect(runs).toEqual([{ name: "view.open.pr", args: { number: "13", thread: "s-1", pane: "p-1" }, thread: "" }]);
  });
});

describe("the row under a linked tab's strip", () => {
  const rowOf = () => screen.getByTestId("shell-linked-row");

  it("names the kind and the thread, live while its thread is open here; the link focuses the thread's tab", async () => {
    const t = useLayoutStore.getState().tabs["t-d"];
    if (!t) throw new Error("tab");
    render(<LinkedRow tab={t} />);
    expect(rowOf().textContent).toBe("Diff of Refactor sidebar tree");
    expect(rowOf().hasAttribute("data-live")).toBe(true);
    fireEvent.click(screen.getByTestId("shell-linked-row-link"));
    await settle();
    expect(focused).toEqual(["t-th"]);
  });

  it("is dormant when the thread's tab is not open in the space, and opens it in this pane", async () => {
    await seedLayout(layoutOf([space(pane("p-2", [tab("t-d", "diff", "s-1", { key: "k" })]), "p-2")], 2));
    const t = useLayoutStore.getState().tabs["t-d"];
    if (!t) throw new Error("tab");
    render(<LinkedRow tab={t} />);
    expect(rowOf().hasAttribute("data-live")).toBe(false);
    fireEvent.click(screen.getByTestId("shell-linked-row-link"));
    await settle();
    expect(runs).toEqual([{ name: "thread.open", args: { id: "s-1", pane: "p-2", focus: "true" }, thread: "" }]);
  });

  it("of a linked terminal reads Terminal of the thread, with the directory hint at its right once the shell left", () => {
    const t = useLayoutStore.getState().tabs["t-term"];
    if (!t) throw new Error("tab");
    const term = { id: "t-x", argv: ["/bin/zsh"], cwd: "/w/api", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels: { kind: "shell", thread: "s-1" }, liveCwd: "/w/api", foreground: "", lastCommand: "" };
    useTerminalsStore.setState({ byId: { "t-x": term } as never, order: ["t-x"] });
    render(<LinkedRow tab={t} />);
    expect(screen.getByTestId("shell-linked-row-link").textContent).toBe("Terminal of Refactor sidebar tree");
    expect(screen.queryByTestId("terminal-cwd-hint")).toBeNull();
    act(() => {
      useTerminalsStore.setState({ byId: { "t-x": { ...term, liveCwd: "/tmp" } } as never });
    });
    const end = screen.getByTestId("shell-linked-row-end");
    expect(within(end).getByTestId("terminal-cwd-hint").textContent).toContain("thread is in /w/api");
    expect(within(end).getByTestId("terminal-cwd-reset")).toBeTruthy();
  });

  it("follows a rename, and draws nothing for an unlinked tab", () => {
    const t = useLayoutStore.getState().tabs["t-d"];
    const c = useLayoutStore.getState().tabs["t-c"];
    if (!t || !c) throw new Error("tab");
    const { container } = render(
      <>
        <LinkedRow tab={c} />
      </>,
    );
    expect(container.textContent).toBe("");
    render(<LinkedRow tab={t} />);
    act(() => {
      setThreads(thread({ name: "Virtualize the sidebar" }));
    });
    expect(screen.getByTestId("shell-linked-row-name").textContent).toBe("Virtualize the sidebar");
  });
});

describe("a tab a child thread opened names the lead (docs/notes/linked-names-lead.md)", () => {
  // s-1 (the lead) created c-1, which created g-1; the child's diff and the grandchild's terminal sit beside the lead.
  const KIN = layoutOf([
    space(
      row("s-r", [
        pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" })]),
        pane("p-2", [tab("t-cd", "diff", "c-1", { key: diffKey("c-1", "api", "/w/c"), title: "Diff" }), tab("t-gt", "terminal", "g-1", { key: "term:g", name: "go test", params: { terminal: "g" } })], "t-cd"),
      ]),
      "p-1",
    ),
  ]);
  const child = thread({ id: "c-1", name: "Fix the flaky test", createdBy: "s-1", status: "busy" });
  const grand = thread({ id: "g-1", name: "Run the suite", createdBy: "c-1", status: "error" });
  const tabOf = (id: string) => {
    const t = useLayoutStore.getState().tabs[id];
    if (!t) throw new Error(id);
    return t;
  };
  beforeEach(async () => {
    setThreads(thread({}), child, grand);
    await seedLayout(KIN);
  });

  it.each([
    ["a child's diff", "t-cd", "Diff of Refactor sidebar tree"],
    ["a grandchild's terminal", "t-gt", "Terminal of Refactor sidebar tree"],
  ])("the row of %s: the lead's name, status and tab", async (_name, id, text) => {
    render(<LinkedRow tab={tabOf(id)} />);
    const r = screen.getByTestId("shell-linked-row");
    expect(screen.getByTestId("shell-linked-row-link").textContent).toBe(text);
    expect(r.getAttribute("data-thread-id")).toBe("s-1");
    expect(r.hasAttribute("data-live")).toBe(true);
    expect(within(r).getByTestId("thread-dot").getAttribute("data-badge")).toBe("idle");
    fireEvent.click(screen.getByTestId("shell-linked-row-link"));
    await settle();
    expect(focused).toEqual(["t-th"]);
  });

  it("an archived lead is still the lead", () => {
    setThreads(thread({ archivedAtMs: 1 }), child, grand);
    render(<LinkedRow tab={tabOf("t-cd")} />);
    expect(screen.getByTestId("shell-linked-row-name").textContent).toBe("Refactor sidebar tree");
  });

  it("once the lead is removed, the child (the highest thread left) is named, and its tab opened", async () => {
    setThreads(child, grand);
    render(<LinkedRow tab={tabOf("t-gt")} />);
    const r = screen.getByTestId("shell-linked-row");
    expect(screen.getByTestId("shell-linked-row-name").textContent).toBe("Fix the flaky test");
    expect(r.hasAttribute("data-live")).toBe(false);
    expect(within(r).getByTestId("thread-dot").getAttribute("data-badge")).toBe("busy");
    fireEvent.click(screen.getByTestId("shell-linked-row-link"));
    await settle();
    expect(runs).toEqual([{ name: "thread.open", args: { id: "c-1", pane: "p-2", focus: "true" }, thread: "" }]);
  });

  it("the tab's hover names the lead", () => {
    render(<LinkedTip tab={tabOf("t-cd")} tabName="Diff" cut />);
    expect(screen.getByText("Diff of Refactor sidebar tree")).toBeTruthy();
  });

  it("the lead's Open ▸ items list the tabs its children opened, which focus where they are", async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="m">
          <ThreadSurfaceItems
            threadId="s-1"
            spaceId="sp-a"
            onPick={(a) => {
              void import("@/shell/linkedRun").then(({ runLinked }) => runLinked(a));
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const m = screen.getByTestId("m");
    expect(entries(m)).toEqual(["Diff", "Diffopen", "—", "# Terminals", "go testopen", "New terminal tab"]);
    fireEvent.click(within(m).getAllByText("Diff")[1] as HTMLElement);
    await settle();
    expect(focused).toEqual(["t-cd"]);
  });
});

describe("the thread's header in a shell pane", () => {
  it("shows the branch, not the name, while the tab shows the name; the name when the tab is cut", () => {
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    expect(screen.getByTestId("thread-header-branch").textContent).toBe("main");
    expect(screen.queryByTestId("thread-header-name")).toBeNull();
    act(() => {
      setTabCut("p-1", true);
    });
    expect(screen.getByTestId("thread-header-name").textContent).toBe("Refactor sidebar tree");
  });

  it("has one menu: Open ▸, Move to space ▸, the thread's items with Close after Archive, Fork, Remove", async () => {
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
    const menu = screen.getByTestId("thread-header-menu");
    const got = entries(menu);
    expect(got.slice(0, 3)).toEqual(["Open", "Move to space", "—"]);
    expect(got).toEqual(expect.arrayContaining(["Rename", "Snooze", "Archive"]));
    expect(got.slice(-4)).toEqual(["Close⌘W", "—", "Fork", "Remove"]);
    fireEvent.keyDown(within(menu).getByTestId("menu-move-to-space"), { key: "ArrowRight" });
    const spaces = await screen.findByTestId("menu-move-to-space-spaces");
    // One space: shown anyway, marked here and disabled; then New space.
    expect(entries(spaces)).toEqual(["Mainhere", "—", "New space"]);
    expect(within(spaces).getByTestId("move-to-space-item").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getByTestId("menu-close"));
    await settle();
    expect(runs).toEqual([{ name: "thread.close", args: { id: "s-1" }, thread: "" }]);
  });

  it("for a preview tab the menu starts with Keep open, which keeps it (tab.keep); a kept tab's menu has no such item", async () => {
    const previewed = structuredClone(LAYOUT);
    const root = previewed.spaces[0]?.root;
    const first = root?.t === "split" ? root.kids[0] : undefined;
    if (first?.t !== "pane") throw new Error("fixture");
    first.tabs = first.tabs.map((t) => (t.id === "t-th" ? { ...t, preview: true } : t));
    await seedLayout({ ...previewed, rev: 2 });
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
    const menu = screen.getByTestId("thread-header-menu");
    expect(entries(menu).slice(0, 4)).toEqual(["Keep open", "—", "Open", "Move to space"]);
    fireEvent.click(within(menu).getByTestId("menu-keep-open"));
    await settle();
    expect(runs).toEqual([{ name: "tab.keep", args: { tab: "t-th" }, thread: "" }]);
    cleanup();
    // The other thread of the pane is kept: its header has no Keep open.
    render(<ThreadHeader threadId="s-2" paneId="p-1" />);
    fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
    expect(within(screen.getByTestId("thread-header-menu")).queryByTestId("menu-keep-open")).toBeNull();
  });

  it("Move to space ▸ lists the real spaces with their glyphs and moves the thread with thread.space.move", async () => {
    await seedLayout({ ...LAYOUT, rev: 2, spaces: [...LAYOUT.spaces, space(pane("p-9", [tab("t-9", "prs")]), "p-9", { id: "sp-b", name: "Review" })] });
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
    const menu = screen.getByTestId("thread-header-menu");
    fireEvent.keyDown(within(menu).getByTestId("menu-move-to-space"), { key: "ArrowRight" });
    const spaces = await screen.findByTestId("menu-move-to-space-spaces");
    expect(entries(spaces)).toEqual(["Mainhere", "Review", "—", "New space"]);
    // Each space's glyph is drawn from its own panes: two in Main, one in Review.
    expect(within(spaces).getAllByTestId("space-icon").map((g) => g.getAttribute("data-panes"))).toEqual(["2", "1"]);
    const review = within(spaces).getAllByTestId("move-to-space-item")[1];
    if (!review) throw new Error("no Review item");
    fireEvent.click(review);
    await settle();
    expect(runs).toEqual([{ name: "thread.space.move", args: { id: "s-1", space: "sp-b" }, thread: "s-1" }]);
    // The thread's tab leaves this space and nothing here shows where it went: a toast that goes there.
    expect(notify).toHaveBeenCalledTimes(1);
    const n = notify.mock.calls[0]?.[0] as { level: string; title: string; action: { label: string; onClick: () => void } };
    expect(n).toMatchObject({ level: "success", title: "Moved to Review", action: { label: "Go to space" } });
    n.action.onClick();
    await settle();
    expect(runs.at(-1)).toEqual({ name: "space.switch", args: { space: "sp-b", focus: "true" }, thread: "" });
  });

  it("Move to space ▸ that fails toasts no move", async () => {
    await seedLayout({ ...LAYOUT, rev: 2, spaces: [...LAYOUT.spaces, space(pane("p-9", [tab("t-9", "prs")]), "p-9", { id: "sp-b", name: "Review" })] });
    runCommandForResult.mockImplementation(() => Promise.resolve(null));
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
    fireEvent.keyDown(within(screen.getByTestId("thread-header-menu")).getByTestId("menu-move-to-space"), { key: "ArrowRight" });
    fireEvent.click(within(await screen.findByTestId("menu-move-to-space-spaces")).getByText("Review"));
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });
});
