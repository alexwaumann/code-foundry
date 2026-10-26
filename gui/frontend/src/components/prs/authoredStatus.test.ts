import { describe, expect, it } from "vitest";
import type { CheckRollupView, PullRequestView } from "@/api/gh";
import { authoredRows, authoredStatus, type AuthoredStatusKind } from "./authoredStatus";

const green: CheckRollupView = { state: "success", total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 };
const failing: CheckRollupView = { state: "failure", total: 3, passed: 2, failed: 1, pending: 0, skipped: 0 };
const running: CheckRollupView = { state: "pending", total: 3, passed: 1, failed: 0, pending: 2, skipped: 0 };
const none: CheckRollupView = { state: "none", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
const kim = { author: "kim", state: "commented", submittedAtMs: 1, commitSha: "" };

/** Approved, green, clean: ready to merge unless the case says otherwise. */
function pr(o: Partial<PullRequestView> = {}): PullRequestView {
  return {
    number: 1,
    draft: false,
    mergeable: "mergeable",
    mergeState: "clean",
    checks: green,
    review: "approved",
    reviewRequests: [],
    latestReviews: [kim],
    updatedAtMs: 1,
    ...o,
  } as PullRequestView;
}

describe("authoredStatus", () => {
  it.each<[string, Partial<PullRequestView>, AuthoredStatusKind, string]>([
    ["conflicting", { mergeable: "conflicting", checks: failing, review: "changes_requested" }, "conflicts", "Conflicts"],
    ["dirty merge state", { mergeState: "dirty" }, "conflicts", "Conflicts"],
    ["a failed check", { checks: failing, review: "changes_requested" }, "ci_failing", "CI failing"],
    ["rollup error without a count", { checks: { ...green, state: "error" } }, "ci_failing", "CI failing"],
    ["changes requested", { review: "changes_requested", mergeState: "behind" }, "changes_requested", "Changes requested"],
    ["behind base", { mergeState: "behind", draft: true }, "behind", "Behind base"],
    ["blocked by something else (branch protection)", { mergeState: "blocked" }, "blocked", "Blocked"],
    ["blocked as a draft", { mergeState: "blocked", draft: true }, "draft", "Draft"],
    ["blocked on a required review, requested", { mergeState: "blocked", review: "review_required", reviewRequests: ["kim", "acme/core"] }, "awaiting_review", "Awaiting review · 2"],
    ["blocked on a required review, nobody asked", { mergeState: "blocked", review: "review_required", latestReviews: [] }, "no_reviewers", "No reviewers"],
    ["blocked on required checks running", { mergeState: "blocked", checks: running, latestReviews: [] , reviewRequests: ["kim"], review: "approved" }, "ci_running", "CI running"],
    ["draft", { draft: true, mergeState: "draft" }, "draft", "Draft"],
    ["awaiting review", { review: "review_required", reviewRequests: ["kim"], mergeState: "clean" }, "awaiting_review", "Awaiting review · 1"],
    ["approved with a request still pending: not awaiting", { reviewRequests: ["kim"] }, "ready", "Ready to merge"],
    ["no reviewers, no decision", { review: null, latestReviews: [] }, "no_reviewers", "No reviewers"],
    ["checks running", { checks: running }, "ci_running", "CI running"],
    ["ready: approved, green, clean", {}, "ready", "Ready to merge"],
    ["ready: no checks, has hooks", { checks: none, mergeState: "has_hooks" }, "ready", "Ready to merge"],
    ["ready: no review required, reviewed, unstable", { review: null, mergeState: "unstable" }, "ready", "Ready to merge"],
    ["merge state not computed yet", { mergeState: "unknown" }, "open", "Open"],
    ["required review with a comment only", { review: "review_required" }, "open", "Open"],
  ])("%s", (_name, o, kind, label) => {
    const s = authoredStatus(pr(o));
    expect([s.kind, s.label]).toEqual([kind, label]);
  });

  it("tones: errors, warnings, success, the rest neutral", () => {
    expect(authoredStatus(pr({ checks: failing })).tone).toBe("error");
    expect(authoredStatus(pr({ mergeState: "behind" })).tone).toBe("warning");
    expect(authoredStatus(pr()).tone).toBe("success");
    expect(authoredStatus(pr({ draft: true, mergeState: "draft" })).tone).toBe("neutral");
  });
});

describe("authoredRows", () => {
  it("action needed first, worst first; then the rest newest updated first", () => {
    const rows = authoredRows([
      pr({ number: 1, updatedAtMs: 90 }), // ready
      pr({ number: 2, updatedAtMs: 10, mergeState: "behind" }),
      pr({ number: 3, updatedAtMs: 80, draft: true, mergeState: "draft" }),
      pr({ number: 4, updatedAtMs: 5, mergeable: "conflicting" }),
      pr({ number: 5, updatedAtMs: 95, checks: running }),
      pr({ number: 6, updatedAtMs: 50, checks: failing }),
      pr({ number: 7, updatedAtMs: null }),
    ]);
    expect(rows.map((r) => r.pr.number)).toEqual([4, 6, 2, 5, 1, 3, 7]);
  });
});
