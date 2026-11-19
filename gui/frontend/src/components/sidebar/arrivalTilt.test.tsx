import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

// jsdom lays nothing out: this stand-in draws every row at its estimate.
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
vi.mock("@/components/sidebar/useLinkedPrs", async (orig) => ({ ...(await orig<typeof import("@/components/sidebar/useLinkedPrs")>()), useSidebarDashboard: () => undefined }));
vi.mock("@/api/threadSearch", async (orig) => ({ ...(await orig<typeof import("@/api/threadSearch")>()), readAskItems: () => new Promise(() => undefined) }));

const { Sidebar } = await import("./Sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useShellSidebarStore } = await import("@/stores/shellSidebar");
const { HOME, useUiStore } = await import("@/stores/ui");
const { resetNeeds } = await import("@/stores/needs");
const { useThreadStore } = await import("@/stores/thread");
const { resetArrivals, useArrivalsStore } = await import("@/stores/arrivals");

/**
 * The arrival tilt on the sidebar (docs/notes/arrival-tilt.md): which element tilts on the rail
 * and on the expanded rows. When a thread arrives is stores/arrivals.test.tsx's.
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

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  resetArrivals();
  resetNeeds();
  useShellSidebarStore.setState({ needsCollapsed: false, activeCollapsed: false });
  useUiStore.setState({ selection: HOME, cursorKey: null, sidebarExpanded: false });
  useProjectsStore.setState({ byId: { api: PROJECT } as never, order: ["api"] });
  const ts = [
    thread({ id: "s-1" }),
    thread({ id: "s-2", name: "Asks", status: "attention", statusReason: "permission: Bash", statusChangedAtMs: Date.now() }),
    thread({ id: "s-6", name: "Woke", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() }),
  ];
  useThreadsStore.setState({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true });
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1", { key: "thread:s-1" })], "t-1"), "p-1")]));
  useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
});

afterEach(() => {
  cleanup();
  resetLayout();
});

function show(expanded: boolean) {
  useUiStore.setState({ sidebarExpanded: expanded });
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>,
  );
}

function arrive(...ids: string[]) {
  act(() => {
    useArrivalsStore.setState({ threads: Object.fromEntries(ids.map((id) => [id, Date.now()])) });
  });
}

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-row-key="s:${id}"]`) as HTMLElement;
const tilted = () => [...document.querySelectorAll(".animate-arrival-tilt")];

describe("the rail", () => {
  it("nothing tilts without an arrival", () => {
    show(false);
    expect(tilted()).toEqual([]);
  });

  it("an arrival tilts only the thread's icon: a Needs you ask about its centre, a woken snooze's bell from its top", () => {
    show(false);
    arrive("s-2", "s-6");
    const ask = within(rowOf("s-2")).getByTestId("rail-row-icon");
    const woke = within(rowOf("s-6")).getByTestId("rail-row-icon");
    expect(tilted()).toEqual([ask, woke]);
    expect(ask.getAttribute("class")).not.toContain("origin-");
    expect(woke.getAttribute("class")).toContain("origin-[50%_12%]");
  });
});

describe("the expanded sidebar", () => {
  it("a Needs you row tilts its ask's icon, not its word or the row", () => {
    show(true);
    arrive("s-2");
    const ask = within(rowOf("s-2")).getByTestId("row-ask");
    expect(ask.textContent).toBe("Permission");
    expect(tilted()).toEqual([within(ask).getByTestId("row-ask-icon")]);
  });

  it("a woken row tilts its bell from its top, not its word", () => {
    show(true);
    arrive("s-6");
    const status = within(rowOf("s-6")).getByTestId("row-status");
    const icon = within(status).getByTestId("row-status-icon");
    expect(tilted()).toEqual([icon]);
    expect(icon.getAttribute("class")).toContain("origin-[50%_12%]");
    expect(within(status).getByTestId("row-status-word").className).not.toContain("animate-");
  });
});
