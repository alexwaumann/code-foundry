import { describe, expect, it } from "vitest";
import type { PullRequestView, ReviewEntryView } from "@/api/gh";
import { needsReviewCount, reviewQueue, type NeedsWhy, type Verdict } from "./reviewQueue";

const HEAD = "h".repeat(40);
const OLD = "o".repeat(40);

const review = (author: string, state: string, commitSha = HEAD): ReviewEntryView => ({ author, state, submittedAtMs: 1, commitSha });

function pr(number: number, o: Partial<PullRequestView> = {}): PullRequestView {
  return { repoSlug: "o/r", number, headSha: HEAD, updatedAtMs: 1000 - number, reviewRequests: [], latestReviews: [], ...o } as PullRequestView;
}

describe("reviewQueue: requested", () => {
  it.each<[string, string[], string, NeedsWhy]>([
    ["named", ["Me", "acme/core"], "me", "requested"],
    ["team only", ["acme/core"], "me", "requested_team"],
    ["requests unknown", [], "me", "requested"],
    ["viewer unknown", ["acme/core"], "", "requested"],
  ])("%s", (_name, reviewRequests, viewer, why) => {
    const q = reviewQueue([pr(1, { reviewRequests })], [], viewer);
    expect(q.needs.map((r) => r.why)).toEqual([why]);
    expect(q.reviewed).toEqual([]);
  });
});

describe("reviewQueue: reviewed", () => {
  it.each<[string, Partial<PullRequestView>, { needs: NeedsWhy } | { verdict: Verdict }]>([
    ["approved on the head", { latestReviews: [review("ME", "approved")] }, { verdict: "approved" }],
    ["changes requested on the head", { latestReviews: [review("me", "changes_requested")] }, { verdict: "changes_requested" }],
    ["commented on the head", { latestReviews: [review("me", "commented")] }, { verdict: "commented" }],
    ["pending reads as commented", { latestReviews: [review("me", "pending")] }, { verdict: "commented" }],
    ["no review of mine", { latestReviews: [review("kim", "approved", OLD)] }, { verdict: "commented" }],
    ["approved on an older commit", { latestReviews: [review("me", "approved", OLD)] }, { needs: "new_commits" }],
    ["review without a commit (force-pushed away)", { latestReviews: [review("me", "approved", "")] }, { needs: "new_commits" }],
    ["dismissed on the head", { latestReviews: [review("me", "dismissed")] }, { needs: "dismissed" }],
    ["dismissed on an older commit: new commits first", { latestReviews: [review("me", "dismissed", OLD)] }, { needs: "new_commits" }],
    ["head unknown: not stale", { headSha: "", latestReviews: [review("me", "approved", OLD)] }, { verdict: "approved" }],
  ])("%s", (_name, o, want) => {
    const q = reviewQueue([], [pr(1, o)], "me");
    if ("needs" in want) {
      expect(q.needs.map((r) => r.why)).toEqual([want.needs]);
      expect(q.reviewed).toEqual([]);
    } else {
      expect(q.reviewed.map((r) => r.verdict)).toEqual([want.verdict]);
      expect(q.needs).toEqual([]);
    }
  });
});

describe("reviewQueue: merging and order", () => {
  it("a requested pull request also in reviewed is listed once, as requested", () => {
    const p = pr(1, { reviewRequests: ["me"], latestReviews: [review("me", "approved", OLD)] });
    const q = reviewQueue([p], [p], "me");
    expect(q.needs.map((r) => [r.pr.number, r.why])).toEqual([[1, "requested"]]);
    expect(q.reviewed).toEqual([]);
  });

  it("both lists newest updated first; unknown times last", () => {
    const q = reviewQueue(
      [pr(1, { updatedAtMs: 10 }), pr(2, { updatedAtMs: null })],
      [pr(3, { updatedAtMs: 30, latestReviews: [review("me", "approved", OLD)] }), pr(4, { updatedAtMs: 5, latestReviews: [review("me", "approved")] }), pr(5, { updatedAtMs: 50, latestReviews: [review("me", "commented")] })],
      "me",
    );
    expect(q.needs.map((r) => r.pr.number)).toEqual([3, 1, 2]);
    expect(q.reviewed.map((r) => r.pr.number)).toEqual([5, 4]);
    expect(needsReviewCount([pr(1)], [pr(3, { latestReviews: [review("me", "approved", OLD)] }), pr(4, { latestReviews: [review("me", "approved")] })], "me")).toBe(2);
  });
});
