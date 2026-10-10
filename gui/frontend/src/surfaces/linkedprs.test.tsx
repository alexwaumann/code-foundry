import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { LinkedPullRequestView, SessionView } from "@/api/session";

// Details resolve per test (pending until then: the rows show their skeleton).
const pending = new Map<string, (d: PullRequestDetailView) => void>();
const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { pullRequestDetailResource } = await import("@/stores/gh");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { linkedPrsPanelCommand, showView, useViewsStore } = await import("@/stores/views");

const link = (slug: string, number: number): LinkedPullRequestView => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt: Date.now() - number * 60_000 });
const thread = (id: string, links: LinkedPullRequestView[]) => ({ id, name: `thread ${id}`, repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", terminalId: "", state: "connected", linkedPullRequests: links }) as SessionView;
const pr = (slug: string, number: number, o: Partial<PullRequestView>): PullRequestDetailView =>
  ({
    pullRequest: { repoSlug: slug, number, title: `title ${String(number)}`, state: "open", draft: false, headRef: `branch-${String(number)}`, checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0, skipped: 0 }, ...o },
    lastError: "",
  }) as PullRequestDetailView;

async function resolve(slug: string, number: number, o: Partial<PullRequestView> = {}): Promise<void> {
  await act(async () => {
    pending.get(`${slug}#${String(number)}`)?.(pr(slug, number, o));
    await Promise.resolve();
  });
}

function select(id: string): void {
  useUiStore.setState({ selection: { kind: "session", id } });
}

beforeEach(() => {
  // jsdom has no layout: NavRow scrolls the cursor row into view.
  Element.prototype.scrollIntoView = vi.fn();
  getPullRequestDetail.mockImplementation((slug: string, number: number) => new Promise((r) => pending.set(`${slug}#${String(number)}`, r)));
  pullRequestDetailResource.store.setState({ entries: {} });
  useReposStore.setState({ byId: {}, order: [] });
  // First-seen order 5, 7, 6: the list shows 6, 7, 5.
  useSessionsStore.setState({ byId: { "s-1": thread("s-1", [link("o/web", 5), link("o/web", 7), link("o/web", 6)]), "s-0": thread("s-0", []) }, order: ["s-1", "s-0"] });
  usePanelStore.setState({ byKey: { "session:s-1": { open: true, tabs: [], activeTabId: null }, "session:s-0": { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, palette: { ...useUiStore.getState().palette, open: false } });
  select("s-1");
});

afterEach(() => {
  cleanup();
  pending.clear();
  vi.clearAllMocks();
});

const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="linkedprs"]') ?? null;
const numbers = () => screen.getAllByTestId("linkedpr-number").map((n) => n.textContent);

describe("Linked PRs surface", () => {
  it("is listed with L for a thread with links, hidden without, and follows new links", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    expect(row()?.textContent).toContain("Linked PRs");
    expect(row()?.textContent).toContain("L");
    act(() => {
      select("s-0");
    });
    expect(row()).toBeNull();
    act(() => {
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, "s-0": thread("s-0", [link("o/web", 9)]) } }));
    });
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
  });

  it("L opens the tab: header, rows newest first, skeletons until the details load", async () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "l" });
    expect(getPanel("session:s-1").activeTabId).toBe("linkedprs");
    expect(screen.getByTestId("linkedprs-thread").textContent).toBe("thread s-1");
    expect(screen.getByTestId("linkedprs-count").textContent).toBe("3 linked PRs");
    expect(numbers()).toEqual(["#6", "#7", "#5"]);
    expect(screen.getAllByTestId("linkedpr-loading")).toHaveLength(3);
    expect(screen.getAllByTestId("linkedpr-loading")[0]?.textContent).toContain("github.com");
    // One repository: no repository names.
    expect(screen.queryAllByTestId("linkedpr-repo")).toHaveLength(0);

    await resolve("o/web", 6, { state: "merged" });
    await resolve("o/web", 7, { draft: true, checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0, skipped: 0 } });
    expect(screen.getAllByTestId("linkedpr-title").map((t) => t.textContent)).toEqual(["title 6", "title 7"]);
    expect(screen.getAllByTestId("linkedpr-state").map((t) => t.getAttribute("data-state"))).toEqual(["merged", "draft"]);
    expect(screen.getAllByTestId("linkedpr-branch").map((t) => t.textContent)).toEqual(["branch-6", "branch-7"]);
    // Checks only on the open one.
    const rows = screen.getAllByTestId("linkedpr");
    expect(rows[0]?.querySelector("[data-checks]")).toBeNull();
    expect(rows[1]?.querySelector("[data-checks]")?.getAttribute("data-checks")).toBe("failure");
    expect(screen.getAllByTestId("linkedpr-loading")).toHaveLength(1);
  });

  it("names the repository when the links span repositories", () => {
    act(() => {
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", [link("o/web", 5), link("o/api", 2)]) } }));
    });
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "l" });
    expect(screen.getAllByTestId("linkedpr-repo").map((r) => r.textContent)).toEqual(["o/api", "o/web"]);
  });

  it("Enter on a row opens the pull request as a tab of the same panel; a click too", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "l" });
    const list = screen.getByTestId("linkedprs-list");
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "Enter" });
    let p = getPanel("session:s-1");
    expect(p.tabs.map((t) => t.title)).toEqual(["Linked PRs", "#7"]);
    expect(p.activeTabId).toBe("pullrequest?number=7&slug=o%2Fweb");

    act(() => {
      usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "session:s-1": { ...p, activeTabId: "linkedprs" } } }));
    });
    const first = screen.getAllByTestId("linkedpr")[0]?.closest('[role="option"]');
    if (!first) throw new Error("no row");
    fireEvent.click(first);
    p = getPanel("session:s-1");
    expect(p.tabs.map((t) => t.title)).toEqual(["Linked PRs", "#7", "#6"]);
  });
});

describe("linkedPrsPanelCommand (view.panel.linked-prs)", () => {
  it("opens the tab and shows a hidden panel for a thread with links", () => {
    usePanelStore.setState({ byKey: {} });
    expect(linkedPrsPanelCommand()).toBe(true);
    expect(getPanel("session:s-1")).toMatchObject({ open: true, activeTabId: "linkedprs" });
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts for a thread without links, and does nothing without a thread or under settings", () => {
    usePanelStore.setState({ byKey: {} });
    select("s-0");
    expect(showView("panel.linked-prs")).toBe(true);
    expect(getPanel("session:s-0").open).toBe(false);
    expect(toast).toHaveBeenCalledWith("No linked PRs yet", expect.anything());
    toast.mockClear();

    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    expect(linkedPrsPanelCommand()).toBe(false);
    expect(toast).not.toHaveBeenCalled();

    select("s-1");
    useViewsStore.setState({ settingsOpen: true });
    expect(linkedPrsPanelCommand()).toBe(false);
    expect(getPanel("session:s-1").open).toBe(false);
  });

  it("from the palette, sends the palette's focus back to the panel", () => {
    useUiStore.setState((s) => ({ palette: { ...s.palette, open: true, returnTo: "terminal" } }));
    expect(linkedPrsPanelCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });
});
