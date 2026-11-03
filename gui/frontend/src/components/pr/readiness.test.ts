import { describe, expect, it } from "vitest";
import type { CheckView, PullRequestDetailView, PullRequestReviewerView, PullRequestView, ReviewThreadView } from "@/api/gh";
import { AUTO_MERGE_OFF_NOTE, awaitingApproval, detailFresh, readiness, type ReadinessRow, type SubLine } from "./readiness";

const NOW = Date.UTC(2026, 10, 3, 12);
const HOUR = 3_600_000;
const VIEWER = "me";

const check = (name: string, o: Partial<CheckView> = {}): CheckView => ({
  name,
  workflow: "CI",
  url: `https://ci/${name}`,
  conclusion: "success",
  status: "completed",
  description: "",
  startedAtMs: NOW - HOUR,
  completedAtMs: NOW - HOUR + 60_000,
  ...o,
});
const failed = (name: string) => check(name, { conclusion: "failure" });
const running = (name: string) => check(name, { conclusion: "", status: "in_progress", completedAtMs: null });
const skipped = (name: string) => check(name, { conclusion: "skipped" });
const awaiting = (name: string) => check(name, { conclusion: "", status: "queued", description: "Waiting for a maintainer to approve the workflow run", startedAtMs: null, completedAtMs: null, url: "" });

const reviewer = (login: string, o: Partial<PullRequestReviewerView> = {}): PullRequestReviewerView => ({
  login,
  isTeam: login.includes("/"),
  isBot: false,
  avatarUrl: "",
  state: "",
  submittedAtMs: null,
  requested: false,
  stale: false,
  ...o,
});
const thread = (path: string, line: number, o: Partial<ReviewThreadView> = {}): ReviewThreadView => ({ id: `${path}:${String(line)}`, path, line, side: "right", isResolved: false, isOutdated: false, comments: [], commentsTruncated: false, ...o });

interface Shape {
  pr?: Partial<PullRequestView>;
  d?: Partial<PullRequestDetailView>;
}

/** An open, mergeable, approved pull request by the viewer with two passing checks; s overrides. */
function detail(s: Shape = {}): PullRequestDetailView {
  const pr: PullRequestView = {
    repoSlug: "o/r",
    number: 7,
    title: "t",
    author: VIEWER,
    url: "https://github.com/o/r/pull/7",
    state: "open",
    draft: false,
    headRef: "feat",
    headSha: "a".repeat(40),
    baseRef: "trunk",
    baseSha: "",
    review: "approved",
    checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 },
    createdAtMs: NOW - 48 * HOUR,
    updatedAtMs: NOW - HOUR,
    mergedAtMs: null,
    mergeable: "mergeable",
    mergeState: "clean",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    comments: 0,
    reviews: 1,
    latestReviews: [],
    reviewRequests: [],
    isCrossRepository: false,
    headRepoSlug: "o/r",
    partial: false,
    ...s.pr,
  };
  return {
    pullRequest: pr,
    body: "",
    labels: [],
    labelsTruncated: false,
    reviewers: [reviewer("kim", { state: "approved", submittedAtMs: NOW - HOUR })],
    reviewersTruncated: false,
    commits: [],
    commitCount: 1,
    comments: [],
    commentsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
    checks: [check("build"), check("lint")],
    checksTruncated: false,
    mergeCommitSha: "",
    mergedBy: "",
    closedAtMs: null,
    nodeId: "",
    viewerCanUpdate: true,
    mergeMethods: ["merge", "squash", "rebase"],
    autoMergeEnabled: false,
    autoMergeMethod: null,
    autoMergeAllowed: true,
    defaultBranch: "trunk",
    viewerPermission: "write",
    fetchedAtMs: NOW,
    lastError: "",
    fetchFailed: false,
    ...s.d,
  };
}

/** A row as "id tone: title · meta" for compact expectations. */
const brief = (r: ReadinessRow): string => `${r.id} ${r.tone}: ${r.title}${r.meta ? ` · ${r.meta}` : ""}`;
const lineText = (l: SubLine): string => {
  switch (l.kind) {
    case "text":
      return l.text;
    case "check":
      return `check ${l.check.name}`;
    case "person":
      return `person ${l.text}`;
    case "locations":
      return l.items.map((i) => `${i.text}${i.outdated ? " (outdated)" : ""}`).join(" · ");
    case "commit":
      return `commit ${l.sha.slice(0, 7)}`;
  }
};

