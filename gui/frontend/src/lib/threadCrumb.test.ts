import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { threadCrumb, type CrumbThread, type ThreadCrumb } from "./threadCrumb";

const project = (name: string) => ({ name, git: true, worktrees: [{ path: `/src/${name}`, branch: "main", head: "a", isMain: true }] });
const projects = { byId: { web: project("web"), api: project("api"), lib: project("lib") } };
const workspaces = { byId: { "w-1": { name: "platform" } } };
const threads = { byId: { "s-p": { name: "Auth rollout plan" }, "s-f": { name: "" } } as Record<string, Pick<ThreadView, "name"> | undefined> };

const t = (o: Partial<CrumbThread>): CrumbThread => ({
  projectId: "web",
  workspaceId: "",
  worktreePath: "/src/web",
  pendingWorktreePath: "",
  projectIds: ["web"],
  createdBy: "",
  createdByName: "",
  parentId: "",
  ...o,
});

describe("threadCrumb", () => {
  it.each<[string, Partial<CrumbThread>, ThreadCrumb]>([
    ["one project: folder and its name", {}, { icon: "folder", label: "web", parent: null }],
    ["a named workspace: layers and its name", { projectId: "api", worktreePath: "/src/api", projectIds: ["web", "api", "lib"], workspaceId: "w-1" }, { icon: "layers", label: "platform", parent: null }],
    [
      "a workspace's folder (no primary project): its name",
      { projectId: "", worktreePath: "/ws/platform", projectIds: ["web", "api"], workspaceId: "w-1" },
      { icon: "layers", label: "platform", parent: null },
    ],
    ["an unnamed set: folders, the cwd's project and +N", { projectId: "api", worktreePath: "/src/api", projectIds: ["web", "api", "lib"] }, { icon: "folders", label: "api +2", parent: null }],
    [
      "a removed workspace with several projects reads as an unnamed set",
      { projectId: "web", projectIds: ["web", "api"], workspaceId: "w-gone" },
      { icon: "folders", label: "web +1", parent: null },
    ],
    [
      "an agent's thread: the place, then its creator by current name",
      { createdBy: "s-p", createdByName: "Old name" },
      { icon: "folder", label: "web", parent: { id: "s-p", name: "Auth rollout plan", exists: true } },
    ],
    [
      "a removed creator: its name at creation, not a link",
      { createdBy: "s-gone", createdByName: "Old name" },
      { icon: "folder", label: "web", parent: { id: "s-gone", name: "Old name", exists: false } },
    ],
    ["a fork: the thread it was forked from (its id while unnamed)", { parentId: "s-f" }, { icon: "folder", label: "web", parent: { id: "s-f", name: "s-f", exists: true } }],
    ["a fork whose parent was removed: no parent segment", { parentId: "s-gone" }, { icon: "folder", label: "web", parent: null }],
    ["no project: home and No project", { projectId: "", worktreePath: "/Users/me", projectIds: [] }, { icon: "house", label: "No project", parent: null }],
    [
      "no project, created by an agent: still its creator",
      { projectId: "", worktreePath: "/Users/me", projectIds: [], createdBy: "s-p" },
      { icon: "house", label: "No project", parent: { id: "s-p", name: "Auth rollout plan", exists: true } },
    ],
  ])("%s", (_name, o, want) => {
    expect(threadCrumb(t(o), projects, workspaces, threads)).toEqual(want);
  });
});
