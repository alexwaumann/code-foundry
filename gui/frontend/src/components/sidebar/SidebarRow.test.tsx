import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardView, PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { ThreadView } from "@/api/threads";

const renameThread = vi.hoisted(() => vi.fn<(id: string, name: string) => Promise<boolean>>(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), renameThread }));
import { TooltipProvider } from "@/components/ui/tooltip";
import { DASHBOARD_KEY, dashboardResource, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { SidebarRow } from "./SidebarRow";

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s-1", name: "t", projectId: "cf", worktreePath: "/src/cf", workspaceId: "", projectIds: ["cf"], branch: "", createdWorktree: false, pendingWorktreePath: "", state: "connected", status: "idle", statusReason: "", statusChangedAtMs: null, linkedPullRequests: [], pinned: false, ...o }) as ThreadView;

beforeEach(() => {
  useProjectsStore.setState({
    byId: {
      cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] },
      notes: { id: "notes", name: "writing", git: false, githubSlug: "", remotes: [], worktrees: [{ path: "/src/notes", branch: "", head: "", isMain: true }] },
    } as never,
    order: ["cf", "notes"],
  });
});

afterEach(cleanup);

function renderRow(o: Partial<ThreadView>): HTMLElement {
  useThreadsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
  render(
    <TooltipProvider>
      <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
    </TooltipProvider>,
  );
  return screen.getByTestId("row-place");
}

describe("SidebarRow line 2", () => {
  it.each([
    ["idle: project @ branch", {}, "code-foundry @ main"],
    ["working: the status, then the place", { status: "busy" as const }, "Working · code-foundry @ main"],
    ["starting reads as working", { state: "starting" as const }, "Working · code-foundry @ main"],
    ["stopped at its prompt: the place, like idle", { state: "disconnected" as const }, "code-foundry @ main"],
    ["no git: the project and the No git badge, no @", { projectId: "notes", worktreePath: "/src/notes" }, "writing No git"],
    ["a question: no place", { status: "attention" as const, statusReason: "question: Which one?" }, "Asked a question"],
    ["no project: No project alone, no branch", { projectId: "", worktreePath: "/Users/dev" }, "No project"],
    ["no project, working", { projectId: "", worktreePath: "/Users/dev", status: "busy" as const }, "Working · No project"],
  ])("%s", (_name, o, text) => {
    expect(renderRow(o).textContent).toBe(text);
  });

  it("a stopped thread looks like any other: not dimmed, no offline mark", () => {
    renderRow({ state: "disconnected" });
    const body = screen.getByTestId("thread-body");
    expect(body.className).not.toContain("opacity-50");
    expect(body.getAttribute("data-offline")).toBeNull();
    expect(screen.getByTestId("row-place").getAttribute("data-thread-badge")).toBe("idle");
  });

  it("transcript deleted: red with a trash icon, then the place (docs/notes/transcript-deleted.md)", () => {
    expect(renderRow({ state: "disconnected", transcriptMissing: true }).textContent).toBe("Transcript deleted · code-foundry @ main");
    expect(screen.getByTestId("row-place").getAttribute("data-status-line")).toBe("transcriptDeleted");
    expect(screen.getByTestId("row-status").className).toContain("text-cf-error-text");
    expect(screen.getByTestId("row-transcript-deleted").getAttribute("class")).toContain("lucide-trash-2");
  });

  it("the @ is muted and the branch mono", () => {
    renderRow({});
    expect(screen.getByText("@").className).toContain("opacity-60");
    expect(screen.getByTestId("row-branch").className).toContain("font-mono");
  });
});

describe("SidebarRow running agents", () => {
  it.each([
    ["idle: N agents, then the place", { agentsRunning: 3 }, "3 agents · code-foundry @ main"],
    ["one", { agentsRunning: 1 }, "1 agent · code-foundry @ main"],
    ["working: before the status", { agentsRunning: 2, status: "busy" as const }, "2 agents · Working · code-foundry @ main"],
    ["a question: before it, no place", { agentsRunning: 1, status: "attention" as const, statusReason: "question: Which one?" }, "1 agent · Asked a question"],
    ["none: nothing", { agentsRunning: 0 }, "code-foundry @ main"],
  ])("%s", (_name, o, text) => {
    expect(renderRow(o).textContent).toBe(text);
  });

  it("is sky with a bot icon", () => {
    renderRow({ agentsRunning: 2 });
    const el = screen.getByTestId("row-agents");
    expect(el.className).toContain("text-cf-info-text");
    expect(el.querySelector("svg")).not.toBeNull();
  });
});

