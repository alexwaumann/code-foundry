import { afterEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { emptyRepos, replaceRepos, useReposStore } from "@/stores/repos";
import { emptyThreads, replaceThreads, useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { diffSurface } from "./diff";
import { filesSurface } from "./files";
import { linkedPrsSurface } from "./linkedprs";
import { mcpSurface } from "./mcp";
import { selectionHasNoProject } from "./noProject";
import { pullRequestSurface } from "./pullrequest";
import { usageSurface } from "./usage";
import { workspaceSurface } from "./workspace";
import { worktreeSurface } from "./worktree";

const thread = (id: string, o: Partial<ThreadView>) => ({ id, repoId: "r1", workspaceId: "", worktreePath: "/src/app", pendingWorktreePath: "", linkedPullRequests: [], ...o }) as ThreadView;
const repos = replaceRepos([
  {
    id: "r1",
    path: "/src/app",
    name: "app",
    defaultBranch: "main",
    githubSlug: "o/app",
    remotes: ["origin"],
    git: true,
    worktrees: [{ repoId: "r1", path: "/src/app", branch: "main", head: "", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
  },
]);
const threads = replaceThreads(emptyThreads, [thread("home", { repoId: "", worktreePath: "/Users/dev", linkedPullRequests: [{ url: "https://github.com/o/app/pull/7", slug: "o/app", number: 7 }] as ThreadView["linkedPullRequests"] }), thread("proj", {})]);

afterEach(() => {
  useReposStore.setState(emptyRepos);
  useThreadsStore.setState(emptyThreads);
});

describe("selectionHasNoProject", () => {
  it.each<[string, Selection, boolean]>([
    ["a thread without a project", { kind: "thread", id: "home" }, true],
    ["a project thread", { kind: "thread", id: "proj" }, false],
    ["an unknown thread", { kind: "thread", id: "gone" }, false],
    ["the no-project composer", { kind: "compose", repoId: "", noProject: true }, true],
    ["a project composer", { kind: "compose", repoId: "r1" }, false],
    ["a page", { kind: "view", name: "projects" }, false],
  ])("%s", (_name, sel, want) => {
    expect(selectionHasNoProject(sel, { repos, threads })).toBe(want);
  });
});

describe("the side panel of a thread without a project", () => {
  it("lists no files, diff, pull request, workspace or worktree surface; thread surfaces stay", () => {
    useReposStore.setState(repos);
    useThreadsStore.setState(threads);
    const ctx = { selection: { kind: "thread", id: "home" } as Selection, panelKey: "thread:home" };
    for (const spec of [filesSurface, diffSurface, pullRequestSurface, workspaceSurface, worktreeSurface]) expect([spec.kind, spec.available(ctx)]).toEqual([spec.kind, "hidden"]);
    for (const spec of [linkedPrsSurface, usageSurface, mcpSurface]) expect([spec.kind, spec.available(ctx)]).toEqual([spec.kind, "enabled"]);
    const proj = { selection: { kind: "thread", id: "proj" } as Selection, panelKey: "thread:proj" };
    expect(filesSurface.available(proj)).toBe("disabled");
    expect(worktreeSurface.available(proj)).toBe("enabled");
  });
});
