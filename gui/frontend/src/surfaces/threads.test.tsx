import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { showView, threadsPanelCommand, useViewsStore } = await import("@/stores/views");

const NOW = Date.now();
let created = 0;

/** A thread created one minute after the previous one (spawn order = list order). */
function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  created++;
  return {
    id,
    name: `name ${id}`,
    repoId: "web",
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
    thread("me", by("p", { name: "Add retry", status: "attention", statusReason: "finished", brief: "Add retry, keep the PR small", repoId: "auth", worktreePath: "/src/auth" })),
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

function open(): void {
  act(() => {
    showView("panel.threads");
  });
  render(<SidePanel />);
}

beforeEach(() => {
  created = 0;
  useReposStore.setState({
    byId: {
      web: { id: "web", name: "web-app", git: true, githubSlug: "", worktrees: [{ path: "/src/web", branch: "cf/fix-login", head: "a", isMain: false }] },
      auth: { id: "auth", name: "auth-service", git: true, githubSlug: "", worktrees: [{ path: "/src/auth", branch: "cf/login-retry", head: "b", isMain: false }] },
    } as never,
    order: ["web", "auth"],
  });
  setThreads(sketch());
  usePanelStore.setState({ byKey: { "thread:me": { open: true, tabs: [], activeTabId: null }, "view:projects": { open: true, tabs: [], activeTabId: null } } });
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
    expect(getPanel("thread:me").activeTabId).toBe("threads");
    cleanup();
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    render(<SidePanel />);
    expect(entry()).toBeNull();
    expect(threadsPanelCommand()).toBe(false);
  });

  it("an agent's thread: header, sections in spawn order, statuses, place, age and brief", () => {
    open();
    expect(screen.getByTestId("threads-count").textContent).toBe("5 related");
    // The name the creator had when it created the thread (createdByName), not its current one.
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by name p · 3 siblings · 1 child");
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
    expect(within(rowOf("p"), "lineage-status")?.className).toContain("text-info");
    expect(within(rowOf("s2"), "lineage-status")?.className).toContain("text-warning");
    expect(within(rowOf("me"), "lineage-status")?.className).toContain("text-success");
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
    usePanelStore.setState({ byKey: { "thread:p": { open: true, tabs: [], activeTabId: null } } });
    open();
    expect(screen.getByTestId("threads-count").textContent).toBe("4 related");
    expect(screen.getByTestId("threads-subline").textContent).toBe("Created by you · 4 threads created from here, in 2 projects");
    expect(screen.queryByTestId("threads-section-creator")).toBeNull();
    expect(screen.queryByTestId("threads-section-siblings")).toBeNull();
    expect(ids("children")).toEqual(["me", "s1", "s2", "s3"]);
  });

  it("nothing related: Created by you, no threads created from here", () => {
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "u" } });
    });
    usePanelStore.setState({ byKey: { "thread:u": { open: true, tabs: [], activeTabId: null } } });
    open();
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
});
