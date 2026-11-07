import { beforeEach, describe, expect, it, vi } from "vitest";

const unregisterProject = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const cleanupMergedWorktrees = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const newTerminalIn = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const removeWorktree = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const resumeWorktree = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/stores/projectActions", async (orig) => ({ ...(await orig<typeof import("@/stores/projectActions")>()), unregisterProject, cleanupMergedWorktrees, newTerminalIn, removeWorktree, resumeWorktree }));
const openCheckoutDiff = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/stores/filePanel", async (orig) => ({ ...(await orig<typeof import("@/stores/filePanel")>()), openCheckoutDiff }));
const openPullRequestInPanel = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), openPullRequestInPanel }));
const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));
const removeWorkspace = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/workspaceActions", async (orig) => ({ ...(await orig<typeof import("@/stores/workspaceActions")>()), removeWorkspace }));

const { checkoutMenu, leftoverMenu, projectMenu, workspaceMenu } = await import("./menus");
const { useProjectsStore } = await import("@/stores/projects");
const { useProjectRenameStore } = await import("@/stores/projectRename");
const { useWorkspaceRenameStore } = await import("@/stores/workspaceRename");
const { useWorkspaceAddProjectStore } = await import("@/stores/workspaceAddProject");
const { useUiStore } = await import("@/stores/ui");
const { useComposeStore } = await import("@/stores/compose");
type Items = ReturnType<typeof projectMenu>;

/** The menu as the user reads it: labels (a count after its item), "—" for a separator. */
function labels(items: Items): string[] {
  return items.map((it) => (it === "separator" ? "—" : it.badge === undefined ? it.label : `${it.label} ${String(it.badge)}`));
}

function item(items: readonly (Items[number] | { kind: string; testId: string })[], testId: string) {
  const it = items.find((x) => x !== "separator" && x.testId === testId);
  if (!it || it === "separator" || "kind" in it) throw new Error(`no ${testId}`);
  return it;
}

/** A workspace's menu as read: its split Open in Finder item says so with its ›. */
function workspaceLabels(items: ReturnType<typeof workspaceMenu>): string[] {
  return items.map((it) => (it === "separator" ? "—" : "kind" in it ? "Open in Finder ›" : it.label));
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectRenameStore.setState({ renamingProjectId: null });
  useWorkspaceRenameStore.setState({ renamingWorkspaceId: null });
  useWorkspaceAddProjectStore.setState({ addingTo: null });
  useProjectsStore.setState({ byId: { "p-1": { id: "p-1", path: "/u/app", worktrees: [{ path: "/u/app", isMain: true }] } as never }, order: ["p-1"] });
});