describe("readiness: headline, rows and footer", () => {
  const cases: {
    name: string;
    s: Shape;
    viewer?: string;
    fresh?: boolean;
    headline: string;
    rows: string[];
    footer: { review: boolean; reviewPrimary?: boolean; merge: string | null; mergeNote?: string | null } | null;
  }[] = [
    {
      name: "ready to merge",
      s: {},
      headline: "Ready to merge",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "draft with failing checks, changes requested, unresolved threads",
      s: {
        pr: { draft: true, review: "changes_requested", mergeState: "draft" },
        d: {
          checks: [failed("test"), failed("lint"), running("e2e"), running("e2e2"), check("build"), check("vet"), skipped("notes")],
          reviewers: [reviewer("kim", { state: "changes_requested", requested: true, stale: true }), reviewer("acme/core", { requested: true }), reviewer("ana", { requested: true })],
          reviewThreads: [thread("internal/a/actor.go", 142), thread("b/resize.go", 37, { isOutdated: true }), thread("c.go", 1, { isResolved: true })],
        },
      },
      headline: "Not ready to merge · 4 left",
      rows: [
        "draft draft: Draft",
        "checks failure: 2 checks failing · 2 running · 2 passed · 1 skipped",
        "review failure: Changes requested",
        "conversations pending: 2 unresolved conversations",
        "mergeable success: No conflicts with trunk",
      ],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "changes requested on a ready pull request: auto-merge offered",
      s: { pr: { review: "changes_requested", mergeState: "blocked" }, d: { reviewers: [reviewer("ana", { state: "changes_requested" })], reviewThreads: [thread("x.go", 3)] } },
      headline: "Not ready to merge · 2 left",
      rows: ["checks success: All 2 checks passed", "review failure: Changes requested", "conversations pending: 1 unresolved conversation", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "conflicts: no conflict-free row, Merge stays (disabled), no auto-merge",
      s: { pr: { mergeable: "conflicting", mergeState: "dirty" } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "conflicts failure: Conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "behind (GitHub reports BEHIND): blocks, auto-merge offered",
      s: { pr: { mergeState: "behind" } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "behind pending: Behind trunk", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "checks running, approved: waiting on checks",
      s: { pr: { mergeState: "blocked" }, d: { checks: [running("e2e"), running("test"), check("build")] } },
      headline: "Waiting on checks · 2 running",
      rows: ["checks pending: 2 checks running · 1 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "auto-merge on: headline, Cancel auto-merge",
      s: { pr: { mergeState: "blocked" }, d: { checks: [running("e2e")], autoMergeEnabled: true, autoMergeMethod: "squash" } },
      headline: "Auto-merge on · squash",
      rows: ["checks pending: 1 check running", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "cancel-auto-merge" },
    },
    {
      name: "auto-merge not allowed by the repository (fresh): Merge with the note",
      s: { pr: { mergeState: "blocked" }, d: { checks: [running("e2e")], autoMergeAllowed: false } },
      headline: "Waiting on checks · 1 running",
      rows: ["checks pending: 1 check running", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge", mergeNote: AUTO_MERGE_OFF_NOTE },
    },
    {
      name: "a stale copy (failed fetch) says nothing about auto-merge",
      s: { pr: { mergeState: "blocked" }, d: { checks: [running("e2e")], autoMergeAllowed: false, lastError: "offline", fetchFailed: true } },
      fresh: false,
      headline: "Waiting on checks · 1 running",
      rows: ["checks pending: 1 check running", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge", mergeNote: null },
    },
    {
      name: "a stale copy that allows auto-merge offers none either",
      s: { pr: { mergeState: "blocked" }, d: { checks: [running("e2e")], lastError: "offline", fetchFailed: true } },
      fresh: false,
      headline: "Waiting on checks · 1 running",
      rows: ["checks pending: 1 check running", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "your review is requested: primary Review, no review-required row",
      s: { pr: { author: "kim", review: "review_required", mergeState: "blocked" }, d: { reviewers: [reviewer(VIEWER, { requested: true })] } },
      headline: "Waiting on your review",
      rows: ["checks success: All 2 checks passed", "review-request pending: Your review is requested", "mergeable success: No conflicts with trunk"],
      footer: { review: true, reviewPrimary: true, merge: "auto-merge" },
    },
    {
      name: "review required: waiting on the requested",
      s: { pr: { review: "review_required", mergeState: "blocked" }, d: { reviewers: [reviewer("kim", { requested: true }), reviewer("acme/core", { requested: true })] } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks success: All 2 checks passed", "review pending: Review required", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "reviews not required, none given",
      s: { pr: { review: null }, d: { reviewers: [] } },
      headline: "Ready to merge",
      rows: ["checks success: All 2 checks passed", "review neutral: No reviews yet", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "read access with a workflow waiting for approval: no merge controls, no Review",
      s: { pr: { author: "first-timer", review: null, mergeState: "blocked" }, d: { viewerCanUpdate: false, viewerPermission: "read", reviewers: [], checks: [awaiting("build")] } },
      headline: "You can't merge this · read access",
      rows: ["workflow-approval pending: 1 workflow waiting for approval", "review neutral: No reviews yet", "mergeable success: No conflicts with trunk"],
      footer: { review: false, merge: null },
    },
    {
      name: "read access, your review requested: Review ▾ (primary), no merge controls",
      s: { pr: { author: "kim", review: "review_required", mergeState: "blocked" }, d: { viewerCanUpdate: false, viewerPermission: "read", reviewers: [reviewer(VIEWER, { requested: true })] } },
      headline: "Waiting on your review",
      rows: ["checks success: All 2 checks passed", "review-request pending: Your review is requested", "mergeable success: No conflicts with trunk"],
      footer: { review: true, reviewPrimary: true, merge: null },
    },
    {
      name: "no checks at all",
      s: { d: { checks: [] }, pr: { checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 } } },
      headline: "Ready to merge",
      rows: ["checks neutral: No checks", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "a detail without a check list counts from the rollup",
      s: { d: { checks: [] }, pr: { mergeState: "blocked", checks: { state: "failure", total: 5, passed: 3, failed: 1, pending: 1, skipped: 0 } } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks failure: 1 check failing · 1 running · 3 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "blocked with no reason shown",
      s: { pr: { mergeState: "blocked" } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "mergeable success: No conflicts with trunk", "blocked pending: Blocked by branch protection"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "mergeability not computed yet: checking, no conflict row, Merge as GitHub allows",
      s: { pr: { mergeable: "unknown", mergeState: "unknown" } },
      headline: "Checking mergeability",
      rows: ["checks success: All 2 checks passed", "review success: Approved"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "UNSTABLE: an optional check fails, GitHub merges anyway",
      s: { pr: { mergeState: "unstable" }, d: { checks: [failed("lint"), check("build")] } },
      headline: "Ready to merge · 1 optional check failing",
      rows: ["checks failure: 1 check failing · 1 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "CLEAN with checks still running (none required)",
      s: { d: { checks: [running("e2e"), check("build")] } },
      headline: "Ready to merge · 1 running",
      rows: ["checks pending: 1 check running · 1 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "CLEAN with unresolved conversations (resolving them is not required)",
      s: { d: { reviewThreads: [thread("x.go", 3)] } },
      headline: "Ready to merge · 1 unresolved conversation",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "conversations pending: 1 unresolved conversation", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "HAS_HOOKS with a failing check and a conversation",
      s: { pr: { mergeState: "has_hooks" }, d: { checks: [failed("lint"), failed("vet")], reviewThreads: [thread("x.go", 3), thread("y.go", 4)] } },
      headline: "Ready to merge · 2 optional checks failing · 2 unresolved conversations",
      rows: ["checks failure: 2 checks failing", "review success: Approved", "conversations pending: 2 unresolved conversations", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "BLOCKED with unresolved conversations: they count",
      s: { pr: { mergeState: "blocked" }, d: { reviewThreads: [thread("x.go", 3)] } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks success: All 2 checks passed", "review success: Approved", "conversations pending: 1 unresolved conversation", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "truncated checks: the rollup's counts, not the fetched page's passes",
      s: { pr: { mergeState: "blocked", checks: { state: "failure", total: 120, passed: 60, failed: 50, pending: 10, skipped: 0 } }, d: { checksTruncated: true, checks: [check("a"), check("b"), check("c")] } },
      headline: "Not ready to merge · 1 left",
      rows: ["checks failure: 120+ checks · 50 failing · 10 running · 60 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "truncated checks still running",
      s: { pr: { mergeState: "blocked", checks: { state: "pending", total: 120, passed: 100, failed: 0, pending: 20, skipped: 0 } }, d: { checksTruncated: true, checks: [check("a"), running("b")] } },
      headline: "Waiting on checks · 20 running",
      rows: ["checks pending: 120+ checks · 20 running · 100 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "auto-merge" },
    },
    {
      name: "truncated checks the rollup says passed",
      s: { pr: { checks: { state: "success", total: 120, passed: 120, failed: 0, pending: 0, skipped: 0 } }, d: { checksTruncated: true, checks: [check("a"), check("b")] } },
      headline: "Ready to merge",
      rows: ["checks success: All 120 checks passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "truncated checks without a rollup never claim success",
      s: { pr: { checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 } }, d: { checksTruncated: true, checks: [check("a"), check("b"), check("c")] } },
      headline: "Ready to merge",
      rows: ["checks neutral: 3+ checks · 3 passed", "review success: Approved", "mergeable success: No conflicts with trunk"],
      footer: { review: true, merge: "merge" },
    },
    {
      name: "merged: one row, no footer",
      s: { pr: { state: "merged", mergedAtMs: NOW - 24 * HOUR }, d: { mergedBy: "kim", mergeCommitSha: "3f9c2ab".padEnd(40, "0") } },
      headline: "Merged",
      rows: ["merged merged: Merged into trunk by kim 1d ago"],
      footer: null,
    },
    {
      name: "closed: the end state and the checks as last seen",
      s: { pr: { state: "closed" }, d: { closedAtMs: NOW - 72 * HOUR } },
      headline: "Closed without merging",
      rows: ["closed failure: Closed 3d ago", "checks success: 2 checks passed"],
      footer: null,
    },
  ];
  it.each(cases)("$name", ({ s, viewer = VIEWER, fresh, headline, rows, footer }) => {
    const d = detail(s);
    const r = readiness(d, viewer, fresh ?? detailFresh(d), NOW);
    expect([r.headline.title, r.headline.meta].filter(Boolean).join(" · ")).toBe(headline);
    expect(r.rows.map(brief)).toEqual(rows);
    if (footer === null) expect(r.footer).toBeNull();
    else expect(r.footer).toEqual({ reviewPrimary: false, mergeNote: null, ...footer });
  });
});

describe("readiness rows in detail", () => {
  const rowOf = (d: PullRequestDetailView, id: string, viewer = VIEWER) => readiness(d, viewer, true, NOW).rows.find((r) => r.id === id);

  it("draft: the sub-line, and Ready for review only for those who may change it", () => {
    const d = detail({ pr: { draft: true } });
    expect(rowOf(d, "draft")).toMatchObject({ lines: [{ kind: "text", text: "Reviewers are not notified until it is ready." }], action: { kind: "ready" }, blocking: true, task: null });
    // The author may, without write access.
    expect(rowOf({ ...d, viewerCanUpdate: false }, "draft")?.action).toEqual({ kind: "ready" });
    // Someone else without write access may not.
    expect(rowOf({ ...d, viewerCanUpdate: false }, "draft", "stranger")?.action).toBeNull();
  });

  it("failing checks: named first three, the rest counted; the task slot is checks; expandable", () => {
    const d = detail({ pr: { mergeState: "blocked" }, d: { checks: [failed("a"), failed("b"), failed("c"), failed("d"), check("ok")] } });
    const r = rowOf(d, "checks");
    expect(r?.lines.map(lineText)).toEqual(["check a", "check b", "check c", "and 1 more"]);
    expect(r).toMatchObject({ task: "checks", blocking: true, expandable: true });
    // Optional (UNSTABLE): not blocking, still a task for the thread.
    expect(rowOf({ ...d, pullRequest: { ...d.pullRequest, mergeState: "unstable" } }, "checks")).toMatchObject({ task: "checks", blocking: false });
  });

  it("running checks are named; passing rows hand nothing to a thread", () => {
    expect(rowOf(detail({ pr: { mergeState: "blocked" }, d: { checks: [running("e2e"), check("ok")] } }), "checks")).toMatchObject({ lines: [{ kind: "check", check: { name: "e2e" } }], task: null, blocking: true });
    expect(rowOf(detail({ pr: { mergeState: "clean" }, d: { checks: [running("e2e"), check("ok")] } }), "checks")).toMatchObject({ task: null, blocking: false });
    expect(rowOf(detail(), "checks")).toMatchObject({ task: null, blocking: false, lines: [] });
  });

  it("a workflow awaiting approval is its own row with Approve on GitHub, out of the checks counts", () => {
    const d = detail({ d: { checks: [awaiting("build"), check("lint")] } });
    expect(rowOf(d, "checks")?.title).toBe("1 check passed");
    expect(rowOf(d, "workflow-approval")?.action).toEqual({ kind: "approve-workflow", url: "https://github.com/o/r/pull/7" });
    const withUrl = detail({ d: { checks: [{ ...awaiting("build"), url: "https://ci/run" }] } });
    expect(rowOf(withUrl, "workflow-approval")?.action).toEqual({ kind: "approve-workflow", url: "https://ci/run" });
  });

  it("changes requested: who, then who is still pending (the viewer left out)", () => {
    const d = detail({
      pr: { review: "changes_requested" },
      d: { reviewers: [reviewer("kim", { state: "changes_requested", requested: true }), reviewer("acme/core", { requested: true }), reviewer("ana", { requested: true }), reviewer(VIEWER, { requested: true })] },
    });
    expect(rowOf(d, "review", "other")?.lines.map(lineText)).toEqual(["kim · still waiting on acme/core, ana, me"]);
    expect(rowOf(d, "review")?.lines.map(lineText)).toEqual(["kim · still waiting on acme/core, ana"]);
    expect(rowOf(d, "review")?.task).toBe("review");
  });

  it("approved: who and when; an approval before the last push says so", () => {
    expect(rowOf(detail(), "review")?.lines.map(lineText)).toEqual(["person kim approved 1h ago"]);
    const stale = detail({ d: { reviewers: [reviewer("kim", { state: "approved", submittedAtMs: NOW - HOUR, stale: true })] } });
    expect(rowOf(stale, "review")?.lines.map(lineText)).toEqual(["person kim approved 1h ago · on an older commit"]);
  });

  it("approved with reviewers still requested: who is pending; under BLOCKED that is the blocker", () => {
    const reviewers = [reviewer("kim", { state: "approved", submittedAtMs: NOW - HOUR }), reviewer("acme/owners", { requested: true }), reviewer(VIEWER, { requested: true })];
    const clean = detail({ pr: { author: "kim" }, d: { reviewers } });
    expect(rowOf(clean, "review", "other")).toMatchObject({ tone: "success", blocking: false });
    expect(rowOf(clean, "review", "other")?.lines.map(lineText)).toEqual(["person kim approved 1h ago", "Still waiting on acme/owners, me"]);
    const blocked = detail({ pr: { mergeState: "blocked" }, d: { reviewers: reviewers.slice(0, 2) } });
    expect(rowOf(blocked, "review")).toMatchObject({ tone: "pending", icon: "clock", blocking: true });
    const r = readiness(blocked, VIEWER, true, NOW);
    expect(r.headline).toMatchObject({ title: "Not ready to merge", meta: "1 left" });
    expect(r.rows.some((x) => x.id === "blocked")).toBe(false);
  });

  it("review required with one approval in: more approvals required", () => {
    const d = detail({ pr: { review: "review_required", mergeState: "blocked" }, d: { reviewers: [reviewer("kim", { state: "approved", submittedAtMs: NOW - HOUR }), reviewer("ana", { requested: true })] } });
    expect(rowOf(d, "review")).toMatchObject({ title: "More approvals required", tone: "pending", blocking: true });
    expect(rowOf(d, "review")?.lines.map(lineText)).toEqual(["person kim approved 1h ago", "Waiting on ana"]);
  });

  it("your review is requested: who asked, the review-request task", () => {
    const d = detail({ pr: { author: "kim", review: "review_required", mergeState: "blocked" }, d: { reviewers: [reviewer(VIEWER, { requested: true })] } });
    expect(rowOf(d, "review-request")).toMatchObject({ lines: [{ kind: "text", text: "kim asked for your review" }], task: "review-request", blocking: true });
  });

  it("unresolved conversations: file:line each, outdated flagged, resolved left out", () => {
    const d = detail({ d: { reviewThreads: [thread("internal/a/actor.go", 142), thread("b/resize.go", 37, { isOutdated: true }), thread("c.go", 0), thread("d.go", 4, { isResolved: true })], reviewThreadsTruncated: true } });
    const r = rowOf(d, "conversations");
    expect(r?.title).toBe("3+ unresolved conversations");
    expect(r?.lines.map(lineText)).toEqual(["actor.go:142 · resize.go:37 (outdated) · c.go"]);
    expect(r?.lines[0]).toMatchObject({ items: [{ path: "internal/a/actor.go:142" }, { path: "b/resize.go:37" }, { path: "c.go" }] });
    expect(r?.task).toBe("conversations");
  });

  it("conflicts and behind name the real base and carry their tasks", () => {
    expect(rowOf(detail({ pr: { mergeable: "conflicting" } }), "conflicts")).toMatchObject({ title: "Conflicts with trunk", task: "conflicts", lines: [] });
    expect(rowOf(detail({ pr: { mergeState: "behind" } }), "behind")).toMatchObject({
      title: "Behind trunk",
      task: "behind",
      lines: [{ kind: "text", text: "This repository only merges branches that are up to date with trunk." }],
    });
    // Not BEHIND: nothing about being behind, whatever the base did.
    expect(rowOf(detail({ pr: { mergeState: "clean" } }), "behind")).toBeUndefined();
  });

  it("merged: the merge commit and Revert only with write access", () => {
    const d = detail({ pr: { state: "merged", mergedAtMs: NOW - HOUR }, d: { mergedBy: "kim", mergeCommitSha: "3f9c2ab".padEnd(40, "0") } });
    expect(rowOf(d, "merged")).toMatchObject({ lines: [{ kind: "commit" }], action: { kind: "revert" } });
    expect(rowOf({ ...d, viewerCanUpdate: false }, "merged")?.action).toBeNull();
  });

  it("closed with a failing check hands nothing to a thread", () => {
    expect(rowOf(detail({ pr: { state: "closed" }, d: { checks: [failed("x")] } }), "checks")).toMatchObject({ tone: "failure", task: null, blocking: false });
  });
});

describe("detailFresh and awaitingApproval", () => {
  it.each([
    { fetchFailed: false, want: true },
    // A stale copy is stale whatever it carries (a stored checksTruncated included).
    { fetchFailed: true, want: false },
  ])("fresh: fetchFailed $fetchFailed", ({ fetchFailed, want }) => {
    expect(detailFresh({ fetchFailed })).toBe(want);
  });

  it.each([
    { name: "action required", c: { conclusion: "action_required", status: "completed", description: "" }, want: true },
    { name: "waiting", c: { conclusion: "", status: "waiting", description: "" }, want: true },
    { name: "queued, approval in the description", c: { conclusion: "", status: "queued", description: "Waiting for a maintainer to approve" }, want: true },
    { name: "queued", c: { conclusion: "", status: "queued", description: "" }, want: false },
    { name: "failed", c: { conclusion: "failure", status: "completed", description: "approval" }, want: false },
  ])("$name", ({ c, want }) => {
    expect(awaitingApproval(c)).toBe(want);
  });
});
