import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useSettingsStore } = await import("@/stores/settings");
const { tooltipText } = await import("@/test/tooltip");
const { showView, threadsPanelCommand, useViewsStore } = await import("@/stores/views");
const { threadsTab } = await import("@/surfaces/threadsTarget");

const NOW = Date.now();
let created = 0;

/** A thread created one minute after the previous one (spawn order = list order). */
function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  created++;
  return {
    id,
    name: `name ${id}`,
    projectId: "web",
    worktreePath: "/src/web",
    workspaceId: "",
    pendingWorktreePath: "",
    state: "disconnected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    createdAtMs: NOW - (100 - created) * 60_000,
    archivedAtMs: null,
    snoozedUntilMs: null,
    createdBy: "",
    createdByName: "",
    brief: "",
    linkedPullRequests: [],
    usage: [],
    agentRuns: [],
    ...o,
  } as ThreadView;
}

const by = (creator: string, o: Partial<ThreadView> = {}) => ({ createdBy: creator, createdByName: `name ${creator}`, ...o });

function setThreads(list: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(list.map((x) => [x.id, x])), order: list.map((x) => x.id) });
}

/** The sketch: p (working) created me and three siblings; me created one child. */
function sketch(): ThreadView[] {
  return [
    thread("p", { name: "Fix login redirect", state: "connected", status: "busy" }),
    thread("me", by("p", { name: "Add retry", status: "attention", statusReason: "finished", brief: "Add retry, keep the PR small", projectId: "auth", worktreePath: "/src/auth" })),
    thread("s1", by("p", { state: "connected", status: "busy", brief: "Cover the retry path" })),
    thread("s2", by("p", { status: "attention", statusReason: "permission: Bash" })),
    thread("s3", by("p", { status: "error", statusReason: "interrupted", archivedAtMs: NOW })),
    thread("c1", by("me", { brief: "Write table tests" })),
    thread("u", { name: "Unrelated" }),
  ];
}

const rows = () => screen.getAllByTestId("lineage-row");
const ids = (section: string) => [...(screen.getByTestId(`threads-section-${section}`).querySelectorAll('[data-testid="lineage-row"]'))].map((r) => r.getAttribute("data-thread"));
const rowOf = (id: string) => rows().find((r) => r.getAttribute("data-thread") === id) as HTMLElement;
const within = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);
const entry = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="threads"]') ?? null;

function select(id: string): void {
  act(() => {
    useUiStore.setState({ selection: { kind: "thread", id } });
  });
  usePanelStore.setState((s) => ({ byKey: { ...s.byKey, [`thread:${id}`]: s.byKey[`thread:${id}`] ?? { open: true, groups: [{ tabs: [], activeTabId: null }] } } }));
}

function open(): void {
  act(() => {
    showView("panel.threads");
  });
  render(<SidePanel />);
}

