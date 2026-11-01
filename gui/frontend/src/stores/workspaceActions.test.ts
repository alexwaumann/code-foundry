import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@/api/workspace";
import type { ProjectsData } from "./projects";
import { workspaceTerminalPlace } from "./workspaceActions";

const projects = {
  byId: { api: { id: "api", path: "/u/api", worktrees: [{ path: "/u/api", isMain: true }] }, web: { id: "web", path: "/u/web", worktrees: [{ path: "/u/web-main", isMain: true }] } },
  order: ["api", "web"],
} as unknown as ProjectsData;

function ws(over: Partial<WorkspaceView>): WorkspaceView {
  return { id: "w-1", name: "login", members: [], rootPath: "", defaultPrimary: "", managedDir: "", instructions: "", skills: [], ...over } as unknown as WorkspaceView;
}

describe("workspaceTerminalPlace (a workspace's New terminal)", () => {
  it.each([
    { name: "its own folder, owned by the first registered member's main checkout", w: ws({ managedDir: "/cf/ws/login", members: [{ projectId: "gone" }, { projectId: "web" }] as never }), want: { projectId: "web", path: "/u/web-main", cwd: "/cf/ws/login" } },
    { name: "a root wins over the managed folder", w: ws({ rootPath: "/u/mono", managedDir: "/cf/ws/login", members: [{ projectId: "api" }] as never }), want: { projectId: "api", path: "/u/api", cwd: "/u/mono" } },
    { name: "no folder: none", w: ws({ members: [{ projectId: "api" }] as never }), want: null },
    { name: "no registered member to own the shell: none", w: ws({ managedDir: "/cf/ws/login", members: [{ projectId: "gone" }] as never }), want: null },
    { name: "an unknown workspace: none", w: undefined, want: null },
  ])("$name", ({ w, want }) => {
    expect(workspaceTerminalPlace(w, projects)).toEqual(want);
  });
});
