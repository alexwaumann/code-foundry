import { beforeEach, describe, expect, it, vi } from "vitest";

const unregisterProject = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const cleanupMergedWorktrees = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const newTerminalIn = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/projectActions", async (orig) => ({ ...(await orig<typeof import("@/stores/projectActions")>()), unregisterProject, cleanupMergedWorktrees, newTerminalIn }));
const removeWorkspace = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/workspaceActions", async (orig) => ({ ...(await orig<typeof import("@/stores/workspaceActions")>()), removeWorkspace }));

const { projectMenu, workspaceMenu } = await import("./menus");
const { useProjectsStore } = await import("@/stores/projects");
const { useProjectRenameStore } = await import("@/stores/projectRename");
const { useWorkspaceRenameStore } = await import("@/stores/workspaceRename");
const { useWorkspaceAddProjectStore } = await import("@/stores/workspaceAddProject");
const { useUiStore } = await import("@/stores/ui");
type Items = ReturnType<typeof projectMenu>;

/** The menu as the user reads it: labels (a count after its item), "—" for a separator. */
function labels(items: Items): string[] {
  return items.map((it) => (it === "separator" ? "—" : it.badge === undefined ? it.label : `${it.label} ${String(it.badge)}`));
}

function item(items: Items, testId: string) {
  const it = items.find((x) => x !== "separator" && x.testId === testId);
  if (!it || it === "separator") throw new Error(`no ${testId}`);
  return it;
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

  it("the page's ⋯ puts New action first, then the row's items", () => {
    const items = projectMenu("p-1", { kind: "github", step: null, cleanup: 0 }, { newAction: true });
    expect(labels(items)).toEqual(["New action", "—", "New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]);
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
    { folder: true, want: ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"] },
    { folder: false, want: ["New thread", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"] },
  ])("folder $folder", ({ folder, want }) => {
    expect(labels(workspaceMenu("w-1", { folder }))).toEqual(want);
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

it("no item ends in an ellipsis (the app's menu style)", () => {
  const all = [
    ...projectMenu("p-1", { kind: "git", step: "publish", cleanup: 1 }, { newAction: true }),
    ...projectMenu("p-1", { kind: "nogit", step: "init", cleanup: null }),
    ...workspaceMenu("w-1", { folder: true }),
  ];
  for (const it of all) if (it !== "separator") expect(it.label).not.toMatch(/(…|\.\.\.)$/);
});