describe("SidebarRow provisional name", () => {
  it.each([
    ["provisional: the name, muted and italic", { name: "fix the login redirect", nameProvisional: true }, "fix the login redirect", true, true],
    ["the naming model's title: plain", { name: "Fix the login redirect", nameProvisional: false }, "Fix the login redirect", false, false],
    ["unnamed: the id, muted, not italic", { name: "", nameProvisional: false }, "s-1", true, false],
  ])("%s", (_name, o, text, muted, italic) => {
    renderRow(o);
    const el = screen.getByTestId("thread-name");
    expect(el.textContent).toBe(text);
    expect(el.className.includes("text-cf-sidebar-muted-foreground")).toBe(muted);
    expect(el.className.includes("italic")).toBe(italic);
    expect(el.getAttribute("data-provisional")).toBe(italic ? "true" : null);
    // One role above the row's text-body-sm, semibold; a named thread keeps the row's colour.
    const cls = el.className.split(" ");
    expect(cls).toContain("text-body");
    expect(cls).toContain("font-semibold");
    expect(cls).not.toContain("text-body-sm");
    expect(cls.includes("text-inherit")).toBe(!muted);
  });
});

describe("SidebarRow rename field", () => {
  function openRename(o: Partial<ThreadView>): HTMLInputElement {
    renameThread.mockClear();
    useUiStore.setState({ renamingThreadId: "s-1" });
    renderRow(o);
    return screen.getByTestId<HTMLInputElement>("rename-input");
  }

  it("the naming model's title landing while it is open: an untouched commit keeps the title", () => {
    const input = openRename({ name: "fix the login redirect", nameProvisional: true });
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": thread({ name: "Fix login redirect loop", nameProvisional: false }) } });
    });
    fireEvent.blur(input);
    expect(renameThread).not.toHaveBeenCalled();
  });

  it("an edit commits", () => {
    const input = openRename({ name: "fix the login redirect", nameProvisional: true });
    fireEvent.change(input, { target: { value: "Login loop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameThread).toHaveBeenCalledWith("s-1", "Login loop");
  });
});

describe("SidebarRow archived", () => {
  function renderArchived(o: Partial<ThreadView>): HTMLElement {
    useThreadsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "archived", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it("one line: the name and the age of the archive, no status line, not dimmed", () => {
    const row = renderArchived({ name: "Old work", archivedAtMs: Date.now() - 3 * 3_600_000 - 60_000 });
    expect(row.textContent).toBe("Old work3h");
    expect(screen.queryByTestId("row-place")).toBeNull();
    expect(screen.getByTestId("row-archived-age").className).toContain("tabular-nums");
    expect(screen.getByTestId("thread-body").className).not.toContain("opacity-50");
  });

  it("quiet: the name keeps text-body but is regular and muted, and so is the age", () => {
    renderArchived({ name: "Old work", archivedAtMs: Date.now() });
    const cls = screen.getByTestId("thread-name").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground"]));
    expect(cls).not.toContain("font-semibold");
    expect(cls).not.toContain("text-inherit");
    expect(screen.getByTestId("row-archived-age").className.split(" ")).toEqual(expect.arrayContaining(["text-caption-sm", "text-cf-sidebar-muted-foreground"]));
    expect(screen.getByTestId("row-archived-age").querySelector("svg")).toBeNull();
  });

  it("a provisional name stays italic on the quiet row", () => {
    renderArchived({ name: "fix the login redirect", nameProvisional: true, archivedAtMs: Date.now() });
    const cls = screen.getByTestId("thread-name").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground", "italic"]));
    expect(cls).not.toContain("font-semibold");
  });

  it("an unnamed thread shows its id, muted", () => {
    renderArchived({ name: "", archivedAtMs: Date.now() });
    expect(screen.getByTestId("thread-name").textContent).toBe("s-1");
    expect(screen.getByTestId("thread-name").className).toContain("text-cf-sidebar-muted-foreground");
    expect(screen.getByTestId("row-archived-age").textContent).toBe("0m");
  });
});

describe("SidebarRow snoozed", () => {
  function renderSnoozed(o: Partial<ThreadView>): HTMLElement {
    useThreadsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "snoozed", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it.each([
    [45 * 60_000 + 30_000, "45m"],
    [2 * 3_600_000 + 50 * 60_000, "2h"],
    [18 * 3_600_000 + 5 * 60_000, "18h"],
    [4 * 86_400_000 + 3_600_000, "4d"],
    [20_000, "<1m"],
  ])("one line: the name and the time left (%i ms → %s), no status line, not dimmed", (left, want) => {
    const row = renderSnoozed({ name: "Later work", snoozedUntilMs: Date.now() + left });
    expect(row.textContent).toBe(`Later work${want}`);
    expect(row.getAttribute("data-section")).toBe("snoozed");
    expect(screen.queryByTestId("row-place")).toBeNull();
    expect(screen.getByTestId("row-snooze-left").className).toContain("tabular-nums");
    expect(screen.getByTestId("row-snooze-left").className).toContain("text-caption-sm");
    expect(screen.getByTestId("thread-body").className).not.toContain("opacity-50");
    expect(screen.getByTestId("thread-body").hasAttribute("data-snoozed")).toBe(true);
  });

  it("quiet: regular muted name; the countdown is an alarm clock then the time left, muted", () => {
    renderSnoozed({ name: "Later work", snoozedUntilMs: Date.now() + 2 * 3_600_000 + 60_000 });
    const name = screen.getByTestId("thread-name").className.split(" ");
    expect(name).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground"]));
    expect(name).not.toContain("font-semibold");
    const left = screen.getByTestId("row-snooze-left");
    expect(left.className.split(" ")).toEqual(expect.arrayContaining(["text-caption-sm", "text-cf-sidebar-muted-foreground", "gap-1"]));
    const icon = screen.getByTestId("row-snooze-icon");
    expect(left.firstElementChild).toBe(icon);
    expect(icon.getAttribute("class")).toContain("lucide-alarm-clock");
    expect(icon.getAttribute("class")).toContain("size-3");
    expect(left.textContent).toBe("2h");
  });

  it("an unnamed thread shows its id, muted", () => {
    renderSnoozed({ name: "", snoozedUntilMs: Date.now() + 3_600_000 + 1000 });
    expect(screen.getByTestId("thread-name").textContent).toBe("s-1");
    expect(screen.getByTestId("thread-name").className).toContain("text-cf-sidebar-muted-foreground");
    expect(screen.getByTestId("row-snooze-left").textContent).toBe("1h");
  });
});

describe("SidebarRow line 2 after a snooze", () => {
  it("a woken thread reads Snooze ended with how long ago, amber, without the place", () => {
    renderRow({ state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() - 2 * 60_000 });
    expect(screen.getByTestId("row-place").textContent).toBe("Snooze ended · 2 min ago");
    expect(screen.getByTestId("row-status").className).toContain("text-cf-warning-text");
    expect(screen.getByTestId("row-place").getAttribute("data-status-line")).toBe("snoozeEnded");
  });
});

describe("SidebarRow footer headers", () => {
  it.each([
    ["working", "Working", 2, false],
    ["snoozed", "Snoozed", 3, true],
    ["archived", "Archived", 5, true],
  ] as const)("%s: label and count, a toggle button", (section, label, count, collapsed) => {
    render(<SidebarRow row={{ key: `h:${section}`, kind: "header", section, label, count, collapsed }} selected={false} cursor={false} onActivate={() => undefined} />);
    const button = screen.getByTestId(`${section}-header`);
    expect(button.textContent).toBe(`${label} ${String(count)}`);
    expect(button.getAttribute("aria-expanded")).toBe(collapsed ? "false" : "true");
  });

  it("the Snoozed header toggles only the Snoozed section", () => {
    useUiStore.setState({ workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
    render(<SidebarRow row={{ key: "h:snoozed", kind: "header", section: "snoozed", label: "Snoozed", count: 1, collapsed: true }} selected={false} cursor={false} onActivate={() => undefined} />);
    fireEvent.click(screen.getByTestId("snoozed-header"));
    expect(useUiStore.getState()).toMatchObject({ workingCollapsed: false, snoozedCollapsed: false, archivedCollapsed: true });
  });
});

describe("SidebarRow created by a thread", () => {
  const glyph = () => screen.queryByTestId("row-created-by");

  it("a muted ↳ before the name of an agent's thread; line 2 unchanged", () => {
    renderRow({ name: "Child", createdBy: "s-p", createdByName: "Parent" });
    const g = glyph();
    expect(g).not.toBeNull();
    expect(g?.getAttribute("class")).toContain("text-cf-icon-muted");
    expect(g?.nextElementSibling?.getAttribute("data-testid")).toBe("thread-name");
    expect(screen.getByTestId("row-place").textContent).toBe("code-foundry @ main");
  });

  it("nothing for the user's thread", () => {
    renderRow({ name: "Mine" });
    expect(glyph()).toBeNull();
  });

  it("in the single-line footers too", () => {
    useThreadsStore.setState({ byId: { "s-1": thread({ name: "Old child", createdBy: "s-p", archivedAtMs: Date.now() }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "archived", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    expect(glyph()?.nextElementSibling?.textContent).toBe("Old child");
  });
});

describe("SidebarRow waiting on its child threads", () => {
  it("reads Waiting after a muted hourglass, then the place; idle-like, not amber or emerald", () => {
    renderRow({ status: "idle", statusReason: "waiting on 2 child threads" });
    expect(screen.getByTestId("row-place").textContent).toBe("Waiting · code-foundry @ main");
    expect(screen.getByTestId("row-place").getAttribute("data-status-line")).toBe("waiting");
    expect(screen.getByTestId("row-place").getAttribute("data-thread-badge")).toBe("idle");
    expect(screen.getByTestId("row-status").className).toBe("");
    expect(screen.getByTestId("row-waiting").getAttribute("class")).toContain("text-cf-icon-muted");
  });
});

describe("SidebarRow linked PRs tag", () => {
  const SLUG = "o/r";
  const link = (number: number) => ({ slug: SLUG, number, url: `https://github.com/${SLUG}/pull/${String(number)}`, linkedAt: null });
  const pr = (number: number, state: PullRequestView["state"], o: Partial<PullRequestView> = {}) =>
    ({ repoSlug: SLUG, number, state, draft: false, title: `PR ${String(number)}`, updatedAtMs: 1, partial: false, ...o }) as PullRequestView;
  const dashboard = (authored: PullRequestView[], recentlyMerged: PullRequestView[] = []) =>
    ({ authored, reviewRequested: [], reviewed: [], recentlyMerged }) as unknown as DashboardView;

  beforeEach(() => {
    pullRequestDetailResource.store.setState({ entries: {} });
    dashboardResource.store.setState({ entries: {} });
  });

  const tag = () => screen.queryByTestId("row-linked-prs");

  it("no links, or only closed ones: no tag", () => {
    renderRow({});
    expect(tag()).toBeNull();
    cleanup();
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(131)] });
    expect(tag()).toBeNull();
  });

  it.each([
    ["open: green, the PR icon", pr(142, "open"), "open", "success", "text-cf-success-text"],
    ["draft: the draft tone", pr(145, "open", { draft: true }), "draft", "draft", "text-cf-text-muted"],
    ["merged: the merged tone", pr(138, "merged"), "merged", "merged", "text-cf-highlight-text"],
  ])("one %s, the bare number", (_name, p, state, tone, cls) => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([p]) });
    renderRow({ linkedPullRequests: [link(p.number)] });
    const el = tag();
    expect(el?.textContent).toBe(String(p.number));
    expect(el?.getAttribute("data-state")).toBe(state);
    expect(el?.getAttribute("data-tone")).toBe(tone);
    expect(el?.className).toContain(cls);
    expect(el?.querySelector(`svg[aria-label="${state}"]`)).not.toBeNull();
  });

  it("one not read yet: the number, neutral, the generic icon", () => {
    renderRow({ linkedPullRequests: [link(7)] });
    expect(tag()?.textContent).toBe("7");
    expect(tag()?.getAttribute("data-state")).toBe("unknown");
    expect(tag()?.getAttribute("data-tone")).toBe("neutral");
  });

  it("several: the count without closed ones, in the worst state's tone", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(1, "open"), pr(2, "open", { draft: true })], [pr(3, "merged")]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 4), { data: { pullRequest: pr(4, "closed") } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(1), link(2), link(3), link(4)] });
    expect(tag()?.textContent).toBe("3 PRs");
    expect(tag()?.getAttribute("data-kind")).toBe("many");
    expect(tag()?.getAttribute("data-tone")).toBe("draft");
  });

  it("the fresher read wins: a cached detail newer than the dashboard", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open", { updatedAtMs: 1 })]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 142), { data: { pullRequest: pr(142, "merged", { updatedAtMs: 2 }) } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(142)] });
    expect(tag()?.getAttribute("data-state")).toBe("merged");
  });

  it("re-renders when the state moves", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open")]) });
    renderRow({ linkedPullRequests: [link(142)] });
    expect(tag()?.getAttribute("data-state")).toBe("open");
    act(() => {
      dashboardResource.set(DASHBOARD_KEY, { data: dashboard([], [pr(142, "merged", { updatedAtMs: 2 })]) });
    });
    expect(tag()?.getAttribute("data-state")).toBe("merged");
  });
});

