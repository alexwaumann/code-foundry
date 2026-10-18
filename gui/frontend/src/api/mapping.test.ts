import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ArgType, CommandSchema } from "@/gen/codefoundry/v1/command_pb";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import {
  ActivityStatsSchema,
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
import { ProjectEventSchema, ProjectSchema } from "@/gen/codefoundry/v1/project_pb";
import { AgentRunStatus, ThreadListEventSchema, ThreadSchema, ThreadState, ThreadStatus } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { AttachEventSchema, TerminalEventSchema, TerminalSchema, TerminalState } from "@/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "@/gen/codefoundry/v1/ui_pb";
import { WorkspaceEventSchema } from "@/gen/codefoundry/v1/workspace_pb";
import { toCommandView } from "./command";
import { overrideEndpoint } from "./endpoint";
import { toEventView } from "./events";
import { statsMonth, toGhEventView, toPullRequestDetailView, toPullRequestView, toReviewerCandidateView, toStatsView } from "./gh";
import { isRemoteless, toProjectEventView, toProjectView } from "./project";
import { toThreadListEventView, toThreadView } from "./threads";
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

describe("project mapping", () => {
  it("defaults a missing git status to clean", () => {
    const r = toProjectView(create(ProjectSchema, { id: "r", name: "app", worktrees: [{ projectId: "r", path: "/a", isMain: true }] }));
    expect(r.worktrees[0]?.status).toMatchObject({ dirty: false, ahead: 0, refreshedAtMs: null });
    expect(r.remotes).toEqual([]);
    expect(toProjectView(create(ProjectSchema, { id: "r", remotes: ["origin", "upstream"] })).remotes).toEqual(["origin", "upstream"]);
  });

  it("maps conflicts and the git operation in progress", () => {
    const status = { conflicted: 2, dirty: true, operation: "rebase", operationStep: 3, operationTotal: 6 };
    const r = toProjectView(create(ProjectSchema, { id: "r", worktrees: [{ projectId: "r", path: "/a", status }] }));
    expect(r.worktrees[0]?.status).toMatchObject(status);
    const idle = toProjectView(create(ProjectSchema, { id: "r", worktrees: [{ projectId: "r", path: "/a", status: {} }] }));
    expect(idle.worktrees[0]?.status).toMatchObject({ conflicted: 0, operation: "", operationStep: 0, operationTotal: 0 });
  });

  it("maps git, and tells a remoteless git repository from one without git", () => {
    const wt = [{ projectId: "r", path: "/a", isMain: true }];
    const plain = toProjectView(create(ProjectSchema, { id: "r", worktrees: wt }));
    const local = toProjectView(create(ProjectSchema, { id: "r", git: true, worktrees: wt }));
    const cloned = toProjectView(create(ProjectSchema, { id: "r", git: true, remotes: ["origin"], worktrees: wt }));
    const pending = toProjectView(create(ProjectSchema, { id: "r", git: true }));
    expect([plain.git, local.git]).toEqual([false, true]);
    expect([plain, local, cloned, pending].map(isRemoteless)).toEqual([false, true, false, false]);
  });

  it.each([
    [{ case: "projectRemovedId" as const, value: "r1" }, { kind: "projectRemoved", id: "r1" }],
    [{ case: "worktreeRemoved" as const, value: { projectId: "r1", path: "/p" } }, { kind: "worktreeRemoved", projectId: "r1", path: "/p" }],
  ])("maps ProjectEvent %#", (event, want) => {
    expect(toProjectEventView(create(ProjectEventSchema, { event }))).toEqual(want);
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
    [{ case: "focusThread" as const, value: { threadId: "s1" } }, { kind: "focusThread", threadId: "s1" }],
    [{ case: "focusProject" as const, value: { projectId: "r", worktreePath: "/w" } }, { kind: "focusProject", projectId: "r", worktreePath: "/w" }],
    [{ case: "openPalette" as const, value: { query: "new" } }, { kind: "openPalette", query: "new" }],
    [
      { case: "notify" as const, value: { level: UiIntent_Notify_Level.ERROR, title: "x", body: "y" } },
      { kind: "notify", level: "error", title: "x", body: "y" },
    ],
    [{ case: "notify" as const, value: { title: "x" } }, { kind: "notify", level: "info", title: "x", body: "" }],
    [{ case: "playAlertSound" as const, value: { volume: 15 } }, { kind: "playAlertSound", volume: 15 }],
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
      baseSha: "def456",
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
      baseSha: "def456",
    });
    expect(toPullRequestView(create(PullRequestSchema, {}))).toMatchObject({ mergeable: null, mergeState: "", partial: false, headSha: "", baseSha: "" });
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

  it("maps six months of stats newest first; the page reads this month and last", () => {
    const months = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"].map((month, i) => ({ month, commits: 10 * i, merged: i }));
    const s = toStatsView(create(ActivityStatsSchema, { months, commitsSource: "search", fetchedAt: timestampFromMs(5_000) }));
    expect(s.months).toHaveLength(6);
    expect(statsMonth(s, 0)).toEqual({ month: "2026-10", commits: 0, merged: 0 });
    expect(statsMonth(s, 1)).toEqual({ month: "2026-09", commits: 10, merged: 1 });
    expect(s.months[5]).toEqual({ month: "2026-05", commits: 50, merged: 5 });
    expect(s.commitsSource).toBe("search");
    expect(s.fetchedAtMs).toBe(5_000);
    // Never fetched: no months, and the tiles read empty ones.
    const empty = toStatsView(undefined);
    expect(empty.months).toEqual([]);
    expect(statsMonth(empty, 1)).toEqual({ month: "", commits: 0, merged: 0 });
  });
});

describe("events mapping", () => {
  it.each([
    [{ case: "project" as const, value: create(ProjectEventSchema, { event: { case: "snapshot", value: { projects: [] } } }) }, { source: "project", event: { kind: "snapshot", projects: [] } }],
    [{ case: "terminal" as const, value: create(TerminalEventSchema, { event: { case: "removedId", value: "t1" } }) }, { source: "terminal", event: { kind: "removed", id: "t1" } }],
    [{ case: "threadList" as const, value: create(ThreadListEventSchema, { event: { case: "removedId", value: "s1" } }) }, { source: "threadList", event: { kind: "removed", id: "s1" } }],
    [{ case: "gh" as const, value: create(GhEventSchema, { event: { case: "polled", value: { fetchedAt: timestampFromMs(5000), lastError: "boom" } } }) }, { source: "gh", event: { kind: "polled", fetchedAtMs: 5000, lastError: "boom" } }],
    [{ case: "gh" as const, value: create(GhEventSchema, { event: { case: "repoActivityUpdated", value: { repoSlug: "o/r" } } }) }, { source: "gh", event: { kind: "repoActivity", repoSlug: "o/r" } }],
    [{ case: "ui" as const, value: create(UiIntentSchema, { intent: { case: "openPalette", value: { query: "q" } } }) }, { source: "ui", event: { kind: "openPalette", query: "q" } }],
    [{ case: "workspace" as const, value: create(WorkspaceEventSchema, { event: { case: "removedId", value: "w-1" } }) }, { source: "workspace", event: { kind: "removed", id: "w-1" } }],
  ])("maps %#", (event, want) => {
    expect(toEventView(create(EventSchema, { event }))).toEqual(want);
  });

  it("maps a thread", () => {
    const s = create(ThreadSchema, {
      id: "s1",
      worktreePath: "/w",
      name: "fix tests",
      model: "opus",
      state: ThreadState.DISCONNECTED,
      status: ThreadStatus.NEEDS_ATTENTION,
      lastActivityAt: timestampFromMs(5000),
      exitCode: 1,
      disconnectReason: "crashed",
    });
    expect(toThreadView(s)).toMatchObject({ id: "s1", state: "disconnected", status: "attention", lastActivityAtMs: 5000, createdAtMs: null });
    // The process's exit is internal to the daemon: the view leaves it out.
    expect(toThreadView(s)).not.toHaveProperty("disconnectReason");
    expect(toThreadView(s)).not.toHaveProperty("exitCode");
    expect(toThreadView(s).workspaceId).toBe("");
    expect(toThreadView(s)).toMatchObject({ statusReason: "", statusChangedAtMs: null });
    expect(toThreadView(s).archivedAtMs).toBeNull();
    expect(toThreadView(create(ThreadSchema, { id: "s4", archivedAt: timestampFromMs(9000) })).archivedAtMs).toBe(9000);
    expect(toThreadView(s).snoozedUntilMs).toBeNull();
    expect(toThreadView(create(ThreadSchema, { id: "s5", snoozedUntil: timestampFromMs(12_345) })).snoozedUntilMs).toBe(12_345);
    expect(
      toThreadView(create(ThreadSchema, { id: "s3", status: ThreadStatus.ERROR, statusReason: "interrupted", statusChangedAt: timestampFromMs(7000) })),
    ).toMatchObject({ status: "error", statusReason: "interrupted", statusChangedAtMs: 7000 });
    expect(toThreadView(create(ThreadSchema, { id: "s2", projectId: "web", workspaceId: "w-1" }))).toMatchObject({ projectId: "web", workspaceId: "w-1" });
  });

  it("maps linked pull requests in order", () => {
    expect(toThreadView(create(ThreadSchema, { id: "s1" })).linkedPullRequests).toEqual([]);
    const s = create(ThreadSchema, {
      id: "s1",
      linkedPullRequests: [
        { slug: "o/r", number: 5, url: "https://github.com/o/r/pull/5", linkedAt: timestampFromMs(9000) },
        { slug: "o/r", number: 6, url: "https://github.com/o/r/pull/6" },
      ],
    });
    expect(toThreadView(s).linkedPullRequests).toEqual([
      { slug: "o/r", number: 5, url: "https://github.com/o/r/pull/5", linkedAt: 9000 },
      { slug: "o/r", number: 6, url: "https://github.com/o/r/pull/6", linkedAt: null },
    ]);
  });

  it("maps usage buckets, cost and the retired ledger", () => {
    const bucket = {
      model: "claude-haiku-5-5",
      tier: "long",
      speed: "",
      day: "2026-10-10",
      requests: 3n,
      input: 12n,
      output: 340n,
      cacheRead: 30100n,
      cacheWrite5m: 0n,
      cacheWrite1h: 11400n,
      costUsd: 0.0026,
      unpriced: false,
      inputCostUsd: 0.0001,
      outputCostUsd: 0.0002,
      cacheReadCostUsd: 0.0003,
      cacheWrite5mCostUsd: 0,
      cacheWrite1hCostUsd: 0.002,
      cacheSavingsUsd: 0.0135,
    };
    const view = {
      model: "claude-haiku-5-5",
      tier: "long",
      speed: "",
      day: "2026-10-10",
      requests: 3,
      input: 12,
      output: 340,
      cacheRead: 30100,
      cacheWrite5m: 0,
      cacheWrite1h: 11400,
      costUsd: 0.0026,
      unpriced: false,
      inputCostUsd: 0.0001,
      outputCostUsd: 0.0002,
      cacheReadCostUsd: 0.0003,
      cacheWrite5mCostUsd: 0,
      cacheWrite1hCostUsd: 0.002,
      cacheSavingsUsd: 0.0135,
    };
    expect(toThreadView(create(ThreadSchema, { id: "s0" }))).toMatchObject({ usage: [], costUsd: 0, unpriced: false });
    expect(toThreadView(create(ThreadSchema, { id: "s1", usage: [bucket], costUsd: 0.0026, unpriced: true }))).toMatchObject({
      usage: [view],
      costUsd: 0.0026,
      unpriced: true,
    });
    const snap = toThreadListEventView(create(ThreadListEventSchema, { event: { case: "snapshot", value: { threads: [], retiredUsage: [bucket] } } }));
    expect(snap).toEqual({ kind: "snapshot", threads: [], retiredUsage: [view] });
    const retired = toThreadListEventView(create(ThreadListEventSchema, { event: { case: "retiredUsage", value: { buckets: [bucket] } } }));
    expect(retired).toEqual({ kind: "retiredUsage", buckets: [view] });
  });

  it("maps a thread's pending API retry", () => {
    expect(toThreadView(create(ThreadSchema, { id: "s0" })).retry).toBeNull();
    expect(toThreadView(create(ThreadSchema, { id: "s1", retry: { attempt: 3, maxRetries: 10, retryAt: timestampFromMs(20_000), errorStatus: 429, error: "rate_limit" } })).retry).toEqual({
      attempt: 3,
      maxRetries: 10,
      retryAtMs: 20_000,
      errorStatus: 429,
      error: "rate_limit",
    });
  });

  it("maps a thread's context totals and cache expiry", () => {
    expect(toThreadView(create(ThreadSchema, { id: "s0" }))).toMatchObject({ contextTokens: 0, cacheExpiresAtMs: null, contextRereadUsd: 0 });
    expect(toThreadView(create(ThreadSchema, { id: "s1", contextTokens: 25_700n, cacheExpiresAt: timestampFromMs(3_600_000), contextRereadUsd: 0.0514 }))).toMatchObject({
      contextTokens: 25_700,
      cacheExpiresAtMs: 3_600_000,
      contextRereadUsd: 0.0514,
    });
  });

  it("maps agent runs with their status, start and priced usage", () => {
    const usage = [{ model: "claude-haiku-5-5", day: "2026-10-11", requests: 2n, input: 3n, output: 4n, cacheRead: 5n, costUsd: 0.0001, cacheSavingsUsd: 0.00002 }];
    const s = toThreadView(
      create(ThreadSchema, {
        id: "s1",
        agentRuns: [
          { id: "a1", description: "say ok", agentType: "general-purpose", model: "haiku", effort: "medium", status: AgentRunStatus.CLOSED, spawnDepth: 1, startedAt: timestampFromMs(1000), usage, costUsd: 0.0001 },
          { id: "a2", background: true, status: AgentRunStatus.OPEN, spawnDepth: 2, unpriced: true },
        ],
      }),
    );
    expect(s.agentRuns).toEqual([
      {
        id: "a1",
        description: "say ok",
        agentType: "general-purpose",
        model: "haiku",
        effort: "medium",
        background: false,
        status: "closed",
        spawnDepth: 1,
        startedAtMs: 1000,
        usage: [
          {
            model: "claude-haiku-5-5",
            tier: "",
            speed: "",
            day: "2026-10-11",
            requests: 2,
            input: 3,
            output: 4,
            cacheRead: 5,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            costUsd: 0.0001,
            unpriced: false,
            inputCostUsd: 0,
            outputCostUsd: 0,
            cacheReadCostUsd: 0,
            cacheWrite5mCostUsd: 0,
            cacheWrite1hCostUsd: 0,
            cacheSavingsUsd: 0.00002,
          },
        ],
        costUsd: 0.0001,
        unpriced: false,
      },
      { id: "a2", description: "", agentType: "", model: "", effort: "", background: true, status: "open", spawnDepth: 2, startedAtMs: null, usage: [], costUsd: 0, unpriced: true },
    ]);
    expect(toThreadView(create(ThreadSchema, { id: "s0" })).agentRuns).toEqual([]);
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
        { projectId: "web", worktreePath: "/wt/web/cf-login" },
        { projectId: "api", worktreePath: "/wt/api/cf-login" },
      ],
      createdAt: timestampFromMs(7000),
    };
    const want = {
      id: "w-1",
      name: "login",
      branch: "cf/login",
      members: [
        { projectId: "web", worktreePath: "/wt/web/cf-login" },
        { projectId: "api", worktreePath: "/wt/api/cf-login" },
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
