import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@/api/workspace";
import { applyWorkspaceEvent, emptyWorkspaces, replaceWorkspaces } from "./workspaces";

function ws(id: string, name: string, repos: string[] = ["web"]): WorkspaceView {
  return { id, name, branch: `cf/${name}`, members: repos.map((r) => ({ repoId: r, worktreePath: `/wt/${r}/cf-${name}` })), createdAtMs: null };
}

describe("workspaces slice", () => {
  it("a snapshot replaces everything, ordered by name then id", () => {
    const prev = replaceWorkspaces([ws("w-9", "old")]);
    const next = applyWorkspaceEvent(prev, { kind: "snapshot", workspaces: [ws("w-2", "login"), ws("w-1", "billing"), ws("w-3", "login")] });
    expect(next.order).toEqual(["w-1", "w-2", "w-3"]);
    expect(Object.keys(next.byId).sort()).toEqual(["w-1", "w-2", "w-3"]);
  });

  it.each<[string, WorkspaceView[], Parameters<typeof applyWorkspaceEvent>[1], string[]]>([
    ["an update adds a workspace in name order", [ws("w-1", "billing")], { kind: "updated", workspace: ws("w-2", "auth") }, ["w-2", "w-1"]],
    ["an update replaces one and re-sorts on rename", [ws("w-1", "billing"), ws("w-2", "login")], { kind: "updated", workspace: ws("w-1", "zeta") }, ["w-2", "w-1"]],
    ["a removal drops it", [ws("w-1", "billing"), ws("w-2", "login")], { kind: "removed", id: "w-1" }, ["w-2"]],
  ])("%s", (_name, start, ev, order) => {
    expect(applyWorkspaceEvent(replaceWorkspaces(start), ev).order).toEqual(order);
  });

  it("an update carries the members; removing an unknown id is a no-op", () => {
    const prev = replaceWorkspaces([ws("w-1", "login")]);
    const next = applyWorkspaceEvent(prev, { kind: "updated", workspace: ws("w-1", "login", ["web", "api"]) });
    expect(next.byId["w-1"]?.members.map((m) => m.repoId)).toEqual(["web", "api"]);
    expect(applyWorkspaceEvent(next, { kind: "removed", id: "w-404" })).toBe(next);
    expect(applyWorkspaceEvent(emptyWorkspaces, { kind: "removed", id: "w-1" })).toBe(emptyWorkspaces);
  });
});