describe("projectMenu (an index row's context menu, the project page's ⋯)", () => {
  it.each([
    {
      name: "GitHub with merged worktrees",
      facts: { kind: "github", step: null, cleanup: 2 },
      want: ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 2", "—", "Remove project"],
    },
    {
      name: "git without a remote: Publish to GitHub, no clean up",
      facts: { kind: "git", step: "publish", cleanup: null },
      want: ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Publish to GitHub", "—", "Remove project"],
    },
    {
      name: "a folder without git: Initialize git (a count passed in is ignored)",
      facts: { kind: "nogit", step: "init", cleanup: 3 },
      want: ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Initialize git", "—", "Remove project"],
    },
  ] as const)("$name", ({ facts, want }) => {
    expect(labels(projectMenu("p-1", facts))).toEqual(want);
  });

  it.each([
    {
      name: "GitHub",
      facts: { kind: "github", step: null, cleanup: 0 },
      want: ["New thread", "New terminal", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"],
    },
    {
      name: "git without a remote",
      facts: { kind: "git", step: "publish", cleanup: null },
      want: ["New thread", "New terminal", "—", "Rename", "Publish to GitHub", "—", "Remove project"],
    },
    {
      name: "a folder without git",
      facts: { kind: "nogit", step: "init", cleanup: null },
      want: ["New thread", "New terminal", "—", "Rename", "Initialize git", "—", "Remove project"],
    },
  ] as const)("the page's ⋯ ($name) has no Open in Finder and no New action: Details has both", ({ facts, want }) => {
    expect(labels(projectMenu("p-1", facts, { page: true }))).toEqual(want);
  });

  it("Clean up is disabled at 0 and runs the cleanup otherwise; Remove project is destructive", () => {
    expect(item(projectMenu("p-1", { kind: "github", step: null, cleanup: 0 }), "project-cleanup").disabled).toBe(true);
    const items = projectMenu("p-1", { kind: "github", step: null, cleanup: 1 });
    const clean = item(items, "project-cleanup");
    expect(clean.disabled).toBe(false);
    clean.onSelect();
    expect(cleanupMergedWorktrees).toHaveBeenCalledWith("p-1");
    const remove = item(items, "project-unregister");
    expect(remove.destructive).toBe(true);
    remove.onSelect();
    expect(unregisterProject).toHaveBeenCalledWith("p-1");
    expect(items.filter((x) => x !== "separator" && x.destructive)).toHaveLength(1);
  });

  it("Rename opens the project's name editor; New terminal starts in its main checkout", () => {
    const items = projectMenu("p-1", { kind: "github", step: null, cleanup: null });
    item(items, "project-menu-rename").onSelect();
    expect(useProjectRenameStore.getState().renamingProjectId).toBe("p-1");
    item(items, "project-menu-new-terminal").onSelect();
    expect(newTerminalIn).toHaveBeenCalledWith("p-1", "/u/app");
  });
});

describe("workspaceMenu (an index row's context menu, the workspace page's ⋯)", () => {
  it.each([
    { folder: true, want: ["New thread", "New terminal", "Open in Finder ›", "—", "Rename", "Add project", "—", "Remove workspace"] },
    { folder: false, want: ["New thread", "Open in Finder ›", "—", "Rename", "Add project", "—", "Remove workspace"] },
  ])("folder $folder", ({ folder, want }) => {
    expect(workspaceLabels(workspaceMenu("w-1", { folder }))).toEqual(want);
  });

  it("Open in Finder is the split item for the workspace's folder; its list has Terminal only with a place for one", () => {
    for (const folder of [true, false]) {
      expect(workspaceMenu("w-1", { folder }).find((x) => x !== "separator" && "kind" in x)).toEqual({ kind: "workspace-open-in", testId: "workspace-menu-reveal", workspaceId: "w-1", terminal: folder });
    }
  });

  it("Rename opens the editor, Add project shows the page with its list open, Remove workspace is destructive", () => {
    const items = workspaceMenu("w-1", { folder: false });
    item(items, "workspace-menu-rename").onSelect();
    expect(useWorkspaceRenameStore.getState().renamingWorkspaceId).toBe("w-1");
    item(items, "workspace-menu-add-project").onSelect();
    expect(useWorkspaceAddProjectStore.getState().addingTo).toBe("w-1");
    expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "projects", workspaceId: "w-1" });
    const remove = item(items, "workspace-menu-remove");
    expect(remove.destructive).toBe(true);
    remove.onSelect();
    expect(removeWorkspace).toHaveBeenCalledWith("w-1");
  });
});

