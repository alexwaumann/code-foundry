import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestView } from "@/api/gh";
import type { GitStatusView, RepoView, WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import type { FileChangeView, LogEntryView, WorktreeDetailView } from "@/api/worktreeDetail";

const details = vi.hoisted(() => new Map<string, unknown>());
const prs = vi.hoisted(() => new Map<string, unknown[]>());
const getWorktreeDetail = vi.hoisted(() => vi.fn((_repo: string, path: string) => Promise.resolve(details.get(path))));
const getBranchPullRequests = vi.hoisted(() => vi.fn((_slug: string, head: string) => Promise.resolve({ pullRequests: prs.get(head) ?? [], fetchedAtMs: 1, lastError: "" })));
const openPullRequestInPanel = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), getWorktreeDetail }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getBranchPullRequests }));
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), openPullRequestInPanel }));
vi.mock("@/stores/gh", async (orig) => ({ ...(await orig<typeof import("@/stores/gh")>()), openUrl }));

const { WorktreePanelView } = await import("./WorktreeOverview");
const { useReposStore } = await import("@/stores/repos");
const { useSessionsStore } = await import("@/stores/sessions");
const { useTerminalsStore } = await import("@/stores/terminals");
const { useUiStore } = await import("@/stores/ui");

/** Each test gets its own worktree path: the resources cache by key across tests. */
let n = 0;
let P = "";

const status = (o: Partial<GitStatusView> = {}): GitStatusView => ({
  upstream: "origin/cf/feat",
  ahead: 2,
  behind: 0,
  staged: 1,
  modified: 2,
  untracked: 1,
  dirty: true,
  refreshedAtMs: 1,
  baseRef: "origin/main",
  baseAhead: 6,
  baseBehind: 3,
  ...o,
});

function world(st: GitStatusView, branch = "cf/feat", repo: Partial<RepoView> = {}): void {
  const wt: WorktreeView = { repoId: "web", path: P, branch, head: "abcdef1234", detached: branch === "", isMain: false, status: st };
  useReposStore.setState({
    byId: { web: { id: "web", path: "/src/web", name: "web", defaultBranch: "main", githubSlug: "o/web", remotes: ["origin"], git: true, worktrees: [wt], ...repo } },
    order: ["web"],
  });
}

const file = (path: string, o: Partial<FileChangeView> = {}): FileChangeView => ({ path, oldPath: "", status: "M", added: 1, deleted: 1, binary: false, uncommitted: false, isDir: false, ...o });
const commit = (i: number): LogEntryView => ({ sha: `${String(i).padStart(7, "0")}${"f".repeat(33)}`, shortSha: String(i).padStart(7, "0"), subject: `commit ${String(i)}`, authorName: "Alex", authorEmail: "a@x", authoredAtMs: Date.now() - (i + 1) * 3_600_000 });

function detail(files: FileChangeView[], log: LogEntryView[], o: Partial<WorktreeDetailView> = {}): void {
  details.set(P, { repoId: "web", path: P, baseRef: "origin/main", mergeBase: "x", head: "y", files, filesTruncated: false, log, logTotal: log.length, computedAtMs: 1, error: "", ...o } satisfies WorktreeDetailView);
}

