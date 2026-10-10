import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ArgType, CommandSchema } from "@/gen/codefoundry/v1/command_pb";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import {
  CheckConclusion,
  CheckRollupState,
  CheckStatus,
  DiffSide,
  GhEventSchema,
  Mergeable,
  MergeStateStatus,
  PullRequestCommentKind,
  PullRequestDetailSchema,
  PullRequestReviewState,
  PullRequestSchema,
  PullRequestState,
  ReviewerCandidateSchema,
  ReviewerKind,
} from "@/gen/codefoundry/v1/gh_pb";
import { RepoEventSchema, RepoSchema } from "@/gen/codefoundry/v1/repo_pb";
import { SessionEventSchema, SessionSchema, SessionState, SessionStatus } from "@/gen/codefoundry/v1/session_pb";
import { AttachEventSchema, TerminalEventSchema, TerminalSchema, TerminalState } from "@/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "@/gen/codefoundry/v1/ui_pb";
import { WorkspaceEventSchema } from "@/gen/codefoundry/v1/workspace_pb";
import { toCommandView } from "./command";
import { overrideEndpoint } from "./endpoint";
import { toEventView } from "./events";
import { toGhEventView, toPullRequestDetailView, toPullRequestView, toReviewerCandidateView } from "./gh";
import { toRepoEventView, toRepoView } from "./repo";
import { toSessionView } from "./session";
import { toAttachEventView, toTerminalEventView, toTerminalView } from "./terminal";
import { toUiIntentView } from "./ui";
import { toWorkspaceEventView } from "./workspace";

describe("terminal mapping", () => {
  it("maps a Terminal to its view model", () => {
    const t = create(TerminalSchema, {
      id: "t1",
      argv: ["claude", "--resume"],
      cwd: "/src",
      cols: 120,
      rows: 40,
      title: "✳ Work",
      state: TerminalState.EXITED,
      exitCode: 3,
      startedAt: timestampFromMs(1000),
      exitedAt: timestampFromMs(5000),
      altScreen: true,
      labels: { worktree: "/src" },
    });
    expect(toTerminalView(t)).toEqual({
      id: "t1",
      argv: ["claude", "--resume"],
      cwd: "/src",
      cols: 120,
      rows: 40,
      title: "✳ Work",
      state: "exited",
      exitCode: 3,
      startedAtMs: 1000,
      exitedAtMs: 5000,
      altScreen: true,
      labels: { worktree: "/src" },
    });
    expect(toTerminalView(create(TerminalSchema, { id: "x" }))).toMatchObject({ state: "unknown", startedAtMs: null, exitedAtMs: null });
  });

  it.each([
    [{ event: { case: "updated" as const, value: create(TerminalSchema, { id: "a", state: TerminalState.RUNNING }) } }, { kind: "updated", id: "a" }],
    [{ event: { case: "removedId" as const, value: "b" } }, { kind: "removed", id: "b" }],
  ])("maps TerminalEvent %#", (init, want) => {
    const v = toTerminalEventView(create(TerminalEventSchema, init));
    expect(v?.kind).toBe(want.kind);
    expect(v?.kind === "updated" ? v.terminal.id : v?.id).toBe(want.id);
  });

  it("maps every AttachEvent case and drops empty ones", () => {
    const data = new Uint8Array([27, 91, 109]);
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "snapshot", value: { data, cols: 80, rows: 24, altScreen: true } } }))).toEqual({
      kind: "snapshot",
      data,
      cols: 80,
      rows: 24,
      altScreen: true,
    });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "output", value: { data } } }))).toEqual({ kind: "output", data });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "resized", value: { cols: 1, rows: 2 } } }))).toEqual({ kind: "resized", cols: 1, rows: 2 });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "exited", value: { exitCode: 7 } } }))).toEqual({ kind: "exited", exitCode: 7 });
    expect(toAttachEventView(create(AttachEventSchema, {}))).toBeNull();
  });
});

describe("repo mapping", () => {
  it("defaults a missing git status to clean", () => {
    const r = toRepoView(create(RepoSchema, { id: "r", name: "app", worktrees: [{ repoId: "r", path: "/a", isMain: true }] }));
    expect(r.worktrees[0]?.status).toMatchObject({ dirty: false, ahead: 0, refreshedAtMs: null });
    expect(r.remotes).toEqual([]);
    expect(toRepoView(create(RepoSchema, { id: "r", remotes: ["origin", "upstream"] })).remotes).toEqual(["origin", "upstream"]);
  });

  it.each([
    [{ case: "repoRemovedId" as const, value: "r1" }, { kind: "repoRemoved", id: "r1" }],
    [{ case: "worktreeRemoved" as const, value: { repoId: "r1", path: "/p" } }, { kind: "worktreeRemoved", repoId: "r1", path: "/p" }],
  ])("maps RepoEvent %#", (event, want) => {
    expect(toRepoEventView(create(RepoEventSchema, { event }))).toEqual(want);
  });
});