beforeEach(() => {
  created = 0;
  toast.mockClear();
  useProjectsStore.setState({
    byId: {
      web: { id: "web", name: "web-app", git: true, githubSlug: "", worktrees: [{ path: "/src/web", branch: "cf/fix-login", head: "a", isMain: false }] },
      auth: { id: "auth", name: "auth-service", git: true, githubSlug: "", worktrees: [{ path: "/src/auth", branch: "cf/login-retry", head: "b", isMain: false }] },
    } as never,
    order: ["web", "auth"],
  });
  setThreads(sketch());
  usePanelStore.setState({ byKey: { "thread:me": { open: true, groups: [{ tabs: [], activeTabId: null }] }, "view:projects": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, selection: { kind: "thread", id: "me" }, palette: { ...useUiStore.getState().palette, open: false } });
});

afterEach(cleanup);

describe("Threads surface", () => {
  it("is listed with H for a thread and hidden for a page", () => {
    render(<SidePanel />);
    expect(entry()?.getAttribute("data-availability")).toBe("enabled");
    expect(entry()?.textContent).toContain("Threads");
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "h" });
    expect(getPanel("thread:me").groups[0]?.activeTabId).toBe("threads");
    cleanup();
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    render(<SidePanel />);
    expect(entry()).toBeNull();
    expect(threadsPanelCommand()).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("is hidden for a thread with nothing related; listed live once a child appears; H does nothing meanwhile", () => {
    select("u");
    render(<SidePanel />);
    expect(entry()).toBeNull();
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "h" });
    expect(getPanel("thread:u").groups[0]?.activeTabId).toBeNull();
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, u1: thread("u1", by("u")) }, order: [...s.order, "u1"] }));
    });
    expect(entry()?.getAttribute("data-availability")).toBe("enabled");
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "h" });
    expect(getPanel("thread:u").groups[0]?.activeTabId).toBe("threads");
  });

  it.each([
    ["a creator (the header chip's case)", "me", true],
    ["children only", "p", true],
    ["an only child: a creator, no siblings", "c1", true],
    ["nothing related", "u", false],
  ])("view.panel.threads: %s", (_n, id, opens) => {
    select(id);
    usePanelStore.setState({ byKey: {} });
    expect(threadsPanelCommand()).toBe(opens);
    expect(getPanel(`thread:${id}`).open).toBe(opens);
    expect(getPanel(`thread:${id}`).groups[0]?.activeTabId).toBe(opens ? "threads" : null);
    if (opens) expect(toast).not.toHaveBeenCalled();
    else expect(toast).toHaveBeenCalledWith("No related threads", expect.anything());
  });

  it("an agent's thread: header, sections in spawn order, statuses, place, age and brief", () => {
    open();
    expect(screen.getByTestId("threads-count").textContent).toBe("5 related");
    // The creator's current name, not the one it had when it created the thread (createdByName).
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by Fix login redirect · 3 siblings · 1 child");
    expect(ids("creator")).toEqual(["p"]);
    expect(ids("this")).toEqual(["me"]);
    expect(ids("siblings")).toEqual(["s1", "s2", "s3"]);
    expect(ids("children")).toEqual(["c1"]);
    expect(screen.getByTestId("threads-section-siblings-count").textContent).toBe("3");
    expect(screen.getByTestId("threads-section-children-count").textContent).toBe("1");
    expect(rows().map((r) => [r.getAttribute("data-thread"), within(r, "lineage-status")?.textContent])).toEqual([
      ["p", "Working"],
      ["me", "Finished"],
      ["s1", "Working"],
      ["s2", "Needs input"],
      ["s3", "Archived"],
      ["c1", "Idle"],
    ]);
    expect(within(rowOf("p"), "lineage-status")?.className).toContain("text-cf-info-text");
    expect(within(rowOf("s2"), "lineage-status")?.className).toContain("text-cf-warning-text");
    expect(within(rowOf("me"), "lineage-status")?.className).toContain("text-cf-success-text");
    expect(within(rowOf("me"), "lineage-place")?.textContent).toBe("auth-service @ cf/login-retry");
    expect(within(rowOf("me"), "lineage-age")?.textContent).toBe("1h");
    expect(within(rowOf("me"), "lineage-brief")?.textContent).toBe("Add retry, keep the PR small");
    expect(within(rowOf("p"), "lineage-brief")).toBeNull();
    // Running threads spin; the archived one is muted.
    expect(rowOf("p").querySelector(".animate-spin")).not.toBeNull();
    expect(within(rowOf("s3"), "lineage-meta")?.className).toContain("opacity-60");
    // The current thread is highlighted, says so and is not a button.
    expect(rowOf("me").getAttribute("data-me")).toBe("true");
    expect(rowOf("me").tagName).toBe("LI");
    expect(rowOf("me").textContent).toContain("this thread");
    expect(rowOf("s1").tagName).toBe("BUTTON");
  });

  it("a row opens its thread like a sidebar click", () => {
    open();
    fireEvent.click(rowOf("s2"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s2" });
  });

  it("caps siblings at five; +N more shows the rest", () => {
    setThreads([...sketch(), thread("s4", by("p")), thread("s5", by("p")), thread("s6", by("p")), thread("s7", by("p"))]);
    open();
    expect(screen.getByTestId("threads-section-siblings-count").textContent).toBe("7");
    expect(ids("siblings")).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(screen.getByTestId("lineage-more").textContent).toBe("+2 more");
    fireEvent.click(screen.getByTestId("lineage-more"));
    expect(ids("siblings")).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(screen.queryByTestId("lineage-more")).toBeNull();
  });

  it("a thread the user made: Created by you and its children across projects; no creator or siblings", () => {
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "p" } });
    });
    usePanelStore.setState({ byKey: { "thread:p": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
    open();
    expect(screen.getByTestId("threads-count").textContent).toBe("4 related");
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by you · 4 threads created from here, in 2 projects");
    expect(screen.queryByTestId("threads-section-creator")).toBeNull();
    expect(screen.queryByTestId("threads-section-siblings")).toBeNull();
    expect(ids("children")).toEqual(["me", "s1", "s2", "s3"]);
  });

  it("nothing related (a tab opened before, e.g. restored with the panel): Created by you, no threads created from here", () => {
    select("u");
    usePanelStore.setState({ byKey: { "thread:u": { open: true, groups: [{ tabs: [threadsTab()], activeTabId: "threads" }] } } });
    render(<SidePanel />);
    expect(screen.queryByTestId("threads-count")).toBeNull();
    expect(screen.queryByTestId("threads-subline")).toBeNull();
    expect(screen.getByTestId("threads-empty").textContent).toBe(
      "Created by you. No threads created from here.When an agent in this thread runs code-foundry thread new, the threads it starts show here, with their status.",
    );
    expect(screen.queryAllByTestId("lineage-row")).toHaveLength(0);
  });

  it("a removed creator: its recorded name, Removed, inert", () => {
    setThreads(sketch().filter((x) => x.id !== "p"));
    open();
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by a removed thread · 3 siblings · 1 child");
    const r = screen.getByTestId("threads-section-creator").querySelector('[data-testid="lineage-row"]') as HTMLElement;
    expect(r.getAttribute("data-removed")).toBe("true");
    expect(r.textContent).toBe("name pRemoved");
    expect(r.querySelector("button")).toBeNull();
  });

  it("follows the list: a new child appears, a status change moves only that row's word", () => {
    open();
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, c2: thread("c2", by("me")) }, order: [...s.order, "c2"] }));
    });
    expect(ids("children")).toEqual(["c1", "c2"]);
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, c1: { ...s.byId.c1, state: "connected", status: "busy" } as ThreadView } }));
    });
    expect(within(rowOf("c1"), "lineage-status")?.textContent).toBe("Working");
  });

  it("a rename of the creator: the subline follows", () => {
    open();
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, p: { ...s.byId.p, name: "Login redirect" } as ThreadView } }));
    });
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by Login redirect · 3 siblings · 1 child");
  });
});