const pr = (number: number, o: Partial<PullRequestView> = {}): PullRequestView =>
  ({
    repoSlug: "o/web",
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/o/web/pull/${String(number)}`,
    state: "open",
    draft: false,
    review: "approved",
    checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 },
    createdAtMs: number,
    updatedAtMs: Date.now() - 3_600_000,
    mergedAtMs: null,
    ...o,
  }) as PullRequestView;

const thread = (id: string, worktreePath: string, o: Partial<SessionView> = {}) => ({ id, worktreePath, archivedAtMs: null, ...o }) as SessionView;
const term = (id: string, cwd: string, state: TerminalView["state"] = "running") => ({ id, cwd, state }) as TerminalView;

async function show(): Promise<void> {
  render(<WorktreePanelView repoId="web" path={P} />);
  // The detail and pull request fetches resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const surface = () => screen.getByTestId("worktree-surface");
const q = (id: string) => screen.queryByTestId(id);
/** The element, failing the test when it is missing. */
function el<T extends Element>(e: T | null | undefined): T {
  if (!e) throw new Error("element not found");
  return e;
}
const navKeys = () => [...surface().querySelectorAll("[data-nav-key]")].map((e) => e.getAttribute("data-nav-key"));

beforeEach(() => {
  // jsdom has no layout: NavRow scrolls its cursor row into view.
  Element.prototype.scrollIntoView = vi.fn();
  P = `/src/web.worktrees/feat-${String(++n)}`;
  details.clear();
  prs.clear();
  useSessionsStore.setState({ byId: {}, order: [] });
  useTerminalsStore.setState({ byId: {}, order: [] });
  useUiStore.setState({ selection: { kind: "none" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorktreePanelView", () => {
  it("shows the header, facts, the pull request, changes and collapsed commits, and nothing of the old panel", async () => {
    world(status());
    detail([file("gui/src/a.ts", { added: 41, deleted: 190 }), file("docs/new.md", { status: "A", added: 8, deleted: 0 })], [commit(0), commit(1)]);
    prs.set("cf/feat", [pr(126)]);
    await show();

    expect(screen.getByTestId("worktree-surface-title").textContent).toBe("web@cf/feat");
    expect(screen.getByTestId("fact-origin").textContent).toBe("origin↑2 to push");
    expect(screen.getByTestId("fact-base").textContent).toBe("vs main↑6 ↓3");
    expect(screen.getByTestId("fact-tree").textContent).toBe("working tree4 changed");
    expect(q("worktree-operation")).toBeNull();

    const row = screen.getByTestId("overview-pr");
    expect(row.getAttribute("data-state")).toBe("open");
    expect(row.textContent).toContain("#126");
    expect(row.textContent).toContain("PR 126");
    expect(row.textContent).toContain("3/3 passed");
    expect(row.textContent).toContain("approved");

    const changes = screen.getByTestId("worktree-changes");
    expect(within(changes).getByTestId("changes-totals").textContent).toBe("2 files · +49 −190");
    expect(changes.textContent).toContain("vs main");
    const [a, b] = within(changes).getAllByTestId("file-path");
    expect(within(el(a)).getByTestId("file-dir").textContent).toBe("‎gui/src/‎");
    expect(within(el(a)).getByTestId("file-name").textContent).toBe("a.ts");
    expect(within(el(b)).getByTestId("file-name").textContent).toBe("new.md");
    // + and − sit in their own columns, blank at zero.
    expect(within(changes).getAllByTestId("file-added").map((e) => e.textContent)).toEqual(["+41", "+8"]);
    expect(within(changes).getAllByTestId("file-deleted").map((e) => e.textContent)).toEqual(["−190", ""]);

    const commits = screen.getByTestId("worktree-commits");
    expect(commits.getAttribute("data-open")).toBe("false");
    expect(commits.textContent).toContain("Commits2 ahead of main");
    expect(commits.textContent).toContain("newest 1h");
    expect(q("commits-list")).toBeNull();

    for (const gone of ["sync-line", "section-github", "gh-activity", "section-files", "section-log", "files-list", "log-list", "files-computed", "gh-updated"]) expect(q(gone)).toBeNull();
    expect(surface().querySelector("button")).toBeNull();
  });

  it("who else: other unarchived threads on the path (not the selected one) and live shells; hidden when alone", async () => {
    world(status());
    detail([], []);
    useSessionsStore.setState({
      byId: { me: thread("me", P), a: thread("a", P), b: thread("b", P), old: thread("old", P, { archivedAtMs: 5 }), sub: thread("sub", `${P}/sub`), else: thread("else", "/src/web") },
      order: ["me", "a", "b", "old", "sub", "else"],
    });
    useTerminalsStore.setState({ byId: { t1: term("t1", P), t2: term("t2", P, "exited") }, order: ["t1", "t2"] });
    useUiStore.setState({ selection: { kind: "session", id: "me" } });
    await show();
    const who = screen.getByTestId("worktree-who");
    expect(who.textContent).toBe("2 other threads1 shell");
    // Inside the header, its third line.
    expect(screen.getByTestId("worktree-surface-header").contains(who)).toBe(true);

    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    expect(screen.getByTestId("worktree-who").textContent).toBe("3 other threads1 shell");

    act(() => {
      useSessionsStore.setState({ byId: { me: thread("me", P) }, order: ["me"] });
      useTerminalsStore.setState({ byId: {}, order: [] });
      useUiStore.setState({ selection: { kind: "session", id: "me" } });
    });
    expect(q("worktree-who")).toBeNull();
  });

  it("a rebase stopped on conflicts: the strip, the unmerged card, conflicts first with a tag", async () => {
    world(status({ operation: "rebase", operationStep: 3, operationTotal: 6, conflicted: 2, modified: 0, staged: 0, untracked: 0, upstream: "" }), "");
    detail([file("docs/plan.md", { status: "A", added: 2, deleted: 0 }), file("internal/driver/plan.go", { status: "U", added: 0, deleted: 0 }), file("internal/driver/plan_test.go", { status: "U", added: 0, deleted: 0 })], [commit(0)]);
    await show();
    const strip = screen.getByTestId("worktree-operation");
    expect(strip.getAttribute("data-operation")).toBe("rebase");
    expect(strip.textContent).toBe("Rebase in progress · 2 conflictsstep 3/6");
    expect(screen.getByTestId("fact-tree").textContent).toBe("working tree2 unmerged");
    expect(screen.getByTestId("fact-origin").textContent).toBe("originnot pushed");
    // Totals leave out a zero side, like the rows.
    expect(screen.getByTestId("changes-totals").textContent).toBe("3 files · +2");
    // Detached mid-rebase: no branch, so no pull request row.
    expect(q("overview-pr")).toBeNull();
    const names = within(screen.getByTestId("worktree-changes")).getAllByTestId("file-path").map((e) => e.textContent);
    expect(names).toEqual(["‎internal/driver/‎plan.goconflict", "‎internal/driver/‎plan_test.goconflict", "‎docs/‎plan.md"]);
  });

  it("a merge with one conflict and no steps; no base: no base card", async () => {
    world(status({ operation: "merge", conflicted: 1, baseRef: "", baseAhead: 0, baseBehind: 0 }));
    detail([], [], { baseRef: "" });
    await show();
    expect(screen.getByTestId("worktree-operation").textContent).toBe("Merge in progress · 1 conflict");
    expect(q("fact-base")).toBeNull();
    expect(screen.getByTestId("worktree-changes").textContent).toContain("No changes against HEAD.");
    expect(q("worktree-commits")).toBeNull();
  });

  it("clean, in sync and even; no pull request, no commits", async () => {
    world(status({ ahead: 0, staged: 0, modified: 0, untracked: 0, dirty: false, baseAhead: 0, baseBehind: 0 }));
    detail([], []);
    await show();
    expect(screen.getByTestId("fact-origin-value").textContent).toBe("in sync");
    expect(screen.getByTestId("fact-base-value").textContent).toBe("even");
    expect(screen.getByTestId("fact-tree-value").textContent).toBe("clean");
    expect(q("overview-pr")).toBeNull();
    expect(screen.getByTestId("worktree-changes").textContent).toContain("No changes against main.");
    expect(q("worktree-commits")).toBeNull();
  });

  it.each([
    ["draft: the word and checks, no review", [pr(127, { draft: true, review: "review_required" })], 127, "draft", ["draft", "3/3 passed"], ["review required"]],
    ["merged: the word", [pr(125, { state: "merged", mergedAtMs: Date.now() - 86_400_000 })], 125, "merged", ["merged", "1d"], ["passed", "approved"]],
    ["closed: the word", [pr(119, { state: "closed" })], 119, "closed", ["closed"], ["passed"]],
    ["the newest open one over a newer merged one", [pr(130, { state: "merged" }), pr(128), pr(129)], 129, "open", ["#129"], []],
  ])("pull request row, %s", async (_name, list, number, state, has, hasNot) => {
    world(status());
    detail([], []);
    prs.set("cf/feat", list);
    await show();
    const row = screen.getByTestId("overview-pr");
    expect(row.getAttribute("data-number")).toBe(String(number));
    expect(row.getAttribute("data-state")).toBe(state);
    for (const t of has) expect(row.textContent).toContain(t);
    for (const t of hasNot) expect(row.textContent).not.toContain(t);
  });

  it("caps the changes at ten rows and scrolls; a truncated list says so", async () => {
    world(status());
    detail(
      Array.from({ length: 14 }, (_, i) => file(`pkg/f${String(i)}.go`)),
      [],
      { filesTruncated: true },
    );
    await show();
    const list = screen.getByTestId("changes-list");
    expect(list.style.maxHeight).toBe("240px");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.querySelectorAll("[data-nav-key]")).toHaveLength(14);
    expect(screen.getByTestId("changes-truncated").textContent).toBe("list truncated");
  });

  it("commits open on click with the same cap; the keyboard walks the pull request, files and open commits", async () => {
    world(status());
    detail([file("a.ts"), file("b.ts")], Array.from({ length: 12 }, (_, i) => commit(i)));
    prs.set("cf/feat", [pr(126)]);
    await show();
    expect(navKeys()).toEqual(["pr", "f:a.ts", "f:b.ts", "commits"]);

    fireEvent.click(el(screen.getByTestId("worktree-commits").querySelector('[data-nav-key="commits"]')));
    expect(screen.getByTestId("worktree-commits").getAttribute("data-open")).toBe("true");
    const list = screen.getByTestId("commits-list");
    expect(list.style.maxHeight).toBe("240px");
    expect(list.querySelectorAll("[data-nav-key]")).toHaveLength(12);
    expect(list.textContent).toContain("commit 0");
    expect(list.textContent).toContain("Alex");

    const box = screen.getByTestId("overview-list");
    fireEvent.keyDown(box, { key: "Home" });
    expect(box.getAttribute("aria-activedescendant")).toBe("nav-pr");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "o/web", number: 126 });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/web/pull/126");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe("nav-commits");
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(screen.getByTestId("worktree-commits").getAttribute("data-open")).toBe("false");
    expect(navKeys()).toEqual(["pr", "f:a.ts", "f:b.ts", "commits"]);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "End" });
    expect(box.getAttribute("aria-activedescendant")).toBe(`nav-l_${commit(11).sha}`);
  });

  it("the pull request row: click opens the panel tab, cmd+click GitHub", async () => {
    world(status());
    detail([], []);
    prs.set("cf/feat", [pr(126)]);
    await show();
    const row = el(screen.getByTestId("overview-pr").querySelector('[data-nav-key="pr"]'));
    fireEvent.click(row);
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "o/web", number: 126 });
    fireEvent.click(row, { metaKey: true });
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/web/pull/126");
    expect(openPullRequestInPanel).toHaveBeenCalledTimes(1);
  });

  it("a repository without a remote offers Publish; a non-GitHub remote has no pull request row", async () => {
    world(status({ upstream: "" }), "cf/feat", { githubSlug: "", remotes: [] });
    detail([], []);
    await show();
    expect(screen.getByTestId("publish-github")).toBeTruthy();
    cleanup();

    world(status(), "cf/feat", { githubSlug: "" });
    await show();
    expect(q("no-remote")).toBeNull();
    expect(q("overview-pr")).toBeNull();
    expect(getBranchPullRequests).not.toHaveBeenCalled();
  });

  it("while the detail loads: Computing…", async () => {
    world(status());
    getWorktreeDetail.mockReturnValueOnce(new Promise(() => undefined));
    await show();
    expect(screen.getByTestId("worktree-changes").textContent).toContain("Computing…");
  });
});