describe("command mapping", () => {
  it("maps arg types and fills defaults", () => {
    const c = toCommandView(
      create(CommandSchema, {
        name: "worktree.remove",
        args: [
          { name: "force", type: ArgType.BOOL, required: true },
          { name: "path", type: ArgType.PATH },
          { name: "n", type: ArgType.INT },
          { name: "m", type: ArgType.ENUM, enumValues: ["a"] },
          { name: "s", type: ArgType.UNSPECIFIED },
        ],
        keybindings: ["cmd+w"],
        available: true,
      }),
    );
    expect(c.title).toBe("worktree.remove");
    expect(c.category).toBe("General");
    expect(c.args.map((a) => a.type)).toEqual(["bool", "path", "int", "enum", "string"]);
    expect(c.keybindings).toEqual(["cmd+w"]);
  });
});

describe("ui intent mapping", () => {
  it.each([
    [{ case: "focusTerminal" as const, value: { terminalId: "t" } }, { kind: "focusTerminal", terminalId: "t" }],
    [{ case: "focusSession" as const, value: { sessionId: "s1" } }, { kind: "focusSession", sessionId: "s1" }],
    [{ case: "focusRepo" as const, value: { repoId: "r", worktreePath: "/w" } }, { kind: "focusRepo", repoId: "r", worktreePath: "/w" }],
    [{ case: "openPalette" as const, value: { query: "new" } }, { kind: "openPalette", query: "new" }],
    [
      { case: "notify" as const, value: { level: UiIntent_Notify_Level.ERROR, title: "x", body: "y" } },
      { kind: "notify", level: "error", title: "x", body: "y" },
    ],
    [{ case: "notify" as const, value: { title: "x" } }, { kind: "notify", level: "info", title: "x", body: "" }],
  ])("maps %#", (intent, want) => {
    expect(toUiIntentView(create(UiIntentSchema, { intent }))).toEqual(want);
  });
});