describe("checkoutMenu (a checkout's right-click menu on its project page)", () => {
  type Facts = Parameters<typeof checkoutMenu>[0];
  const T1 = { id: "s-1", name: "Refactor sidebar tree", badge: "busy" as const };
  const T2 = { id: "s-2", name: "Spike a canvas sidebar", badge: "idle" as const };
  const base: Facts = { projectId: "p-1", path: "/u/app.wt/feat", branch: "feat/x", isMain: false, threads: [], changed: false, pr: null, actions: false };
  /** Text items by label, parts by kind in brackets, "—" for a separator. */
  const read = (f: Partial<Facts>) =>
    checkoutMenu({ ...base, ...f }).map((it) => (it === "separator" ? "—" : "kind" in it ? `[${it.kind}]` : it.label));

  it.each<[string, Partial<Facts>, string[]]>([
    ["a quiet worktree: no threads, nothing to show, no pull request, no actions", {}, ["New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["one thread: a direct Open item", { threads: [T1] }, ["Open “Refactor sidebar tree”", "New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["two threads: the Open thread submenu", { threads: [T1, T2] }, ["[threads]", "New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["changes: Show changes in its own group", { changed: true }, ["New thread here", "New terminal here", "—", "Show changes", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["a pull request: Open pull request #N", { pr: { slug: "o/r", number: 142 } }, ["New thread here", "New terminal here", "—", "Open pull request #142", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    [
      "busy: everything",
      { threads: [T1, T2], changed: true, pr: { slug: "o/r", number: 142 }, actions: true },
      ["[threads]", "New thread here", "New terminal here", "—", "Show changes", "Open pull request #142", "—", "[open-in]", "Copy path", "Copy branch name", "[actions]", "—", "Remove worktree"],
    ],
    ["main: no Remove worktree", { isMain: true, branch: "main", actions: true }, ["New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "[actions]"]],
    ["detached: no Copy branch name", { branch: "" }, ["New thread here", "New terminal here", "—", "[open-in]", "Copy path", "—", "Remove worktree"]],
  ])("%s", (_name, f, want) => {
    expect(read(f)).toEqual(want);
  });

  it("the parts carry what they draw: the threads, the checkout", () => {
    const items = checkoutMenu({ ...base, threads: [T1, T2], actions: true });
    expect(items.find((x) => x !== "separator" && "kind" in x && x.kind === "threads")).toEqual({ kind: "threads", testId: "checkout-menu-threads", threads: [T1, T2] });
    expect(items.find((x) => x !== "separator" && "kind" in x && x.kind === "open-in")).toEqual({ kind: "open-in", testId: "checkout-menu-open-in", projectId: "p-1", path: "/u/app.wt/feat" });
    expect(items.find((x) => x !== "separator" && "kind" in x && x.kind === "actions")).toEqual({ kind: "actions", testId: "checkout-menu-actions", projectId: "p-1", path: "/u/app.wt/feat" });
  });

  it("each text item runs its store action for this checkout", async () => {
    const items = checkoutMenu({ ...base, threads: [T1], changed: true, pr: { slug: "o/r", number: 142 } });
    const run = (testId: string) => {
      const it = items.find((x) => x !== "separator" && !("kind" in x) && x.testId === testId);
      if (!it || it === "separator" || "kind" in it) throw new Error(`no ${testId}`);
      it.onSelect();
      return it;
    };
    run("checkout-menu-open-thread");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    run("checkout-menu-new-terminal");
    expect(newTerminalIn).toHaveBeenCalledWith("p-1", "/u/app.wt/feat");
    run("checkout-menu-changes");
    expect(openCheckoutDiff).toHaveBeenCalledWith("current", "p-1", "/u/app.wt/feat");
    run("checkout-menu-pr");
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "o/r", number: 142 });
    run("checkout-menu-copy-path");
    run("checkout-menu-copy-branch");
    await Promise.resolve();
    expect(copyText.mock.calls).toEqual([["/u/app.wt/feat"], ["feat/x"]]);
    const remove = run("checkout-menu-remove");
    expect(remove.destructive).toBe(true);
    expect(removeWorktree).toHaveBeenCalledWith("p-1", "/u/app.wt/feat");
    run("checkout-menu-new-thread");
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "p-1" });
    expect(useComposeStore.getState().drafts["p-1"]?.worktree).toEqual({ kind: "existing", path: "/u/app.wt/feat" });
  });
});

describe("leftoverMenu (a worktree without threads' right-click menu on its project page)", () => {
  type Facts = Parameters<typeof leftoverMenu>[0];
  const base: Facts = { projectId: "p-1", path: "/u/app.wt/spike", branch: "cf/perf-spike", work: false, archived: null };
  const ARCHIVED = { id: "s-9", name: "Profile the renderer" };
  /** Text items by label, parts by kind in brackets, "—" for a separator. */
  const read = (f: Partial<Facts>) => leftoverMenu({ ...base, ...f }).map((it) => (it === "separator" ? "—" : "kind" in it ? `[${it.kind}]` : it.label));

  it.each<[string, Partial<Facts>, string[]]>([
    ["clean, no thread was archived on it", {}, ["New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["a thread was archived on it: Resume first, by its name", { archived: ARCHIVED }, ["Resume “Profile the renderer”", "New thread here", "New terminal here", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    ["it holds work: Show changes in its own group", { work: true }, ["New thread here", "New terminal here", "—", "Show changes", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"]],
    [
      "work and an archived thread: everything",
      { work: true, archived: ARCHIVED },
      ["Resume “Profile the renderer”", "New thread here", "New terminal here", "—", "Show changes", "—", "[open-in]", "Copy path", "Copy branch name", "—", "Remove worktree"],
    ],
    ["detached: no Copy branch name", { branch: "" }, ["New thread here", "New terminal here", "—", "[open-in]", "Copy path", "—", "Remove worktree"]],
  ])("%s", (_name, f, want) => {
    expect(read(f)).toEqual(want);
  });

  it("the split Open in item carries the worktree", () => {
    expect(leftoverMenu(base).find((x) => x !== "separator" && "kind" in x)).toEqual({ kind: "open-in", testId: "leftover-menu-open-in", projectId: "p-1", path: "/u/app.wt/spike" });
  });

  it("each text item runs its store action for this worktree", async () => {
    const items = leftoverMenu({ ...base, work: true, archived: ARCHIVED });
    const run = (testId: string) => {
      const it = items.find((x) => x !== "separator" && !("kind" in x) && x.testId === testId);
      if (!it || it === "separator" || "kind" in it) throw new Error(`no ${testId}`);
      it.onSelect();
      return it;
    };
    run("leftover-menu-resume");
    expect(resumeWorktree).toHaveBeenCalledWith("p-1", "/u/app.wt/spike", "s-9");
    run("leftover-menu-new-terminal");
    expect(newTerminalIn).toHaveBeenCalledWith("p-1", "/u/app.wt/spike");
    run("leftover-menu-changes");
    expect(openCheckoutDiff).toHaveBeenCalledWith("current", "p-1", "/u/app.wt/spike");
    run("leftover-menu-copy-path");
    run("leftover-menu-copy-branch");
    await Promise.resolve();
    expect(copyText.mock.calls).toEqual([["/u/app.wt/spike"], ["cf/perf-spike"]]);
    const remove = run("leftover-menu-remove");
    expect(remove.destructive).toBe(true);
    expect(removeWorktree).toHaveBeenCalledWith("p-1", "/u/app.wt/spike");
    run("leftover-menu-new-thread");
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "p-1" });
    expect(useComposeStore.getState().drafts["p-1"]?.worktree).toEqual({ kind: "existing", path: "/u/app.wt/spike" });
  });
});

it("no item ends in an ellipsis (the app's menu style)", () => {
  const all = [
    ...leftoverMenu({ projectId: "p-1", path: "/u/app.wt/x", branch: "x", work: true, archived: { id: "s-1", name: "x" } }).flatMap((x) => (x === "separator" || !("kind" in x) ? [x] : [])),
    ...checkoutMenu({ projectId: "p-1", path: "/u/app", branch: "main", isMain: false, threads: [{ id: "s-1", name: "x", badge: "idle" }], changed: true, pr: { slug: "o/r", number: 1 }, actions: true }).flatMap((x) => (x === "separator" || !("kind" in x) ? [x] : [])),
    ...projectMenu("p-1", { kind: "git", step: "publish", cleanup: 1 }, { page: true }),
    ...projectMenu("p-1", { kind: "nogit", step: "init", cleanup: null }),
    ...workspaceMenu("w-1", { folder: true }).flatMap((x) => (x === "separator" || !("kind" in x) ? [x] : [])),
  ];
  for (const it of all) if (it !== "separator") expect(it.label).not.toMatch(/(…|\.\.\.)$/);
});
