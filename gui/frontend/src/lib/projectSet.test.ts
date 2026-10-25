import { describe, expect, it } from "vitest";
import { canSaveAsWorkspace, matchingWorkspace, primaryOptions, resolveSet, setName, toggled, WORKSPACE_PRIMARY, type SetChoice, type SetDefaults, type SetWorkspace } from "./projectSet";

const known = new Set(["api", "web", "lib", "notes"]);
const workspaces: Record<string, SetWorkspace> = {
  "w-shop": { members: ["web", "api"], defaultPrimary: "api" },
  "w-root": { members: ["web", "lib"], defaultPrimary: WORKSPACE_PRIMARY },
  "w-odd": { members: ["web"], defaultPrimary: "gone" },
  "w-empty": { members: [] },
};
const env = { known: (id: string) => known.has(id), workspace: (id: string) => workspaces[id] };
const none: SetChoice = { projects: null, workspace: null, primary: null };
const project: SetDefaults = { projects: ["web"], workspace: "" };
const shop: SetDefaults = { projects: ["web", "api"], workspace: "w-shop" };

describe("resolveSet", () => {
  it.each<[string, SetChoice, SetDefaults, ReturnType<typeof resolveSet>]>([
    ["a project target alone", none, project, { projectIds: ["web"], picked: ["web"], workspaceId: "", primary: "web", isSet: false }],
    [
      "picked projects: sorted, the first picked the default primary",
      { ...none, projects: ["web", "lib", "api"] },
      project,
      { projectIds: ["api", "lib", "web"], picked: ["web", "lib", "api"], workspaceId: "", primary: "web", isSet: true },
    ],
    ["unknown and duplicate projects drop out", { ...none, projects: ["gone", "lib", "lib", "web"] }, project, { projectIds: ["lib", "web"], picked: ["lib", "web"], workspaceId: "", primary: "lib", isSet: true }],
    ["a picked primary in the set", { ...none, projects: ["web", "api"], primary: "api" }, project, { projectIds: ["api", "web"], picked: ["web", "api"], workspaceId: "", primary: "api", isSet: true }],
    ["a picked primary no longer in the set: the default", { ...none, projects: ["web"], primary: "api" }, project, { projectIds: ["web"], picked: ["web"], workspaceId: "", primary: "web", isSet: false }],
    ["the workspace's folder without a workspace: the default", { ...none, primary: WORKSPACE_PRIMARY }, project, { projectIds: ["web"], picked: ["web"], workspaceId: "", primary: "web", isSet: false }],
    ["a workspace target: its members and its default primary", none, shop, { projectIds: ["api", "web"], picked: ["web", "api"], workspaceId: "w-shop", primary: "api", isSet: true }],
    ["a rooted workspace: its folder by default", { ...none, projects: ["web", "lib"], workspace: "w-root" }, project, { projectIds: ["lib", "web"], picked: ["web", "lib"], workspaceId: "w-root", primary: WORKSPACE_PRIMARY, isSet: true }],
    ["a default primary outside the set: the first picked", { ...none, projects: ["web"], workspace: "w-odd" }, project, { projectIds: ["web"], picked: ["web"], workspaceId: "w-odd", primary: "web", isSet: true }],
    ["the folder picked with a workspace", { projects: ["web", "api"], workspace: "w-shop", primary: WORKSPACE_PRIMARY }, project, { projectIds: ["api", "web"], picked: ["web", "api"], workspaceId: "w-shop", primary: WORKSPACE_PRIMARY, isSet: true }],
    ["a workspace without projects runs in its folder", { ...none, projects: [], workspace: "w-empty" }, project, { projectIds: [], picked: [], workspaceId: "w-empty", primary: WORKSPACE_PRIMARY, isSet: true }],
    ["the reference dropped: a plain set", { ...none, projects: ["web", "api"], workspace: "" }, shop, { projectIds: ["api", "web"], picked: ["web", "api"], workspaceId: "", primary: "web", isSet: true }],
    ["nothing at all", none, { projects: [], workspace: "" }, { projectIds: [], picked: [], workspaceId: "", primary: "", isSet: false }],
  ])("%s", (_name, d, defaults, want) => {
    expect(resolveSet(d, defaults, env)).toEqual(want);
  });
});

describe("helpers", () => {
  it("toggled adds at the end of the pick order, or removes", () => {
    expect(toggled(["web"], "api")).toEqual(["web", "api"]);
    expect(toggled(["web", "api"], "web")).toEqual(["api"]);
  });

  it.each<[string, { projectIds: string[]; workspaceId: string }, string]>([
    ["a workspace: its name", { projectIds: ["api", "web"], workspaceId: "w-shop" }, "shop"],
    ["one project: its name", { projectIds: ["web"], workspaceId: "" }, "Web"],
    ["several: a count", { projectIds: ["api", "lib", "web"], workspaceId: "" }, "3 projects"],
  ])("setName: %s", (_name, s, want) => {
    expect(setName(s, s.workspaceId ? "shop" : "", (id) => id.charAt(0).toUpperCase() + id.slice(1))).toBe(want);
  });

  it("primaryOptions: Workspace first with a workspace, then the projects by id", () => {
    expect(primaryOptions({ projectIds: ["api", "web"], workspaceId: "w-shop" }, "shop", (id) => id)).toEqual([
      { value: WORKSPACE_PRIMARY, label: "Workspace", detail: "shop's own folder" },
      { value: "api", label: "api" },
      { value: "web", label: "web" },
    ]);
    expect(primaryOptions({ projectIds: ["api"], workspaceId: "" }, "", (id) => id)).toEqual([{ value: "api", label: "api" }]);
  });

  it.each<[string, string[], boolean]>([
    ["one project: nothing to save", ["web"], false],
    ["a saved set, in any order", ["api", "web"], false],
    ["an unsaved set", ["api", "lib"], true],
    ["a superset of a saved one", ["api", "lib", "web"], true],
  ])("canSaveAsWorkspace: %s", (_name, ids, want) => {
    const saved = [
      { id: "w-shop", members: ["web", "api"] },
      { id: "w-root", members: ["web", "lib"] },
    ];
    expect(canSaveAsWorkspace(ids, saved)).toBe(want);
    expect(matchingWorkspace(["web", "api"], saved)?.id).toBe("w-shop");
  });
});