describe("gh mapping", () => {
  it("maps a pull request with its detail fields", () => {
    const p = create(PullRequestSchema, {
      repoSlug: "o/r",
      number: 7,
      title: "t",
      state: PullRequestState.OPEN,
      mergeable: Mergeable.CONFLICTING,
      mergeStateStatus: MergeStateStatus.HAS_HOOKS,
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      commentCount: 3,
      reviewCount: 4,
      latestReviews: [{ author: "kim", state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: timestampFromMs(9000) }, { author: "x" }],
      reviewRequests: ["acme/core"],
      isCrossRepository: true,
      partial: true,
      headSha: "abc123",
    });
    const v = toPullRequestView(p);
    expect(v).toMatchObject({
      repoSlug: "o/r",
      state: "open",
      mergeable: "conflicting",
      mergeState: "has_hooks",
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      comments: 3,
      reviews: 4,
      latestReviews: [
        { author: "kim", state: "changes_requested", submittedAtMs: 9000 },
        { author: "x", state: "", submittedAtMs: null },
      ],
      reviewRequests: ["acme/core"],
      isCrossRepository: true,
      partial: true,
      headSha: "abc123",
    });
    expect(toPullRequestView(create(PullRequestSchema, {}))).toMatchObject({ mergeable: null, mergeState: "", partial: false, headSha: "" });
  });

  it("maps a pull request detail", () => {
    const d = create(PullRequestDetailSchema, {
      pullRequest: { repoSlug: "o/r", number: 7, state: PullRequestState.MERGED, checks: { state: CheckRollupState.FAILURE, total: 2, passed: 1, failed: 1 } },
      body: "## Summary",
      labels: [{ name: "bug", color: "d73a4a" }],
      reviewers: [
        { login: "acme/core", isTeam: true, requested: true },
        { login: "kim", state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: timestampFromMs(5000), stale: true, avatarUrl: "a" },
        { login: "bot", isBot: true, state: PullRequestReviewState.DISMISSED },
      ],
      commits: [{ sha: "0123456789abcdef", headline: "fix", authorLogin: "octocat", authorName: "Octo", committedAt: timestampFromMs(1000) }],
      commitCount: 120,
      comments: [
        { id: "IC_1", kind: PullRequestCommentKind.ISSUE_COMMENT, author: "kim", body: "why?", createdAt: timestampFromMs(2000), url: "u" },
        { id: "PRR_1", kind: PullRequestCommentKind.REVIEW, author: "kim", reviewState: PullRequestReviewState.APPROVED },
      ],
      commentsTruncated: true,
      reviewThreads: [
        {
          id: "T1",
          path: "main.go",
          line: 12,
          side: DiffSide.LEFT,
          isOutdated: true,
          comments: [{ id: "C1", kind: PullRequestCommentKind.REVIEW_COMMENT, author: "gha", authorIsBot: true, path: "main.go", reviewId: "PRR_9" }],
          commentsTruncated: true,
        },
        { id: "T2", path: "x.go" },
      ],
      checks: [{ name: "test", workflow: "CI", status: CheckStatus.IN_PROGRESS, description: "d", startedAt: timestampFromMs(3000) }, { name: "lint", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE }],
      mergeCommitSha: "abc",
      mergedBy: "kim",
      closedAt: timestampFromMs(4000),
      nodeId: "PR_7",
      viewerCanUpdate: true,
      viewerPermission: "write",
      fetchedAt: timestampFromMs(6000),
      lastError: "stale",
      labelsTruncated: true,
      reviewersTruncated: true,
      checksTruncated: true,
    });
    const v = toPullRequestDetailView(d);
    expect(v).toMatchObject({
      pullRequest: { repoSlug: "o/r", number: 7, state: "merged", checks: { state: "failure", failed: 1 } },
      body: "## Summary",
      labels: [{ name: "bug", color: "d73a4a" }],
      reviewers: [
        { login: "acme/core", isTeam: true, isBot: false, state: "", submittedAtMs: null, requested: true, stale: false },
        { login: "kim", isTeam: false, state: "changes_requested", submittedAtMs: 5000, requested: false, stale: true, avatarUrl: "a" },
        { login: "bot", isBot: true, state: "dismissed" },
      ],
      commits: [{ sha: "0123456789abcdef", shortSha: "0123456", headline: "fix", authorLogin: "octocat", authorName: "Octo", committedAtMs: 1000 }],
      commitCount: 120,
      comments: [
        { id: "IC_1", kind: "issue_comment", author: "kim", body: "why?", createdAtMs: 2000, url: "u", reviewState: "", reviewId: "" },
        { id: "PRR_1", kind: "review", reviewState: "approved", createdAtMs: null },
      ],
      commentsTruncated: true,
      reviewThreads: [
        { id: "T1", path: "main.go", line: 12, side: "left", isResolved: false, isOutdated: true, commentsTruncated: true, comments: [{ kind: "review_comment", authorIsBot: true, path: "main.go", reviewId: "PRR_9" }] },
        { id: "T2", side: null, line: 0, comments: [] },
      ],
      reviewThreadsTruncated: false,
      checks: [
        { name: "test", workflow: "CI", conclusion: "", status: "in_progress", description: "d", startedAtMs: 3000, completedAtMs: null },
        { name: "lint", conclusion: "failure", status: "completed" },
      ],
      mergeCommitSha: "abc",
      mergedBy: "kim",
      closedAtMs: 4000,
      nodeId: "PR_7",
      viewerCanUpdate: true,
      viewerPermission: "write",
      fetchedAtMs: 6000,
      lastError: "stale",
      labelsTruncated: true,
      reviewersTruncated: true,
      checksTruncated: true,
    });
    expect(toPullRequestDetailView(create(PullRequestDetailSchema, {}))).toMatchObject({
      pullRequest: { state: "unknown", number: 0 },
      closedAtMs: null,
      checks: [],
      labelsTruncated: false,
      reviewersTruncated: false,
      checksTruncated: false,
    });
  });

  it("maps reviewer candidates and the detail event", () => {
    expect(toReviewerCandidateView(create(ReviewerCandidateSchema, { id: "T1", kind: ReviewerKind.TEAM, login: "acme/core", name: "Core", isRequested: true }))).toEqual({
      id: "T1",
      kind: "team",
      login: "acme/core",
      name: "Core",
      avatarUrl: "",
      isRequested: true,
    });
    expect(toReviewerCandidateView(create(ReviewerCandidateSchema, { login: "kim" })).kind).toBe("user");
    const ev = create(GhEventSchema, { event: { case: "pullRequestDetailUpdated", value: { repoSlug: "o/r", number: 7 } } });
    expect(toGhEventView(ev)).toEqual({ kind: "pullRequestDetail", repoSlug: "o/r", number: 7 });
  });
});

