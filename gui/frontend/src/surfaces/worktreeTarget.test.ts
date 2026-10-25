import { describe, expect, it } from "vitest";
import type { ProjectView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { selectionWorktree, worktreeOfTab, worktreeTab } from "./worktreeTarget";

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
