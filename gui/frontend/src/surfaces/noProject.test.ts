import { afterEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/threads";
import { emptyRepos, replaceRepos, useReposStore } from "@/stores/repos";
import { emptySessions, replaceSessions, useSessionsStore } from "@/stores/threads";
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

const session = (id: string, o: Partial<SessionView>) => ({ id, repoId: "r1", workspaceId: "", worktreePath: "/src/app", pendingWorktreePath: "", linkedPullRequests: [], ...o }) as SessionView;
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
const sessions = replaceSessions(emptySessions, [session("home", { repoId: "", worktreePath: "/Users/dev", linkedPullRequests: [{ url: "https://github.com/o/app/pull/7", slug: "o/app", number: 7 }] as SessionView["linkedPullRequests"] }), session("proj", {})]);

afterEach(() => {
  useReposStore.setState(emptyRepos);
  useSessionsStore.setState(emptySessions);
});

describe("selectionHasNoProject", () => {
  it.each<[string, Selection, boolean]>([
    ["a thread without a project", { kind: "session", id: "home" }, true],
    ["a project thread", { kind: "session", id: "proj" }, false],
    ["an unknown thread", { kind: "session", id: "gone" }, false],
    ["the no-project composer", { kind: "compose", repoId: "", noProject: true }, true],
    ["a project composer", { kind: "compose", repoId: "r1" }, false],
    ["a page", { kind: "view", name: "projects" }, false],
  ])("%s", (_name, sel, want) => {
    expect(selectionHasNoProject(sel, { repos, sessions })).toBe(want);
  });
});

describe("the side panel of a thread without a project", () => {
  it("lists no files, diff, pull request, workspace or worktree surface; thread surfaces stay", () => {
    useReposStore.setState(repos);
    useSessionsStore.setState(sessions);
    const ctx = { selection: { kind: "session", id: "home" } as Selection, panelKey: "session:home" };
    for (const spec of [filesSurface, diffSurface, pullRequestSurface, workspaceSurface, worktreeSurface]) expect([spec.kind, spec.available(ctx)]).toEqual([spec.kind, "hidden"]);
    for (const spec of [linkedPrsSurface, usageSurface, mcpSurface]) expect([spec.kind, spec.available(ctx)]).toEqual([spec.kind, "enabled"]);
    const proj = { selection: { kind: "session", id: "proj" } as Selection, panelKey: "session:proj" };
    expect(filesSurface.available(proj)).toBe("disabled");
    expect(worktreeSurface.available(proj)).toBe("enabled");
  });
});
