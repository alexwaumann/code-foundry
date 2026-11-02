import { describe, expect, it } from "vitest";
import type { DashboardView, ProjectPullRequestsView, PullRequestView } from "@/api/gh";
import { prSummary, seedPrWorld, SLUG, VIEWER } from "@/test/prWorld";
import type { AuthoredRow, AuthoredStatusKind } from "./authoredStatus";
import {
  authoredSubtitle,
  cards,
  liveFilter,
  mergedCounts,
  mergedRows,
  mergedSubtitle,
  needsSubtitle,
  olderFreshness,
  otherRows,
  otherStatus,
  pageModel,
  prId,
  sectionRows,
  type MergedRowModel,
} from "./pageModel";
import type { NeedsRow, NeedsWhy } from "./reviewQueue";

const T0 = Date.UTC(2026, 10, 2, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GP = "alexwaumann/ghostty-playground";
const OTHER = "other-org/lib";

const pr = (n: number, o: Parameters<typeof prSummary>[4] = {}, slug = SLUG): PullRequestView => prSummary(T0, slug, n, `pr ${String(n)}`, { author: "someone", ...o });
const nums = (rows: readonly { pr: PullRequestView }[]) => rows.map((r) => r.pr.number);
const list = (prs: PullRequestView[], totalCount = prs.length): ProjectPullRequestsView => ({ pullRequests: prs, totalCount, searchUrl: "https://github.com/search?q=x" });
const ok = { state: "success", total: 4, passed: 4, failed: 0, pending: 0, skipped: 0 } as const;

describe("otherStatus", () => {
  it.each<[string, Parameters<typeof prSummary>[4], AuthoredStatusKind, string]>([
    ["approved and green", { review: "approved", mergeState: "clean", checks: ok }, "ready", "Approved"],
    ["mergeable, no review required, reviewed", { review: null, mergeState: "clean", checks: ok, latestReviews: [{ author: "kim", state: "commented", submittedAtMs: T0, commitSha: "" }] }, "ready", "Mergeable"],
    ["draft", { draft: true, review: "review_required", mergeState: "blocked", checks: ok }, "draft", "Draft"],
    ["awaiting two reviewers", { reviewRequests: ["kim", "lee"], mergeState: "blocked", checks: ok }, "awaiting_review", "Awaiting review · 2"],
    ["nobody asked", { review: null, mergeState: "clean", checks: { ...ok, total: 0, passed: 0, state: "none" } }, "no_reviewers", "No reviewers"],
    ["changes requested", { review: "changes_requested", mergeState: "blocked", checks: ok }, "changes_requested", "Changes requested"],
    ["CI failing", { review: "approved", mergeState: "unstable", checks: { ...ok, failed: 1, passed: 3, state: "failure" } }, "ci_failing", "CI failing"],
    ["conflicts", { review: "approved", mergeable: "conflicting", mergeState: "dirty", checks: ok }, "conflicts", "Conflicts"],
  ])("%s", (_name, o, kind, label) => {
    const s = otherStatus(pr(1, o));
    expect([s.kind, s.label]).toEqual([kind, label]);
  });

  it("an author's own ready pull request still reads Ready to merge on the authored table", async () => {
    const { authoredStatus } = await import("./authoredStatus");
    expect(authoredStatus(pr(1, { review: "approved", mergeState: "clean", checks: ok })).label).toBe("Ready to merge");
  });
});

describe("otherRows", () => {
  it("drops what the viewer's own lists show and repeats, newest updated first", () => {
    const open = [pr(1, { ageMs: 3 * HOUR }), pr(2, { ageMs: HOUR }), pr(3, { ageMs: 2 * HOUR }), pr(1, { ageMs: 3 * HOUR }), pr(2, { ageMs: HOUR }, GP)];
    // #3 is in the review queue already (GitHub's index lagged); the slug case does not matter.
    const rows = otherRows(open, new Set([prId({ repoSlug: SLUG.toUpperCase(), number: 3 })]));
    expect(rows.map((r) => `${r.pr.repoSlug}#${String(r.pr.number)}`)).toEqual([`${SLUG}#2`, `${GP}#2`, `${SLUG}#1`]);
  });
});

describe("mergedRows / mergedCounts", () => {
  const mine = [pr(10, { mergedAgoMs: DAY }), pr(70, { mergedAgoMs: 3 * DAY }, OTHER)];
  const project = [pr(10, { mergedAgoMs: DAY }), pr(11, { mergedAgoMs: 2 * DAY }), pr(12, { mergedAgoMs: 5 * DAY })];

  it("the union, deduplicated, newest merge first; only the viewer's own are involved", () => {
    const rows = mergedRows(mine, project);
    expect(rows.map((r) => [r.pr.number, r.involved])).toEqual([
      [10, true],
      [11, false],
      [70, true],
      [12, false],
    ]);
  });

  const rows = mergedRows(mine, project);
  const mineHidden: MergedRowModel[] = [...rows, { pr: pr(13, { mergedAgoMs: 6 * DAY }), involved: true }];
  it.each<[string, MergedRowModel[], ProjectPullRequestsView, { involved: number; more: number }]>([
    ["uncapped: the rows", rows, list(project), { involved: 2, more: 2 }],
    ["capped: plus GitHub's hidden matches", rows, list(project, 10), { involved: 2, more: 9 }],
    // #13 is the viewer's, in a tracked repository, and not in the capped list: one of GitHub's 7 hidden.
    ["capped: less the viewer's own among them", mineHidden, list(project, 10), { involved: 3, more: 8 }],
    ["capped by one that is the viewer's", mineHidden, list(project, 4), { involved: 3, more: 2 }],
    // The viewer's merges outnumber the hidden ones (index lag): never fewer than the rows shown.
    ["never undercounts the rows", [...mineHidden, { pr: pr(14), involved: true }], list(project, 4), { involved: 4, more: 2 }],
  ])("%s", (_name, r, p, want) => {
    expect(mergedCounts(r, p, [SLUG, GP])).toEqual(want);
  });

  it("an untracked repository's merges are never among the project search's hidden ones", () => {
    const untracked: MergedRowModel[] = [...rows, { pr: pr(71, {}, OTHER), involved: true }];
    expect(mergedCounts(untracked, list(project, 10), [SLUG, GP])).toEqual({ involved: 3, more: 9 });
  });
});

describe("subtitles", () => {
  const needs = (...whys: NeedsWhy[]): NeedsRow[] => whys.map((why, i) => ({ pr: pr(i + 1), why }));
  it.each<[NeedsRow[], string]>([
    [[], "nothing waiting on you"],
    [needs("requested", "requested_team", "new_commits"), "2 requested · 1 re-review"],
    [needs("requested"), "1 requested"],
    [needs("dismissed", "new_commits"), "2 re-review"],
  ])("needs %#: %s", (rows, want) => {
    expect(needsSubtitle(rows)).toBe(want);
  });

  const authored = (...kinds: [AuthoredStatusKind, number][]): AuthoredRow[] => kinds.map(([kind, rank], i) => ({ pr: pr(i + 1), status: { kind, rank, label: kind, tone: "neutral" } }));
  it.each<[AuthoredRow[], string]>([
    [[], "none open"],
    [authored(["ready", 10], ["ci_failing", 2]), "1 CI failing · 1 ready to merge"],
    // Ready to merge comes before what waits on others; action needed before it.
    [authored(["awaiting_review", 7], ["awaiting_review", 7], ["draft", 6], ["ready", 10]), "1 ready to merge · 1 draft"],
    [authored(["ci_failing", 2], ["awaiting_review", 7], ["ready", 10]), "1 CI failing · 1 ready to merge"],
    [authored(["awaiting_review", 7], ["awaiting_review", 7], ["draft", 6]), "1 draft · 2 awaiting review"],
    [authored(["conflicts", 1]), "1 with conflicts"],
  ])("authored %#: %s", (rows, want) => {
    expect(authoredSubtitle(rows)).toBe(want);
  });

  it.each([
    [4, 3, false, "4 involving you · 3 more"],
    [4, 3, true, "4 involving you · 3 more in your projects"],
    [0, 5, true, "5 more in your projects"],
    [2, 0, false, "2 involving you"],
    [0, 0, false, "nothing this week"],
  ])("merged %d + %d (long %s): %s", (a, b, long, want) => {
    expect(mergedSubtitle(a, b, long)).toBe(want);
  });
});

describe("pageModel", () => {
  const base = (): DashboardView => seedPrWorld().dashboard;

  it("the mock's dashboard: counts, cards and the rows of the new sections", () => {
    const m = pageModel(base());
    expect(m.counts).toEqual({ review: 3, reviewed: 2, authored: 3, else: 5, merged: 7 });
    expect(nums(m.others)).toEqual([148, 149, 16, 15, 144]);
    expect(m.others.map((r) => r.status.label)).toEqual(["Awaiting review · 2", "Draft", "Approved", "No reviewers", "Blocked"]);
    expect(m.merged.map((r) => [r.pr.number, r.involved])).toEqual([
      [138, true],
      [137, false],
      [136, true],
      [70, true],
      [135, false],
      [11, false],
      [10, true],
    ]);
    expect(cards(m).map((c) => [c.label, c.count, c.subtitle, c.warn])).toEqual([
      ["Needs your review", 3, "2 requested · 1 re-review", true],
      ["Reviewed by you", 2, "open, waiting on the author", false],
      ["Your pull requests", 3, "1 CI failing · 1 ready to merge", false],
      ["Everything else open", 5, "in your projects, for awareness", false],
      ["Merged · 7 days", 7, "4 involving you · 3 more", false],
    ]);
    expect([m.othersCap, m.mergedCap]).toEqual([null, null]);
  });

  it("capped lists: the counts use GitHub's totals and the caps say so", () => {
    const d = base();
    const m = pageModel({ ...d, projectOpen: { ...d.projectOpen, totalCount: 116 }, projectMerged: { ...d.projectMerged, pullRequests: d.projectMerged.pullRequests.slice(0, 3), totalCount: 64 } });
    // Shown: the five others; 111 more beyond the cap.
    expect(m.counts.else).toBe(116);
    expect(m.othersCap).toEqual({ shown: 5, total: 116, searchUrl: d.projectOpen.searchUrl });
    // The first three project merges (138, 137, 136): #10 is the viewer's, tracked, not returned: it is among the 61 hidden.
    expect(m.mergedCap?.shown).toBe(3);
    expect([m.mergedInvolved, m.mergedMore]).toEqual([4, 1 + 61 - 1]);
    expect(m.counts.merged).toBe(4 + 61);
  });

  it("a pull request already in the viewer's lists is not repeated in everything else", () => {
    const d = base();
    const dup = d.reviewRequested[0] as PullRequestView;
    const m = pageModel({ ...d, projectOpen: list([...d.projectOpen.pullRequests, dup, d.authored[0] as PullRequestView]) });
    expect(nums(m.others)).toEqual([148, 149, 16, 15, 144]);
    expect(m.counts.else).toBe(5);
  });

  it("an empty section has no rows, and a filter on it is dropped", () => {
    const d = base();
    const m = pageModel({ ...d, viewer: { login: VIEWER, name: "", url: "" }, reviewRequested: [], reviewed: [], projectOpen: list([]) });
    expect([sectionRows(m, "review"), sectionRows(m, "reviewed"), sectionRows(m, "else")]).toEqual([0, 0, 0]);
    expect(cards(m)[0]?.warn).toBe(false);
    expect(liveFilter(m, "else")).toBeNull();
    expect(liveFilter(m, "merged")).toBe("merged");
    expect(liveFilter(m, null)).toBeNull();
  });
});

describe("olderFreshness", () => {
  it.each([
    ["the older time", { fetchedAtMs: 5000, lastError: "" }, { fetchedAtMs: 3000, lastError: "" }, { fetchedAtMs: 3000, lastError: "" }],
    ["the dashboard's when older", { fetchedAtMs: 2000, lastError: "" }, { fetchedAtMs: 3000, lastError: "" }, { fetchedAtMs: 2000, lastError: "" }],
    ["projects never fetched: the dashboard's", { fetchedAtMs: 5000, lastError: "" }, { fetchedAtMs: null, lastError: "" }, { fetchedAtMs: 5000, lastError: "" }],
    ["dashboard never fetched", { fetchedAtMs: null, lastError: "" }, { fetchedAtMs: 3000, lastError: "" }, { fetchedAtMs: null, lastError: "" }],
    ["the dashboard's error first", { fetchedAtMs: 5000, lastError: "a" }, { fetchedAtMs: 3000, lastError: "b" }, { fetchedAtMs: 3000, lastError: "a" }],
    ["else the projects' error", { fetchedAtMs: 5000, lastError: "" }, { fetchedAtMs: 3000, lastError: "b" }, { fetchedAtMs: 3000, lastError: "b" }],
  ])("%s", (_name, a, b, want) => {
    expect(olderFreshness(a, b)).toEqual(want);
  });
});