describe("SidebarRow card (docs/notes/sidebar-thread-card.md)", () => {
  const SLUG = "o/r";
  const link = (number: number, at: number) => ({ slug: SLUG, number, url: `https://github.com/${SLUG}/pull/${String(number)}`, linkedAt: at });
  const pr = (number: number, state: PullRequestView["state"], o: Partial<PullRequestView> = {}) =>
    ({ repoSlug: SLUG, number, state, draft: false, title: `PR ${String(number)}`, updatedAtMs: 1, partial: false, ...o }) as PullRequestView;
  const dashboard = (authored: PullRequestView[], recentlyMerged: PullRequestView[] = []) =>
    ({ authored, reviewRequested: [], reviewed: [], recentlyMerged }) as unknown as DashboardView;

  beforeEach(() => {
    pullRequestDetailResource.store.setState({ entries: {} });
    dashboardResource.store.setState({ entries: {} });
    useProjectsStore.setState({
      byId: {
        cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }, { path: "/wt/cf/feat-x", branch: "feat/x", head: "b", isMain: false }] },
        gp: { id: "gp", name: "ghostty-playground", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/gp", branch: "main", head: "c", isMain: true }, { path: "/wt/gp/cf-login", branch: "cf/login", head: "d", isMain: false }] },
        notes: { id: "notes", name: "writing", git: false, githubSlug: "", remotes: [], worktrees: [{ path: "/src/notes", branch: "", head: "", isMain: true }] },
      } as never,
      order: ["cf", "gp", "notes"],
    });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login" } } as never });
  });

  /** Renders the row and opens its card (the provider's 500 ms delay on fake timers). */
  function openCard(o: Partial<ThreadView>): HTMLElement {
    vi.useFakeTimers();
    try {
      renderRow(o);
      fireEvent.pointerMove(screen.getByRole("option"), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    return screen.getAllByTestId("thread-tooltip")[0] as HTMLElement;
  }
  const ids = (card: HTMLElement) => Array.from(card.querySelectorAll(":scope > div")).map((e) => e.getAttribute("data-testid"));
  const text = (card: HTMLElement, id: string) => within(card).queryByTestId(id)?.textContent ?? null;

  it.each([
    ["the main checkout: Project folder", { worktreePath: "/src/cf" }, "Project folder", "main"],
    ["a worktree made for it: Fresh copy, no worktree chip on the branch", { worktreePath: "/wt/cf/feat-x", createdWorktree: true, branch: "feat/x" }, "Fresh copy", "feat/x"],
    ["a worktree the user picked: no chip", { worktreePath: "/wt/cf/feat-x" }, null, "feat/x"],
  ])("one project, %s", (_name, o, chip, branch) => {
    const card = openCard(o);
    expect(ids(card)).toEqual(["tip-name", "tip-project", "tip-branch", "tip-model"]);
    expect(text(card, "tip-project-chip")).toBe(chip);
    expect(text(card, "tip-branch")).toBe(branch);
    expect(within(card).queryByTestId("tip-branch-chip")).toBeNull();
  });

  it("a project without git keeps its no git chip", () => {
    const card = openCard({ projectId: "notes", projectIds: ["notes"], worktreePath: "/src/notes" });
    expect(text(card, "tip-project-chip")).toBe("no git");
    expect(within(card).queryByTestId("tip-branch")).toBeNull();
  });

  it("a workspace thread: workspace, then the run-in project with Fresh copy, branch, model; no member list", () => {
    const card = openCard({ projectId: "gp", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/wt/gp/cf-login", createdWorktree: true, branch: "cf/login" });
    expect(ids(card)).toEqual(["tip-name", "tip-workspace", "tip-project", "tip-branch", "tip-model"]);
    expect(text(card, "tip-workspace")).toBe("login2 projects");
    expect(text(card, "tip-workspace-meta")).toBe("2 projects");
    expect(within(card).getByTestId("tip-workspace").querySelector("svg")?.getAttribute("class")).toContain("lucide-layers");
    expect(text(card, "tip-project")).toBe("ghostty-playgroundFresh copy");
    expect(text(card, "tip-project-chip")).toBe("Fresh copy");
    expect(text(card, "tip-branch")).toBe("cf/login");
    expect(within(card).queryByTestId("tip-set")).toBeNull();
  });

  it("an unnamed set: N projects, in place: Project folder", () => {
    const card = openCard({ projectId: "gp", projectIds: ["cf", "gp"], worktreePath: "/src/gp" });
    expect(text(card, "tip-workspace")).toBe("2 projects");
    expect(within(card).queryByTestId("tip-workspace-meta")).toBeNull();
    expect(text(card, "tip-project-chip")).toBe("Project folder");
  });

  it("a thread in its workspace's folder: the workspace, then the folder as the place, no chip", () => {
    const card = openCard({ projectId: "", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/home/.code-foundry/workspaces/w-1", createdWorktree: true, branch: "cf/login" });
    expect(text(card, "tip-workspace")).toBe("login2 projects");
    expect(text(card, "tip-project")).toBe("Workspace folder");
    expect(within(card).queryByTestId("tip-project-chip")).toBeNull();
  });

  it("no linked PRs, or only closed ones: no section, no hairline", () => {
    let card = openCard({});
    expect(within(card).queryByTestId("tip-prs")).toBeNull();
    cleanup();
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    card = openCard({ linkedPullRequests: [link(131, 1)] });
    expect(within(card).queryByTestId("tip-prs")).toBeNull();
  });

  it("the linked PRs after the model, newest linked first, closed left out, state icon and number in the state's colour", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open", { title: "Fix the login" }), pr(145, "open", { draft: true, title: "Draft it" })], [pr(138, "merged", { title: "Merged one" })]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    const card = openCard({ linkedPullRequests: [link(138, 1), link(131, 2), link(145, 3), link(142, 4), link(7, 5)] });
    expect(ids(card).at(-1)).toBe("tip-prs");
    const rows = within(card).getAllByTestId("tip-pr");
    expect(rows.map((r) => r.textContent)).toEqual(["#7", "#142Fix the login", "#145Draft it", "#138Merged one"]);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["unknown", "open", "draft", "merged"]);
    expect(rows[1]?.querySelector("svg")?.getAttribute("class")).toContain("text-cf-success-text");
    expect(rows[1]?.querySelector("span")?.className).toContain("text-cf-success-text");
    expect(rows[2]?.querySelector('svg[aria-label="draft"]')).not.toBeNull();
    expect(rows[3]?.querySelector("span")?.className).toContain("text-cf-highlight-text");
    expect(rows[1]?.querySelector(".truncate")?.textContent).toBe("Fix the login");
    expect(within(card).queryByTestId("tip-prs-more")).toBeNull();
  });

  it("at most five rows, then +N more", () => {
    const card = openCard({ linkedPullRequests: [1, 2, 3, 4, 5, 6, 7].map((n) => link(n, n)) });
    expect(within(card).getAllByTestId("tip-pr")).toHaveLength(5);
    expect(text(card, "tip-prs-more")).toBe("+2 more");
  });
});

describe("SidebarRow line 2 of a multi-project thread: the run-in project only", () => {
  beforeEach(() => {
    useProjectsStore.setState({
      byId: {
        cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] },
        gp: { id: "gp", name: "ghostty-playground", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/wt/gp/cf-login", branch: "cf/login", head: "d", isMain: false }] },
      } as never,
      order: ["cf", "gp"],
    });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login" } } as never });
  });

  it.each([
    ["a workspace thread", { projectId: "gp", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/wt/gp/cf-login", createdWorktree: true, branch: "cf/login" }, "ghostty-playground @ cf/login"],
    ["an unnamed set", { projectId: "cf", projectIds: ["cf", "gp"], worktreePath: "/src/cf" }, "code-foundry @ main"],
    ["a thread in its workspace's folder: the workspace, the place", { projectId: "", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/home/.code-foundry/workspaces/w-1", createdWorktree: true, branch: "cf/login" }, "login @ cf/login"],
  ])("%s", (_name, o, want) => {
    expect(renderRow(o).textContent).toBe(want);
  });
});
