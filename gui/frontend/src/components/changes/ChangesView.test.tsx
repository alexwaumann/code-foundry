import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, WorktreeView } from "@/api/project";
import type { FileChangeView, LogEntryView, WorktreeDetailView } from "@/api/worktreeDetail";

const details = vi.hoisted(() => new Map<string, unknown>());
const getWorktreeDetail = vi.hoisted(() => vi.fn((_repo: string, path: string) => Promise.resolve(details.get(path))));
const openDiffInPanel = vi.hoisted(() => vi.fn(() => true));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), getWorktreeDetail }));
vi.mock("@/stores/filePanel", async (orig) => ({ ...(await orig<typeof import("@/stores/filePanel")>()), openDiffInPanel }));
vi.mock("@/stores/gh", async (orig) => ({ ...(await orig<typeof import("@/stores/gh")>()), openUrl }));

const { ChangesView } = await import("./ChangesView");
const { useProjectsStore } = await import("@/stores/projects");

/** Each test gets its own worktree path: the resources cache by key across tests. */
let n = 0;
let P = "";

function world(project: Partial<ProjectView> = {}): void {
  const wt: WorktreeView = { projectId: "web", path: P, branch: "cf/feat", head: "abcdef1234", detached: false, isMain: false, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: 1 } };
  useProjectsStore.setState({
    byId: { web: { id: "web", path: "/src/web", name: "web", defaultBranch: "main", githubSlug: "o/web", remotes: ["origin"], git: true, worktrees: [wt], ...project } },
    order: ["web"],
  });
}

const file = (path: string, o: Partial<FileChangeView> = {}): FileChangeView => ({ path, oldPath: "", status: "M", added: 1, deleted: 1, binary: false, uncommitted: false, ...o });
const commit = (i: number): LogEntryView => ({ sha: `${String(i).padStart(7, "0")}${"f".repeat(33)}`, shortSha: String(i).padStart(7, "0"), subject: `commit ${String(i)}`, authorName: "Alex", authorEmail: "a@x", authoredAtMs: Date.now() - (i + 1) * 3_600_000 });

function detail(files: FileChangeView[], log: LogEntryView[], o: Partial<WorktreeDetailView> = {}): void {
  details.set(P, { projectId: "web", path: P, baseRef: "origin/main", mergeBase: "x", head: "y", files, filesTruncated: false, log, logTotal: log.length, computedAtMs: 1, error: "", ...o } satisfies WorktreeDetailView);
}

