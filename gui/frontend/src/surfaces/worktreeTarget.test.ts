import { describe, expect, it } from "vitest";
import type { ProjectView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import type { WorkspaceView } from "@/api/workspace";
import { folderOfTab, folderTab, selectionFolder, selectionWorktree, worktreeOfTab, worktreeTab } from "./worktreeTarget";

const WEB = "/wt/web/cf-demo";
const API = "/wt/api/cf-demo";

function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  return { id, projectId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", archivedAtMs: null, createdAtMs: 1, lastActivityAtMs: null, ...o } as ThreadView;
}

const projects: ProjectsData = {
  byId: {
    web: { id: "web", name: "web", worktrees: [{ path: WEB }] } as unknown as ProjectView,
    api: { id: "api", name: "api", worktrees: [{ path: API }] } as unknown as ProjectView,
  },
  order: ["api", "web"],
};

function threads(...list: ThreadView[]): ThreadsData {
  return { byId: Object.fromEntries(list.map((s) => [s.id, s])), order: list.map((s) => s.id) };
}

describe("selectionWorktree (the surface's availability)", () => {
  const s = { projects, threads: threads(thread("s-web"), thread("s-home", { projectId: "", worktreePath: "/Users/me" })) };
  it.each<[string, Selection, { projectId: string; path: string } | null]>([
    ["a thread in a worktree", { kind: "thread", id: "s-web" }, { projectId: "web", path: WEB }],
    ["a thread in no worktree", { kind: "thread", id: "s-home" }, null],
    ["an unknown thread", { kind: "thread", id: "s-404" }, null],
    ["the Projects page", { kind: "view", name: "projects" }, null],
    ["nothing", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionWorktree(sel, s)).toEqual(want);
  });
});

describe("worktree tabs", () => {
  it("are keyed by project and path, so each checkout is its own tab", () => {
    const t = worktreeTab("api", API, "api");
    expect(t.kind).toBe("worktree");
    expect(t.id).toBe(`worktree?path=${encodeURIComponent(API)}&project=api`);
    expect(worktreeOfTab(t)).toEqual({ projectId: "api", path: API });
    expect(worktreeTab("web", WEB, "web").id).not.toBe(t.id);
    expect(worktreeOfTab({ params: { project: "api" } })).toBeNull();
  });
});

describe("selectionFolder and folder tabs (a thread whose primary is its workspace's folder)", () => {
  const ROOT = "/Users/me/mono";
  const workspaces = { byId: { "w-1": { id: "w-1", rootPath: ROOT, managedDir: "/cfg/workspaces/w-1" } as unknown as WorkspaceView, "w-2": { id: "w-2", rootPath: "", managedDir: "/tmp/cfg/workspaces/w-2" } as unknown as WorkspaceView } };
  const s = {
    threads: threads(
      thread("s-root", { projectId: "", workspaceId: "w-1", worktreePath: ROOT }),
      thread("s-managed", { projectId: "", workspaceId: "w-2", worktreePath: "/private/tmp/cfg/workspaces/w-2" }),
      thread("s-member", { workspaceId: "w-1" }),
      thread("s-elsewhere", { projectId: "", workspaceId: "w-1", worktreePath: "/Users/me" }),
      thread("s-removed", { projectId: "", workspaceId: "w-gone", worktreePath: ROOT }),
    ),
    workspaces,
  };
  it.each<[string, string, { workspaceId: string; path: string } | null]>([
    ["in a rooted workspace's root", "s-root", { workspaceId: "w-1", path: ROOT }],
    ["in a synthetic workspace's managed dir (/private/tmp is /tmp)", "s-managed", { workspaceId: "w-2", path: "/private/tmp/cfg/workspaces/w-2" }],
    ["in a member's worktree: the worktree tab instead", "s-member", null],
    ["elsewhere", "s-elsewhere", null],
    ["its workspace was removed", "s-removed", null],
  ])("%s", (_name, id, want) => {
    expect(selectionFolder({ kind: "thread", id }, s)).toEqual(want);
  });
  it("not for a page", () => {
    expect(selectionFolder({ kind: "view", name: "projects" }, s)).toBeNull();
  });
  it("a folder tab names the workspace and path, apart from any worktree tab", () => {
    const t = folderTab("w-1", ROOT, "mono");
    expect(t.kind).toBe("worktree");
    expect(folderOfTab(t)).toEqual({ workspaceId: "w-1", path: ROOT });
    expect(worktreeOfTab(t)).toBeNull();
    expect(folderOfTab(worktreeTab("web", WEB, "web"))).toBeNull();
  });
});
