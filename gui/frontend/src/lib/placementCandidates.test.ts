import { describe, expect, it } from "vitest";
import { branchFolder, placementCandidates, type CandidateProject } from "./placementCandidates";

const W = "/h/.code-foundry/worktrees/acme/web";

function web(...worktrees: CandidateProject["worktrees"]): CandidateProject {
  return { id: "web", git: true, worktrees };
}

describe("placementCandidates", () => {
  const main = { path: "/h/src/web", branch: "main", detached: false, isMain: true };
  const cases: { name: string; projects: CandidateProject[]; branches: string[]; want: string[] }[] = [
    { name: "nothing on the branch", projects: [web(main)], branches: ["feat/x"], want: [] },
    { name: "the main checkout on it", projects: [web({ ...main, branch: "feat/x" })], branches: ["feat/x", "feat/y"], want: ["feat/x"] },
    { name: "its default worktree moved", projects: [web(main, { path: `${W}/feat-x`, branch: "other", detached: false, isMain: false })], branches: ["feat/x"], want: ["feat/x"] },
    { name: "its default worktree detached", projects: [web(main, { path: `${W}/feat-x`, branch: "", detached: true, isMain: false })], branches: ["feat/x"], want: ["feat/x"] },
    { name: "its default worktree on it (shared)", projects: [web(main, { path: `${W}/feat-x`, branch: "feat/x", detached: false, isMain: false })], branches: ["feat/x"], want: [] },
    { name: "another worktree on another branch", projects: [web(main, { path: `${W}/mine`, branch: "other", detached: false, isMain: false })], branches: ["feat/x"], want: [] },
    { name: "a plain folder", projects: [{ id: "notes", git: false, worktrees: [{ path: "/h/notes", branch: "", detached: false, isMain: true }] }], branches: [""], want: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(placementCandidates(c.projects, c.branches).map((x) => x.branch)).toEqual(c.want);
    });
  }

  it("signs what made the branch a candidate", () => {
    const moved = (head: string) => placementCandidates([web(main, { path: `${W}/feat-x`, branch: head, detached: false, isMain: false })], ["feat/x"]);
    expect(moved("other")[0]?.signature).not.toEqual(moved("again")[0]?.signature);
  });

  it("names a branch's folder", () => {
    expect(branchFolder("feat/a/b")).toBe("feat-a-b");
  });
});
