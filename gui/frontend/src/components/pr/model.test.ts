import { describe, expect, it } from "vitest";
import type { CheckRollupView, PullRequestCommentView, PullRequestDetailView, PullRequestView, ReviewThreadView } from "@/api/gh";
import { ago, checkDuration, checkMeta, checkRunning, checksHeadline, checkTone, commentCount, conversation, resolveLink, reviewerStatus, stateBadge, threadLocation, timeline } from "./model";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const M = 60_000;
const H = 60 * M;
const D = 24 * H;

const rollup = (o: Partial<CheckRollupView>): CheckRollupView => ({ state: "success", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, ...o });

describe("checksHeadline", () => {
  it.each([
    ["no checks", rollup({ state: "none" }), "neutral", "No checks"],
    ["all passed", rollup({ total: 12, passed: 12 }), "success", "All checks passed"],
    ["passed with skipped", rollup({ total: 5, passed: 3, skipped: 2 }), "success", "All checks passed"],
    ["failing wins over pending", rollup({ state: "failure", total: 28, failed: 2, pending: 3 }), "failure", "2 failing"],
    ["failure state without counts", rollup({ state: "error", total: 1 }), "failure", "Checks failing"],
    ["failure state, only pending counted", rollup({ state: "failure", total: 3, pending: 3 }), "failure", "Checks failing"],
    ["pending", rollup({ state: "pending", total: 9, pending: 4 }), "pending", "4 pending"],
    ["expected", rollup({ state: "expected", total: 1 }), "pending", "Checks pending"],
  ] as const)("%s", (_name, r, tone, text) => {
    expect(checksHeadline(r)).toEqual({ tone, text });
  });
});

describe("stateBadge", () => {
  it.each([
    ["open", false, "Open", "success"],
    ["open", true, "Draft", "draft"],
    ["merged", false, "Merged", "merged"],
    ["closed", false, "Closed", "failure"],
    ["unknown", false, "Unknown", "neutral"],
  ] as const)("%s draft=%s -> %s", (state, draft, label, tone) => {
    expect(stateBadge({ state, draft })).toEqual({ label, tone });
  });
});

describe("checkTone and checkDuration", () => {
  it.each([
    ["success", "completed", "success"],
    ["failure", "completed", "failure"],
    ["timed_out", "completed", "failure"],
    ["cancelled", "completed", "failure"],
    ["skipped", "completed", "skipped"],
    ["neutral", "completed", "skipped"],
    ["", "in_progress", "pending"],
    ["", "queued", "pending"],
    ["", "", "pending"],
  ])("%s/%s -> %s", (conclusion, status, want) => {
    expect(checkTone({ conclusion, status })).toBe(want);
  });

  it.each([
    [null, null, ""],
    [NOW - 92 * 1000, NOW, "1m 32s"],
    [NOW - 10 * M, null, "10m 0s"],
    [NOW - 2 * H - 5 * M, NOW - 5 * M, "2h 0m"],
  ])("started %s completed %s -> %s", (startedAtMs, completedAtMs, want) => {
    expect(checkDuration({ startedAtMs, completedAtMs }, NOW)).toBe(want);
  });

  it.each([
    ["skipped, zero length", { conclusion: "skipped", status: "completed", startedAtMs: NOW - M, completedAtMs: NOW - M }, "skipped"],
    ["neutral", { conclusion: "neutral", status: "completed", startedAtMs: null, completedAtMs: null }, "skipped"],
    ["passed", { conclusion: "success", status: "completed", startedAtMs: NOW - 92 * 1000, completedAtMs: NOW }, "1m 32s"],
    ["running", { conclusion: "", status: "in_progress", startedAtMs: NOW - 10 * M, completedAtMs: null }, "10m 0s"],
    ["queued", { conclusion: "", status: "queued", startedAtMs: null, completedAtMs: null }, "queued"],
    ["in progress, not started", { conclusion: "", status: "in_progress", startedAtMs: null, completedAtMs: null }, "in progress"],
  ])("checkMeta %s -> %s", (_name, c, want) => {
    expect(checkMeta(c, NOW)).toBe(want);
  });

  it.each([
    [{ status: "in_progress", startedAtMs: NOW, completedAtMs: null }, true],
    [{ status: "queued", startedAtMs: null, completedAtMs: null }, false],
    [{ status: "completed", startedAtMs: NOW - M, completedAtMs: NOW }, false],
  ])("checkRunning %j -> %s", (c, want) => {
    expect(checkRunning(c)).toBe(want);
  });
});

describe("ago", () => {
  it.each([
    [null, ""],
    [NOW - 20 * 1000, "just now"],
    [NOW - 36 * M, "36m ago"],
    [NOW - 5 * H, "5h ago"],
    [NOW - 3 * D, "3d ago"],
    [NOW - 20 * D, "2w ago"],
    [NOW - 90 * D, "3mo ago"],
    [NOW - 800 * D, "2y ago"],
  ])("%s -> %s", (ms, want) => {
    expect(ago(ms, NOW)).toBe(want);
  });
});

describe("reviewerStatus", () => {
  it.each([
    [{ state: "approved", requested: false, stale: false }, "approved", "Approved"],
    [{ state: "changes_requested", requested: true, stale: true }, "changes_requested", "Requested changes · review requested again · on an older commit"],
    [{ state: "commented", requested: false, stale: true }, "commented", "Commented · on an older commit"],
    [{ state: "dismissed", requested: false, stale: false }, "dismissed", "Review dismissed"],
    [{ state: "", requested: true, stale: false }, "requested", "Review requested"],
    [{ state: "", requested: false, stale: false }, "none", ""],
  ] as const)("%j", (r, status, label) => {
    expect(reviewerStatus(r)).toEqual({ status, label });
  });
});

