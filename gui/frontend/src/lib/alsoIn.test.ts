import { describe, expect, it } from "vitest";
import type { ThreadCheckoutView, ThreadCheckoutsView } from "@/api/checkouts";
import { alsoInRows, checkoutsKey, memberWorktrees, threadOfCheckoutsKey } from "./alsoIn";

const co = (projectId: string, path: string, o: Partial<ThreadCheckoutView> = {}): ThreadCheckoutView => ({
  projectId,
  projectName: projectId,
  path,
  branch: "feat/x",
  primary: false,
  missing: false,
  git: true,
  derived: true,
  ...o,
});
const view = (...checkouts: ThreadCheckoutView[]): ThreadCheckoutsView => ({ checkouts, workspaceId: "", workspaceName: "" });

describe("alsoInRows", () => {
  const v = view(co("api", "/wt/api/feat-x"), co("notes", "/src/notes", { git: false, branch: "" }), co("web", "/wt/web/feat-x", { primary: true }));
  it("the other checkouts, in the response's order (by project id)", () => {
    expect(alsoInRows(v, "/wt/web/feat-x")).toEqual([
      { projectId: "api", path: "/wt/api/feat-x", name: "api", branch: "feat/x", missing: false, git: true },
      { projectId: "notes", path: "/src/notes", name: "notes", branch: "", missing: false, git: false },
    ]);
  });
  it("from a member's tab: the primary is listed too", () => {
    expect(alsoInRows(v, "/wt/api/feat-x").map((r) => r.projectId)).toEqual(["notes", "web"]);
  });
  it.each<[string, ThreadCheckoutsView | null, string]>([
    ["no data yet", null, "/wt/web/feat-x"],
    ["one checkout", view(co("web", "/wt/web/feat-x")), "/wt/web/feat-x"],
    ["a tab the thread does not work in", v, "/elsewhere"],
  ])("empty: %s", (_n, data, path) => {
    expect(alsoInRows(data, path)).toEqual([]);
  });
  it("a missing worktree is listed, marked; an unregistered project (no path) is not; the name falls back to the id", () => {
    const rows = alsoInRows(view(co("web", "/wt/web"), co("api", "/wt/api", { missing: true, projectName: "" }), co("gone", "", { projectName: "" })), "/wt/web");
    expect(rows).toEqual([{ projectId: "api", path: "/wt/api", name: "api", branch: "feat/x", missing: true, git: true }]);
  });
});

describe("checkoutsKey", () => {
  const t = { id: "t-1", worktreePath: "/wt/web", branch: "feat/x", projectIds: ["api", "web"] };
  it("none for a thread with one project or none", () => {
    expect(checkoutsKey(undefined, [])).toBeNull();
    expect(checkoutsKey({ ...t, projectIds: ["web"] }, [])).toBeNull();
  });
  it("changes with the cwd, the branch, the set and the members' worktrees, and names the thread", () => {
    const k = checkoutsKey(t, ["/src/api", "/src/web"]);
    expect(k).not.toBeNull();
    expect(threadOfCheckoutsKey(k ?? "")).toBe("t-1");
    for (const other of [
      checkoutsKey({ ...t, worktreePath: "/src/web" }, ["/src/api", "/src/web"]),
      checkoutsKey({ ...t, branch: "feat/y" }, ["/src/api", "/src/web"]),
      checkoutsKey({ ...t, projectIds: ["api", "notes", "web"] }, ["/src/api", "/src/web"]),
      checkoutsKey(t, ["/src/api", "/src/web", "/wt/api/feat-x"]),
    ])
      expect(other).not.toBe(k);
    expect(checkoutsKey({ ...t }, ["/src/api", "/src/web"])).toBe(k);
  });
  it("memberWorktrees: every member's worktree paths, sorted", () => {
    const projects = { byId: { web: { worktrees: [{ path: "/src/web" }, { path: "/wt/web/a" }] }, api: { worktrees: [{ path: "/src/api" }] }, other: { worktrees: [{ path: "/src/other" }] } } };
    expect(memberWorktrees(projects, ["web", "api", "gone"])).toEqual(["/src/api", "/src/web", "/wt/web/a"]);
    expect(memberWorktrees(projects, undefined)).toEqual([]);
  });
});