describe("Threads surface: hidden child threads (docs/notes/hidden-children-2-gui.md)", () => {
  const setShowCreated = (on: boolean) => {
    act(() => {
      useSettingsStore.setState({ snapshot: { values: { "threads.show_created_threads": String(on) }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    });
  };
  const action = (id: string) => within(rowOf(id).parentElement as HTMLElement, "lineage-sidebar") as HTMLElement | null;
  afterEach(() => {
    useSettingsStore.setState({ snapshot: null });
  });

  it("a muted hidden before the status of every hidden thread; none on shown ones or the user's", () => {
    setThreads(sketch().map((x) => (x.id === "s1" ? { ...x, inSidebar: true } : x.id === "p" || x.id === "u" ? x : { ...x, inSidebar: null })));
    open();
    const hidden = rows().filter((r) => within(r, "lineage-hidden") !== null).map((r) => r.getAttribute("data-thread"));
    expect(hidden).toEqual(["me", "s2", "s3", "c1"]);
    expect(within(rowOf("s2"), "lineage-hidden")?.textContent).toBe("hidden");
    expect(within(rowOf("s2"), "lineage-hidden")?.nextElementSibling?.getAttribute("data-testid")).toBe("lineage-status");
    // The setting on: all shown, no mark.
    setShowCreated(true);
    expect(screen.queryAllByTestId("lineage-hidden")).toHaveLength(0);
  });

  it("siblings and children get Show in sidebar / Hide from sidebar beside the row (not in it); this thread and the creator do not", () => {
    setThreads(sketch().map((x) => (x.id === "s1" ? { ...x, inSidebar: true } : x)));
    open();
    expect(action("s1")?.getAttribute("aria-label")).toBe("Hide from sidebar");
    expect(action("s1")?.dataset.shown).toBe("true");
    expect(tooltipText(action("s1") as HTMLElement)).toBe("Hide from sidebar");
    expect(action("s2")?.getAttribute("aria-label")).toBe("Show in sidebar");
    expect(action("c1")?.getAttribute("aria-label")).toBe("Show in sidebar");
    expect(rowOf("s2").querySelector('[data-testid="lineage-sidebar"]')).toBeNull();
    expect(within(rowOf("me").parentElement as HTMLElement, "lineage-sidebar")).toBeNull();
    expect(within(rowOf("p").parentElement as HTMLElement, "lineage-sidebar")).toBeNull();
  });

  it.each<[string, string, string]>([
    ["shows a hidden sibling", "s2", "true"],
    ["hides a shown sibling", "s1", "false"],
  ])("the action %s through thread.sidebar, without opening it", (_name, id, shown) => {
    setThreads(sketch().map((x) => (x.id === "s1" ? { ...x, inSidebar: true } : x)));
    open();
    fireEvent.click(action(id) as HTMLElement);
    expect(runCommand).toHaveBeenCalledWith("thread.sidebar", { shown }, expect.objectContaining({ activeThreadId: id }));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "me" });
  });

  it("follows an override change live", () => {
    open();
    expect(action("s2")?.getAttribute("aria-label")).toBe("Show in sidebar");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, s2: { ...s.byId.s2, inSidebar: true } as ThreadView } }));
    });
    expect(action("s2")?.getAttribute("aria-label")).toBe("Hide from sidebar");
    expect(within(rowOf("s2"), "lineage-hidden")).toBeNull();
  });
});
