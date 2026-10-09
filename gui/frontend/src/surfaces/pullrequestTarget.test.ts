import { describe, expect, it } from "vitest";
import type { BranchPullRequestsView, PullRequestView } from "@/api/gh";
import type { RepoView, WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import type { ResourceEntry } from "@/stores/resource";
import type { Selection } from "@/stores/ui";
import { pickPullRequest, prRefOfTab, pullRequestTab, selectionPullRequest, type SelectionStores } from "./pullrequestTarget";

const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (path: string, branch: string, isMain = false): WorktreeView => ({ repoId: "r1", path, branch, head: "abc", isMain, status });
const repo: RepoView = { id: "r1", path: "/src/cf", name: "cf", defaultBranch: "main", githubSlug: "Alex/CF", worktrees: [wt("/src/cf", "main", true), wt("/src/cf-fix", "fix/resize"), wt("/src/cf-nopr", "feat/nopr")] };
const local: RepoView = { id: "r2", path: "/src/local", name: "local", defaultBranch: "main", githubSlug: "", worktrees: [{ ...wt("/src/local", "main", true), repoId: "r2" }] };
const session = (id: string, worktreePath: string): SessionView => ({ id, worktreePath, repoId: "r1", terminalId: "" }) as SessionView;

const stores: SelectionStores = {
  repos: { byId: { r1: repo, r2: local }, order: ["r1", "r2"] },
  sessions: { byId: { s1: session("s1", "/src/cf-fix"), s2: session("s2", "/src/cf"), s3: session("s3", "/gone") }, order: ["s1", "s2", "s3"] },
  terminals: { byId: {}, order: [] },
};

const pr = (number: number, state: PullRequestView["state"]): PullRequestView => ({ repoSlug: "alex/cf", number, state }) as PullRequestView;
const entries: Record<string, ResourceEntry<BranchPullRequestsView>> = {
  "alex/cf fix/resize": { data: { pullRequests: [pr(140, "closed"), pr(145, "open")], fetchedAtMs: 1, lastError: "" }, error: null, loading: false },
  "alex/cf main": { data: { pullRequests: [], fetchedAtMs: 1, lastError: "" }, error: null, loading: false },
};
const entryOf = (slug: string, branch: string) => entries[`${slug} ${branch}`];

describe("selectionPullRequest", () => {
  it.each<[string, Selection, { slug: string; number: number } | null]>([
    ["session on a branch with an open PR", { kind: "session", id: "s1" }, { slug: "alex/cf", number: 145 }],
    ["worktree row", { kind: "worktree", repoId: "r1", path: "/src/cf-fix" }, { slug: "alex/cf", number: 145 }],
    ["session on main (no PR)", { kind: "session", id: "s2" }, null],
    ["repo row (main worktree, no PR)", { kind: "repo", repoId: "r1" }, null],
    ["branch not loaded yet", { kind: "worktree", repoId: "r1", path: "/src/cf-nopr" }, null],
    ["repo without a GitHub remote", { kind: "repo", repoId: "r2" }, null],
    ["session whose worktree is gone", { kind: "session", id: "s3" }, null],
    ["unknown session", { kind: "session", id: "nope" }, null],
    ["Pull Requests page", { kind: "view", name: "pullrequests" }, null],
    ["nothing selected", { kind: "none" }, null],
  ])("%s", (_name, sel, want) => {
    expect(selectionPullRequest(sel, stores, entryOf)).toEqual(want);
  });
});

describe("pickPullRequest", () => {
  it.each([
    [[], null],
    [[pr(1, "merged"), pr(2, "open")], 2],
    [[pr(1, "merged"), pr(2, "closed")], 1],
  ] as const)("%j -> %s", (prs, want) => {
    expect(pickPullRequest(prs)?.number ?? null).toBe(want);
  });
});

describe("pull request tabs", () => {
  it("names the pull request in its params and #number in its title", () => {
    const tab = pullRequestTab({ slug: "alex/cf", number: 145 });
    expect(tab).toEqual({ id: "pullrequest?number=145&slug=alex%2Fcf", kind: "pullrequest", title: "#145", params: { slug: "alex/cf", number: "145" } });
    expect(prRefOfTab(tab)).toEqual({ slug: "alex/cf", number: 145 });
  });

  it.each<Record<string, string>>([{}, { slug: "x", number: "1" }, { slug: "a/b", number: "0" }, { slug: "a/b", number: "abc" }])("rejects %j", (params) => {
    expect(prRefOfTab({ params })).toBeNull();
  });
});