describe("events mapping", () => {
  it.each([
    [{ case: "repo" as const, value: create(RepoEventSchema, { event: { case: "snapshot", value: { repos: [] } } }) }, { source: "repo", event: { kind: "snapshot", repos: [] } }],
    [{ case: "terminal" as const, value: create(TerminalEventSchema, { event: { case: "removedId", value: "t1" } }) }, { source: "terminal", event: { kind: "removed", id: "t1" } }],
    [{ case: "session" as const, value: create(SessionEventSchema, { event: { case: "removedId", value: "s1" } }) }, { source: "session", event: { kind: "removed", id: "s1" } }],
    [{ case: "gh" as const, value: create(GhEventSchema, { event: { case: "polled", value: { fetchedAt: timestampFromMs(5000), lastError: "boom" } } }) }, { source: "gh", event: { kind: "polled", fetchedAtMs: 5000, lastError: "boom" } }],
    [{ case: "gh" as const, value: create(GhEventSchema, { event: { case: "repoActivityUpdated", value: { repoSlug: "o/r" } } }) }, { source: "gh", event: { kind: "repoActivity", repoSlug: "o/r" } }],
    [{ case: "ui" as const, value: create(UiIntentSchema, { intent: { case: "openPalette", value: { query: "q" } } }) }, { source: "ui", event: { kind: "openPalette", query: "q" } }],
    [{ case: "workspace" as const, value: create(WorkspaceEventSchema, { event: { case: "removedId", value: "w-1" } }) }, { source: "workspace", event: { kind: "removed", id: "w-1" } }],
  ])("maps %#", (event, want) => {
    expect(toEventView(create(EventSchema, { event }))).toEqual(want);
  });

  it("maps a session", () => {
    const s = create(SessionSchema, {
      id: "s1",
      worktreePath: "/w",
      name: "fix tests",
      model: "opus",
      terminalId: "t1",
      state: SessionState.DISCONNECTED,
      status: SessionStatus.NEEDS_ATTENTION,
      lastActivityAt: timestampFromMs(5000),
      exitCode: 1,
      disconnectReason: "crashed",
    });
    expect(toSessionView(s)).toMatchObject({ id: "s1", state: "disconnected", status: "attention", lastActivityAtMs: 5000, createdAtMs: null, exitCode: 1, disconnectReason: "crashed" });
    expect(toSessionView(s).workspaceId).toBe("");
    expect(toSessionView(create(SessionSchema, { id: "s2", repoId: "web", workspaceId: "w-1" }))).toMatchObject({ repoId: "web", workspaceId: "w-1" });
  });

  it("empty events map to null", () => {
    expect(toEventView(create(EventSchema, {}))).toBeNull();
  });
});

describe("workspace mapping", () => {
  it("maps a snapshot and an update, members in order", () => {
    const login = {
      id: "w-1",
      name: "login",
      branch: "cf/login",
      members: [
        { repoId: "web", worktreePath: "/wt/web/cf-login" },
        { repoId: "api", worktreePath: "/wt/api/cf-login" },
      ],
      createdAt: timestampFromMs(7000),
    };
    const want = {
      id: "w-1",
      name: "login",
      branch: "cf/login",
      members: [
        { repoId: "web", worktreePath: "/wt/web/cf-login" },
        { repoId: "api", worktreePath: "/wt/api/cf-login" },
      ],
      createdAtMs: 7000,
    };
    expect(toWorkspaceEventView(create(WorkspaceEventSchema, { event: { case: "snapshot", value: { workspaces: [login] } } }))).toEqual({ kind: "snapshot", workspaces: [want] });
    expect(toWorkspaceEventView(create(WorkspaceEventSchema, { event: { case: "updated", value: { ...login, createdAt: undefined } } }))).toEqual({
      kind: "updated",
      workspace: { ...want, createdAtMs: null },
    });
    expect(toWorkspaceEventView(create(WorkspaceEventSchema, {}))).toBeNull();
  });
});

describe("overrideEndpoint", () => {
  it.each([
    ["query wins", "?daemon=http://q:1&token=qt", { VITE_DAEMON_URL: "http://e:2", VITE_DAEMON_TOKEN: "et" }, { baseUrl: "http://q:1", token: "qt" }],
    ["env", "", { VITE_DAEMON_URL: "http://e:2", VITE_DAEMON_TOKEN: "et" }, { baseUrl: "http://e:2", token: "et" }],
    ["none", "?x=1", {}, null],
  ])("%s", (_name, search, env, want) => {
    expect(overrideEndpoint(search, env)).toEqual(want);
  });
});
