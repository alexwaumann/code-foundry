import { describe, expect, it } from "vitest";
import type { RepoView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import type { ReposData } from "@/stores/repos";
import type { SessionsData } from "@/stores/sessions";
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

function session(id: string, o: Partial<SessionView> = {}): SessionView {
  return { id, repoId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", archivedAtMs: null, createdAtMs: 1, lastActivityAtMs: null, ...o } as SessionView;
}

const repos: ReposData = {
  byId: {
    web: { id: "web", name: "web", worktrees: [{ path: WEB }] } as unknown as RepoView,
    api: { id: "api", name: "api", worktrees: [{ path: API }] } as unknown as RepoView,
  },
  order: ["api", "web"],
};

function sessions(...list: SessionView[]): SessionsData {
  return { byId: Object.fromEntries(list.map((s) => [s.id, s])), order: list.map((s) => s.id) };
}

describe("selectionWorkspaceThread (the surface's availability)", () => {
  const s = { repos, sessions: sessions(session("s-ws", { workspaceId: "w1" }), session("s-proj")) };
  it.each<[string, Selection, { sessionId: string; workspaceId: string } | null]>([
    ["a workspace thread", { kind: "session", id: "s-ws" }, { sessionId: "s-ws", workspaceId: "w1" }],
    ["a project thread", { kind: "session", id: "s-proj" }, null],
    ["an unknown thread", { kind: "session", id: "s-404" }, null],
    ["a workspace composer (no thread yet)", { kind: "compose", repoId: "web", workspaceId: "w1" }, null],
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
    expect(memberOfTab(t)).toEqual({ repoId: "api", path: API });
    expect(memberTab("web", WEB, "web").id).not.toBe(t.id);
    expect(memberOfTab({ params: { repo: "api" } })).toBeNull();
  });
});

describe("workspaceThread (the Projects page's workspace rows)", () => {
  it.each<[string, SessionView[], string | null]>([
    ["no thread", [], null],
    ["only project threads", [session("p1")], null],
    ["a stopped workspace thread counts", [session("d1", { workspaceId: "w1", state: "disconnected" })], "d1"],
    ["only archived workspace threads", [session("a1", { workspaceId: "w1", archivedAtMs: 5 })], null],
    ["another workspace's thread", [session("o1", { workspaceId: "w2" })], null],
    ["a stopped one active more recently wins", [session("d1", { workspaceId: "w1", state: "disconnected", lastActivityAtMs: 99 }), session("l1", { workspaceId: "w1" })], "d1"],
    ["an archived one never wins", [session("a1", { workspaceId: "w1", archivedAtMs: 5, lastActivityAtMs: 99 }), session("l1", { workspaceId: "w1" })], "l1"],
    [
      "the most recently active of several",
      [session("a", { workspaceId: "w1", lastActivityAtMs: 10 }), session("b", { workspaceId: "w1", lastActivityAtMs: 30 }), session("c", { workspaceId: "w1", lastActivityAtMs: 20 })],
      "b",
    ],
    ["the newest when none has activity", [session("a", { workspaceId: "w1", createdAtMs: 5 }), session("b", { workspaceId: "w1", createdAtMs: 7 })], "b"],
  ])("%s", (_name, list, want) => {
    expect(workspaceThread(sessions(...list), "w1")).toBe(want);
  });
});