const comment = (id: string, atMs: number | null, o: Partial<PullRequestCommentView> = {}): PullRequestCommentView => ({
  id,
  kind: "issue_comment",
  author: "kim",
  authorIsBot: false,
  authorAvatarUrl: "",
  body: id,
  createdAtMs: atMs,
  url: "",
  path: "",
  reviewState: "",
  reviewId: "",
  ...o,
});

const thread = (id: string, comments: PullRequestCommentView[]): ReviewThreadView => ({ id, path: "a.go", line: 3, side: "right", isResolved: false, isOutdated: false, comments, commentsTruncated: false });

describe("conversation", () => {
  const d = {
    comments: [comment("c1", NOW - 5 * H), comment("r1", NOW - 3 * H, { kind: "review", reviewState: "approved" }), comment("cx", null)],
    reviewThreads: [thread("t1", [comment("tc1", NOW - 4 * H), comment("tc2", NOW - H)]), thread("t0", [])],
  };
  it.each([
    ["newest", ["c:r1", "t:t1", "c:c1", "c:cx", "t:t0"]],
    ["oldest", ["c:c1", "t:t1", "c:r1", "c:cx", "t:t0"]],
  ] as const)("%s first; unknown times last", (order, keys) => {
    expect(conversation(d, order).map((i) => i.key)).toEqual(keys);
  });

  it("counts comments, reviews and every thread comment", () => {
    expect(commentCount(d)).toBe(5);
  });

  it.each([
    [{ path: "a.go", line: 214 }, "a.go:214"],
    [{ path: "a.go", line: 0 }, "a.go"],
  ])("threadLocation %j", (t, want) => {
    expect(threadLocation(t)).toBe(want);
  });
});

const pr = (o: Partial<PullRequestView>): PullRequestView =>
  ({ state: "open", author: "alex", createdAtMs: NOW - 2 * D, mergedAtMs: null, ...o }) as PullRequestView;

describe("timeline", () => {
  const commits = [
    { sha: "aaa", shortSha: "aaa", headline: "first", authorLogin: "alex", authorName: "Alex", committedAtMs: NOW - D },
    { sha: "bbb", shortSha: "bbb", headline: "second", authorLogin: "alex", authorName: "Alex", committedAtMs: NOW - 2 * H },
  ];
  const comments = [comment("c1", NOW - 5 * H), comment("r1", NOW - 2 * H, { kind: "review", reviewState: "approved" })];
  type In = Pick<PullRequestDetailView, "pullRequest" | "commits" | "comments" | "mergedBy" | "closedAtMs">;
  const cases: [string, In, "newest" | "oldest", string[]][] = [
    ["open, newest first; a review outranks a commit at the same time", { pullRequest: pr({}), commits, comments, mergedBy: "", closedAtMs: null }, "newest", ["r:r1", "k:bbb", "c:c1", "k:aaa", "opened"]],
    ["open, oldest first", { pullRequest: pr({}), commits, comments, mergedBy: "", closedAtMs: null }, "oldest", ["opened", "k:aaa", "c:c1", "k:bbb", "r:r1"]],
    ["merged first", { pullRequest: pr({ state: "merged", mergedAtMs: NOW - H }), commits, comments: [], mergedBy: "alex", closedAtMs: NOW - H }, "newest", ["merged", "k:bbb", "k:aaa", "opened"]],
    ["closed without merging", { pullRequest: pr({ state: "closed" }), commits: [], comments: [], mergedBy: "", closedAtMs: NOW - H }, "newest", ["closed", "opened"]],
    ["merged at an unknown time is still the latest", { pullRequest: pr({ state: "merged" }), commits, comments: [], mergedBy: "", closedAtMs: null }, "newest", ["merged", "k:bbb", "k:aaa", "opened"]],
    ["closed at an unknown time is still the latest", { pullRequest: pr({ state: "closed" }), commits: [], comments: [], mergedBy: "", closedAtMs: null }, "newest", ["closed", "opened"]],
    ["closed at an unknown time, oldest first", { pullRequest: pr({ state: "closed" }), commits, comments: [], mergedBy: "", closedAtMs: null }, "oldest", ["opened", "k:aaa", "k:bbb", "closed"]],
  ];
  it.each(cases)("%s", (_name, d, order, keys) => {
    expect(timeline(d, order).map((e) => e.key)).toEqual(keys);
  });

  it("carries the merger", () => {
    const [first] = timeline({ pullRequest: pr({ state: "merged", mergedAtMs: NOW }), commits: [], comments: [], mergedBy: "kim", closedAtMs: null });
    expect(first).toMatchObject({ kind: "merged", actor: "kim", atMs: NOW });
  });
});

describe("resolveLink", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["#section", null],
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://example.com", "http://example.com/"],
    ["/alexwaumann/code-foundry/issues/3", "https://github.com/alexwaumann/code-foundry/issues/3"],
    ["javascript:alert(1)", null],
    ["file:///etc/passwd", null],
    ["mailto:a@b.c", null],
  ])("%s -> %s", (href, want) => {
    expect(resolveLink(href)).toBe(want);
  });
});