async function show(): Promise<void> {
  render(<ChangesView projectId="web" path={P} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const navKeys = () => [...screen.getByTestId("changes-surface").querySelectorAll("[data-nav-key]")].map((e) => e.getAttribute("data-nav-key"));

beforeEach(() => {
  // jsdom has no layout: NavRow scrolls its cursor row into view.
  Element.prototype.scrollIntoView = vi.fn();
  P = `/src/web.worktrees/feat-${String(++n)}`;
  details.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChangesView", () => {
  it("lists the changes against the base and the collapsed commits, and nothing of the old Worktree tab", async () => {
    world();
    detail([file("gui/src/a.ts", { added: 41, deleted: 190 }), file("docs/new.md", { status: "A", added: 8, deleted: 0 })], [commit(0), commit(1)]);
    await show();
    expect(screen.getByTestId("changes-totals").textContent).toBe("2 files · +49 −190");
    expect(screen.getByTestId("worktree-changes").textContent).toContain("vs main");
    expect(screen.getByTestId("worktree-commits").textContent).toContain("2 ahead of main");
    expect(navKeys()).toEqual(["f:gui/src/a.ts", "f:docs/new.md", "commits"]);
    for (const gone of ["worktree-surface-header", "fact-origin-value", "overview-pr", "also-in"]) expect(screen.queryByTestId(gone)).toBeNull();
  });

  it("a file opens its Diff tab in the panel", async () => {
    world();
    detail([file("a.ts", { uncommitted: true })], []);
    await show();
    fireEvent.click(screen.getByTestId("changes-surface").querySelector('[data-nav-key="f:a.ts"]') as HTMLElement);
    expect(openDiffInPanel).toHaveBeenCalledWith("current", expect.objectContaining({ project: "web", worktree: P, path: "a.ts", scope: "working" }));
  });

  it("a committed change opens on the branch, a rename with its old path (e2e/file-tabs.spec.ts)", async () => {
    world();
    detail([file("docs/notes/sidebar.md", { status: "R", oldPath: "docs/sidebar.md" })], []);
    await show();
    fireEvent.click(screen.getByTestId("changes-surface").querySelector('[data-nav-key="f:docs/notes/sidebar.md"]') as HTMLElement);
    expect(openDiffInPanel).toHaveBeenCalledWith("current", { project: "web", worktree: P, path: "docs/notes/sidebar.md", oldPath: "docs/sidebar.md", scope: "branch" });
  });

  it("caps the changes at ten rows and scrolls; a truncated list says so", async () => {
    world();
    detail(
      Array.from({ length: 14 }, (_, i) => file(`pkg/f${String(i)}.go`)),
      [],
      { filesTruncated: true },
    );
    await show();
    const list = screen.getByTestId("changes-list");
    expect(list.style.maxHeight).toBe("240px");
    expect(list.querySelectorAll("[data-nav-key]")).toHaveLength(14);
    expect(screen.getByTestId("changes-truncated").textContent).toBe("list truncated");
  });

  it("commits open on click and from the keyboard; a commit opens on GitHub", async () => {
    world();
    detail([file("a.ts")], Array.from({ length: 12 }, (_, i) => commit(i)));
    await show();
    fireEvent.click(screen.getByTestId("worktree-commits").querySelector('[data-nav-key="commits"]') as HTMLElement);
    expect(screen.getByTestId("worktree-commits").getAttribute("data-open")).toBe("true");
    expect(screen.getByTestId("commits-list").querySelectorAll("[data-nav-key]")).toHaveLength(12);
    const box = screen.getByTestId("changes-nav");
    fireEvent.keyDown(box, { key: "End" });
    expect(box.getAttribute("aria-activedescendant")).toBe(`nav-l_${commit(11).sha}`);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(openUrl).toHaveBeenCalledWith(`https://github.com/o/web/commit/${commit(11).sha}`);
  });

  it("clean: No changes against the base, no commits", async () => {
    world();
    detail([], []);
    await show();
    expect(screen.getByTestId("worktree-changes").textContent).toContain("No changes against main.");
    expect(screen.queryByTestId("worktree-commits")).toBeNull();
  });

  it("while the detail loads: Computing…", async () => {
    world();
    getWorktreeDetail.mockReturnValueOnce(new Promise(() => undefined));
    await show();
    expect(screen.getByTestId("worktree-changes").textContent).toContain("Computing…");
  });

  it("a project without git, and a worktree that is gone, say so", async () => {
    world({ git: false });
    await show();
    expect(screen.getByTestId("changes-nogit")).toBeTruthy();
    cleanup();
    world({ worktrees: [] });
    await show();
    expect(screen.getByTestId("changes-missing")).toBeTruthy();
  });

  it("a project without git lists nothing; once git init made it a repository, the lists take over", async () => {
    world({ git: false });
    detail([], []);
    await show();
    expect(screen.getByTestId("changes-nogit").textContent).toContain("Not a git repository");
    expect(screen.queryByTestId("worktree-changes")).toBeNull();
    expect(screen.queryByTestId("worktree-commits")).toBeNull();
    // The daemon's project event after project.git.init.
    await act(async () => {
      world({ git: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("changes-nogit")).toBeNull();
    expect(screen.getByTestId("worktree-changes")).toBeTruthy();
  });
});
