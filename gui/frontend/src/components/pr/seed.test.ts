import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@/api/gh";
import { prSummary } from "@/test/prWorld";
import { freshestRow, seedDetail, seedReadiness } from "./seed";

const NOW = Date.UTC(2026, 10, 3, 12);
const HOUR = 3_600_000;
const HEAD = "a".repeat(40);

const row = (o: Parameters<typeof prSummary>[4] = {}) => prSummary(NOW, "o/r", 7, "t", { headSha: HEAD, ...o });
const seeded = (pr: PullRequestView, viewer = "me") => seedReadiness(seedDetail(pr), viewer, NOW);
const ids = (pr: PullRequestView, viewer?: string) => seeded(pr, viewer).rows.map((r) => r.id);
const titled = (pr: PullRequestView) => seeded(pr).rows.map((r) => r.title);

describe("seedReadiness", () => {
  it.each<[string, Partial<PullRequestView>, string[]]>([
    ["checks and a required review", { mergeable: "mergeable" }, ["All 12 checks passed", "Review required", "No conflicts with main"]],
    ["a draft", { draft: true, mergeable: null }, ["Draft", "All 12 checks passed", "Review required"]],
    ["failing checks from the rollup alone", { checks: { state: "failure", total: 3, passed: 2, failed: 1, pending: 0, skipped: 0 }, mergeable: null }, ["1 check failing", "Review required"]],
    ["conflicts", { mergeable: "conflicting", mergeState: "dirty" }, ["All 12 checks passed", "Review required", "Conflicts with main"]],
    ["behind", { mergeable: "mergeable", mergeState: "behind" }, ["All 12 checks passed", "Review required", "Behind main", "No conflicts with main"]],
    ["no reason to name for a block: the conversations may be it", { review: "approved", mergeable: null, mergeState: "blocked" }, ["All 12 checks passed", "Approved"]],
  ])("open, %s: the rows the detail would have, no verdict, the footer on its way", (_name, o, want) => {
    const s = seeded(row(o));
    expect(s.rows.map((r) => r.title)).toEqual(want);
    expect(s.headline).toBeNull();
    expect(s.footerPending).toBe(true);
  });

  it("offers nothing: no row has a button or a task, even for the author of a draft with failing checks", () => {
    const s = seeded(row({ author: "me", draft: true, checks: { state: "failure", total: 1, passed: 0, failed: 1, pending: 0, skipped: 0 }, mergeable: "conflicting", reviewRequests: ["me"] }));
    expect(s.rows.map((r) => r.id)).toEqual(["draft", "checks", "review-request", "conflicts"]);
    expect(s.rows.every((r) => r.action === null && r.task === null)).toBe(true);
  });

  it("a merged or a closed one is settled: its headline shows, with no footer to wait for, and Revert waits", () => {
    const merged = seeded(row({ mergedAgoMs: HOUR }));
    expect(merged.headline?.title).toBe("Merged");
    expect(merged.footerPending).toBe(false);
    expect(merged.rows.map((r) => [r.title, r.action])).toEqual([["Merged into main 1h ago", null]]);
    const closed = seeded(row({ state: "closed", mergeable: null, mergeState: "" }));
    expect(closed.headline?.title).toBe("Closed without merging");
    expect(closed.footerPending).toBe(false);
    expect(titled(row({ state: "closed", mergeState: "" }))).toEqual(["Closed", "12 checks passed"]);
  });

  it("a row stored from the summary only says nothing of reviews or mergeability: it would claim No reviews yet", () => {
    expect(ids(row({ mergeState: "", review: null, mergeable: null, draft: true }))).toEqual(["draft", "checks"]);
  });

  it("the viewer's own request reads as the detail's would; a review on an older commit says so", () => {
    expect(ids(row({ reviewRequests: ["ME"] }))).toEqual(["checks", "review-request", "mergeable"]);
    const approved = seeded(row({ review: "approved", latestReviews: [{ author: "kim", state: "approved", submittedAtMs: NOW - HOUR, commitSha: "b".repeat(40) }] })).rows.find((r) => r.id === "review");
    expect(approved?.lines).toEqual([{ kind: "person", login: "kim", avatarUrl: "", tone: "success", text: "kim approved 1h ago · on an older commit" }]);
  });
});

describe("seedDetail", () => {
  it("grants nothing, and builds the reviewers: requests first, a re-requested one once, a team as a team", () => {
    const d = seedDetail(row({ reviewRequests: ["acme/core", "kim"], latestReviews: [{ author: "Kim", state: "changes_requested", submittedAtMs: NOW, commitSha: HEAD }, { author: "lee", state: "approved", submittedAtMs: NOW, commitSha: "" }] }));
    expect(d.viewerCanUpdate).toBe(false);
    expect(d.mergeMethods).toEqual([]);
    expect(d.reviewers.map((r) => [r.login, r.isTeam, r.state, r.requested, r.stale])).toEqual([
      ["acme/core", true, "", true, false],
      ["Kim", false, "changes_requested", true, false],
      ["lee", false, "approved", false, true],
    ]);
  });
});

describe("freshestRow", () => {
  const key = "o/r#7";
  it.each<[string, PullRequestView[][], number | null]>([
    ["none", [[]], null],
    ["another number", [[prSummary(NOW, "o/r", 8, "t")]], null],
    ["a partial row is no row", [[row({ partial: true })]], null],
    ["an unknown state is no row", [[row({ state: "unknown" })]], null],
    ["the slug's case does not matter", [[prSummary(NOW, "O/R", 7, "t", { ageMs: 5 })]], NOW - 5],
    ["the fresher of two lists: the search that lagged a merge loses", [[row({ ageMs: 9 })], [row({ ageMs: 2 })]], NOW - 2],
  ])("%s", (_name, lists, updated) => {
    expect(freshestRow(lists, key)?.updatedAtMs ?? null).toBe(updated);
  });
});
