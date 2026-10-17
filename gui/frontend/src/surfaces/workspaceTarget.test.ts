import { describe, expect, it } from "vitest";
import type { ProjectView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import {
  memberOfTab,
  memberTab,
  selectionWorkspaceThread,
  workspaceOfTab,
  workspaceTab,
  workspaceThread,
} from "./workspaceTarget";

const WEB = "/wt/web/cf-demo";
const API = "/wt/api/cf-demo";

function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  return { id, projectId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", archivedAtMs: null, createdAtMs: 1, lastActivityAtMs: null, ...o } as ThreadView;
}

const repos: ProjectsData = {
  byId: {
    web: { id: "web", name: "web", worktrees: [{ path: WEB }] } as unknown as ProjectView,
    api: { id: "api", name: "api", worktrees: [{ path: API }] } as unknown as ProjectView,
  },
  order: ["api", "web"],
};

function threads(...list: ThreadView[]): ThreadsData {
  return { byId: Object.fromEntries(list.map((s) => [s.id, s])), order: list.map((s) => s.id) };
}

describe("selectionWorkspaceThread (the surface's availability)", () => {
  const s = { repos, threads: threads(thread("s-ws", { workspaceId: "w1" }), thread("s-proj")) };
  it.each<[string, Selection, { threadId: string; workspaceId: string } | null]>([
    ["a workspace thread", { kind: "thread", id: "s-ws" }, { threadId: "s-ws", workspaceId: "w1" }],
    ["a project thread", { kind: "thread", id: "s-proj" }, null],
    ["an unknown thread", { kind: "thread", id: "s-404" }, null],
    ["a workspace composer (no thread yet)", { kind: "compose", projectId: "web", workspaceId: "w1" }, null],
    ["the Projects page", { kind: "view", name: "projects" }, null],
    ["nothing", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionWorkspaceThread(sel, s)).toEqual(want);
  });
});

describe("tabs", () => {
  it("a workspace tab is keyed by the workspace and titled with its name", () => {
    const t = workspaceTab("w1", "demo");
    expect(t).toMatchObject({ id: "workspace?workspace=w1", kind: "workspace", title: "demo" });
    expect(workspaceOfTab(t)).toBe("w1");
    expect(workspaceTab("w1", "").title).toBe("Workspace");
    expect(workspaceOfTab({ params: {} })).toBeNull();
  });

  it("a member tab is keyed by repo and path, so each member is its own tab", () => {
    const t = memberTab("api", API, "api");
    expect(t.kind).toBe("worktree");
    expect(t.id).toBe(`worktree?path=${encodeURIComponent(API)}&repo=api`);
    expect(memberOfTab(t)).toEqual({ projectId: "api", path: API });
    expect(memberTab("web", WEB, "web").id).not.toBe(t.id);
    expect(memberOfTab({ params: { repo: "api" } })).toBeNull();
  });
});

describe("workspaceThread (the Projects page's workspace rows)", () => {
  it.each<[string, ThreadView[], string | null]>([
    ["no thread", [], null],
    ["only project threads", [thread("p1")], null],
    ["a stopped workspace thread counts", [thread("d1", { workspaceId: "w1", state: "disconnected" })], "d1"],
    ["only archived workspace threads", [thread("a1", { workspaceId: "w1", archivedAtMs: 5 })], null],
    ["another workspace's thread", [thread("o1", { workspaceId: "w2" })], null],
    ["a stopped one active more recently wins", [thread("d1", { workspaceId: "w1", state: "disconnected", lastActivityAtMs: 99 }), thread("l1", { workspaceId: "w1" })], "d1"],
    ["an archived one never wins", [thread("a1", { workspaceId: "w1", archivedAtMs: 5, lastActivityAtMs: 99 }), thread("l1", { workspaceId: "w1" })], "l1"],
    [
      "the most recently active of several",
      [thread("a", { workspaceId: "w1", lastActivityAtMs: 10 }), thread("b", { workspaceId: "w1", lastActivityAtMs: 30 }), thread("c", { workspaceId: "w1", lastActivityAtMs: 20 })],
      "b",
    ],
    ["the newest when none has activity", [thread("a", { workspaceId: "w1", createdAtMs: 5 }), thread("b", { workspaceId: "w1", createdAtMs: 7 })], "b"],
  ])("%s", (_name, list, want) => {
    expect(workspaceThread(threads(...list), "w1")).toBe(want);
  });
});
