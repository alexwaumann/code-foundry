import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { finishAddProject, openAddProject, selectAddedProject, showAddedWorkspace, useAddProjectStore } from "./addProject";
import { useProjectsStore } from "./projects";
import { showProjectOnProjectsPage, showWorkspacePage } from "./projectsPage";

vi.mock("./projectsPage", () => ({ showWorkspacePage: vi.fn(), showProjectOnProjectsPage: vi.fn(() => true) }));

const project = (id: string): ProjectView => ({ id, path: `/Users/dev/src/${id}`, name: id, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [] });

/** What a dialog tab does once its project is added (LocalFolderTab, GitHubTab, NewTab). */
const added = (id: string) => {
  finishAddProject();
  selectAddedProject(id);
};

describe("what the Add Project dialog shows once a project is added", () => {
  beforeEach(() => {
    useAddProjectStore.setState({ open: false, tab: "local", seq: 0, created: null, busy: false, stay: false });
    useProjectsStore.setState({ byId: {}, order: [] });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("opened in the app, it shows the project on the Projects page", async () => {
    openAddProject();
    await Promise.resolve();
    expect(useAddProjectStore.getState().stay).toBe(false);
    useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"] });
    added("web");
    expect(showProjectOnProjectsPage).toHaveBeenCalledWith("web");
  });

  it("opened in the app, it waits for the project event before showing it", async () => {
    openAddProject();
    await Promise.resolve();
    added("web");
    expect(showProjectOnProjectsPage).not.toHaveBeenCalled();
    useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"] });
    expect(showProjectOnProjectsPage).toHaveBeenCalledWith("web");
  });

  it("opened to stay (project.add's intent), the window stays where it is", async () => {
    openAddProject("local", { stay: true });
    await Promise.resolve();
    expect(useAddProjectStore.getState()).toMatchObject({ open: true, stay: true });
    useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"] });
    added("web");
    expect(useAddProjectStore.getState().open).toBe(false);
    // A project that arrives after the answer is not shown either.
    added("api");
    useProjectsStore.setState({ byId: { web: project("web"), api: project("api") }, order: ["web", "api"] });
    expect(showProjectOnProjectsPage).not.toHaveBeenCalled();
  });

  it("a workspace is shown on the Projects page unless the dialog was opened to stay", async () => {
    openAddProject();
    await Promise.resolve();
    finishAddProject();
    showAddedWorkspace("w-1");
    expect(showWorkspacePage).toHaveBeenCalledWith("w-1");
    vi.mocked(showWorkspacePage).mockClear();
    openAddProject("local", { stay: true });
    await Promise.resolve();
    finishAddProject();
    showAddedWorkspace("w-2");
    expect(showWorkspacePage).not.toHaveBeenCalled();
  });

  it("the next open from the app shows what it adds again", async () => {
    openAddProject("local", { stay: true });
    await Promise.resolve();
    openAddProject("github");
    await Promise.resolve();
    expect(useAddProjectStore.getState()).toMatchObject({ tab: "github", stay: false });
  });
});
