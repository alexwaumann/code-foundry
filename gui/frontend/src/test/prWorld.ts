/**
 * The mock daemon's pull request world (mock/prDetail.ts, mock/github.ts) as view models, for
 * component tests of the Pull request surface and the Pull Requests page: the details of #145
 * (open, draft, failing checks, threads, reviewers), #138 (merged, revertable), #131 (closed),
 * #140 (read access only), #142 (mergeable), #146 (from a fork) and #139 (a teammate's,
 * awaiting the viewer's review), the reviewer candidates, the dashboard, and the pr.* commands
 * changing them the way the mock does. Pair with src/test/daemonFakes.ts:
 *
 *   vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
 *   vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
 *
 * then `seedPrWorld()` in beforeEach. Nothing here imports a store or a mocked module, so the
 * factories may import it; the stores are reset by the test (resetPrStores in prStores.ts).
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { CommandView } from "@/api/command";
import type {
  CheckRollupView,
  CheckView,
  DashboardView,
  PullRequestCommentView,
  PullRequestDetailView,
  PullRequestReviewerView,
  PullRequestView,
  ReviewerCandidateView,
  ReviewerCandidatesView,
  ReviewStateView,
  ReviewThreadView,
  StatsView,
} from "@/api/gh";
import { matchesReviewerSearch, reviewerSearchTokens } from "@/components/pr/reviewerSearch";
import { daemon, needsConfirm, type Invocation } from "./daemonFakes";

export const SLUG = "alexwaumann/code-foundry";
export const GP_SLUG = "alexwaumann/ghostty-playground";
export const VIEWER = "alexwaumann";
export const HEAD_142 = "5eb1d0a142000000000000000000000000000000";
export const HEAD_146 = "f04c146000000000000000000000000000000000";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const avatar = (login: string) => `https://avatars.example.com/${login.replace("/", "-")}.png`;
const key = (slug: string, number: number) => `${slug.toLowerCase()}#${String(number)}`;

const rollup = (state: CheckRollupView["state"], passed: number, failed = 0, pending = 0, skipped = 0): CheckRollupView => ({ state, total: passed + failed + pending + skipped, passed, failed, pending, skipped });

/** One OK result. */
const OK = { message: "", resultJson: "" };

/** A pull request summary built like the mock's GhWorld.pr. */
export function prSummary(t0: number, repoSlug: string, number: number, title: string, o: Partial<PullRequestView> & { ageMs?: number; mergedAgoMs?: number } = {}): PullRequestView {
  const { ageMs = 3 * HOUR, mergedAgoMs, ...rest } = o;
  const merged = mergedAgoMs !== undefined;
  return {
    repoSlug,
    number,
    title,
    author: VIEWER,
    url: `https://github.com/${repoSlug}/pull/${String(number)}`,
    state: merged ? "merged" : "open",
    draft: false,
    headRef: `branch-${String(number)}`,
    headSha: "",
    baseRef: "main",
    baseSha: "",
    review: "review_required",
    checks: rollup("success", 12),
    createdAtMs: t0 - ageMs - DAY,
    updatedAtMs: t0 - ageMs,
    mergedAtMs: merged ? t0 - mergedAgoMs : null,
    mergeable: merged ? null : "mergeable",
    mergeState: merged ? "" : "blocked",
    additions: 10 * number,
    deletions: number,
    changedFiles: 3,
    comments: 2,
    reviews: 1,
    latestReviews: [],
    reviewRequests: [],
    isCrossRepository: false,
    headRepoSlug: "",
    partial: false,
    ...rest,
  };
}

function detailBase(pr: PullRequestView, t0: number): PullRequestDetailView {
  return {
    pullRequest: pr,
    body: "",
    labels: [],
    labelsTruncated: false,
    reviewers: [],
    reviewersTruncated: false,
    commits: [],
    commitCount: 0,
    comments: [],
    commentsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
    checks: [],
    checksTruncated: false,
    mergeCommitSha: "",
    mergedBy: "",
    closedAtMs: null,
    nodeId: `PR_kwMock${String(pr.number)}`,
    viewerCanUpdate: true,
    mergeMethods: ["merge", "squash", "rebase"],
    autoMergeEnabled: false,
    defaultBranch: "main",
    viewerPermission: "admin",
    fetchedAtMs: t0 - 20_000,
    lastError: "",
  };
}

function reviewer(login: string, o: Partial<PullRequestReviewerView> = {}): PullRequestReviewerView {
  return { login, isTeam: false, isBot: false, avatarUrl: avatar(login), state: "", submittedAtMs: null, requested: false, stale: false, ...o };
}

function comment(t0: number, prNumber: number, kind: PullRequestCommentView["kind"], id: string, author: string, body: string, agoMs: number, o: Partial<PullRequestCommentView> = {}): PullRequestCommentView {
  return { id, kind, author, authorIsBot: false, authorAvatarUrl: avatar(author), body, createdAtMs: t0 - agoMs, url: `https://github.com/${SLUG}/pull/${String(prNumber)}#${id}`, path: "", reviewState: "", reviewId: "", ...o };
}

function check(t0: number, name: string, workflow: string, status: string, conclusion: string, o: { url?: string; startedAgo?: number; completedAgo?: number; description?: string } = {}): CheckView {
  return {
    name,
    workflow,
    url: o.url ?? "",
    conclusion,
    status,
    description: o.description ?? "",
    startedAtMs: o.startedAgo === undefined ? null : t0 - o.startedAgo,
    completedAtMs: o.completedAgo === undefined ? null : t0 - o.completedAgo,
  };
}

function commit(t0: number, sha: string, headline: string, agoMs: number, author = VIEWER, name = "Alex") {
  return { sha, shortSha: sha.slice(0, 7), headline, authorLogin: author, authorName: name, committedAtMs: t0 - agoMs };
}

/** #145: open, draft, 7 checks (2 failing), changes requested by a stale and re-requested reviewer, 3 review threads. */
function openDetail(t0: number, pr: PullRequestView): PullRequestDetailView {
  const c = (kind: PullRequestCommentView["kind"], id: string, author: string, body: string, ago: number, o: Partial<PullRequestCommentView> = {}) => comment(t0, 145, kind, id, author, body, ago, o);
  const run = (n: number) => `https://github.com/${SLUG}/actions/runs/1/job/${String(n)}`;
  const thread = (id: string, path: string, line: number, side: "left" | "right", resolved: boolean, outdated: boolean, comments: PullRequestCommentView[]): ReviewThreadView => ({ id, path, line, side, isResolved: resolved, isOutdated: outdated, comments, commentsTruncated: false });
  return {
    ...detailBase(pr, t0),
    body: [
      "## Summary",
      "",
      "Attach could race the first output chunk and size the terminal from a stale snapshot.",
      "This moves the resize into the terminal actor and replays it after the snapshot.",
      "",
      "## Test plan",
      "",
      "- [x] `go test ./internal/store/terminal/...`",
      "- [ ] resize a thread while it prints (manual)",
    ].join("\n"),
    labels: [
      { name: "bug", color: "d73a4a" },
      { name: "terminal", color: "0e8a16" },
    ],
    reviewers: [
      reviewer("teammate-kim", { state: "changes_requested", submittedAtMs: t0 - 3 * HOUR, stale: true, requested: true }),
      reviewer("acme/core", { isTeam: true, requested: true }),
      reviewer("teammate-ana", { requested: true }),
      reviewer("coderabbitai", { isBot: true, state: "commented", submittedAtMs: t0 - 6 * HOUR, stale: true }),
    ],
    reviewersTruncated: true,
    commits: [
      commit(t0, "5a1e0c3d2b9f8e7d6c5b4a39281706f5e4d3c2b1", "fix(terminal): size from the attach snapshot", 9 * HOUR),
      commit(t0, "6b2f1d4e3c0a9f8e7d6c5b4a39281706f5e4d3c2", "test(terminal): resize during first output", 7 * HOUR),
      commit(t0, "7c3a2e5f4d1b0a9f8e7d6c5b4a39281706f5e4d3", "refactor(terminal): resize inside the actor", 4 * HOUR),
      commit(t0, "8d4b3f6a5e2c1b0a9f8e7d6c5b4a39281706f5e4", "fix(terminal): replay resize after snapshot", 2 * HOUR),
    ],
    commitCount: 4,
    comments: [
      c("review", "PRR_bot", "coderabbitai", "**Walkthrough**\n\nThe resize now happens on the actor goroutine. 2 actionable comments.", 6 * HOUR, { authorIsBot: true, reviewState: "commented" }),
      c("issue_comment", "IC_1", "teammate-kim", "Does this also fix the flicker when the sidebar collapses?", 5 * HOUR),
      c("issue_comment", "IC_2", VIEWER, "Partly: the flicker had a second cause in the layout pass. Follow-up PR.", 4 * HOUR),
      c("issue_comment", "IC_ghost", "", "Same race shows up on Linux under load.", 3.5 * HOUR, { authorAvatarUrl: "" }),
      c("review", "PRR_kim", "teammate-kim", "The replay can still drop a resize that arrives during the snapshot. See inline.", 3 * HOUR, { reviewState: "changes_requested" }),
    ],
    reviewThreads: [
      thread("PRRT_1", "internal/store/terminal/actor.go", 214, "right", false, false, [
        c("review_comment", "PRRC_1", "teammate-kim", "A resize queued while `snapshot()` runs is overwritten here.", 3 * HOUR, { path: "internal/store/terminal/actor.go", reviewId: "PRR_kim" }),
        c("review_comment", "PRRC_2", VIEWER, "Good catch. Keeping the last pending size instead.", 2 * HOUR, { path: "internal/store/terminal/actor.go", reviewId: "PRR_reply" }),
      ]),
      thread("PRRT_2", "internal/store/terminal/attach.go", 88, "right", false, false, [
        c("review_comment", "PRRC_3", "coderabbitai", "Consider returning the error from `Resize` instead of logging it.", 6 * HOUR, { authorIsBot: true, path: "internal/store/terminal/attach.go", reviewId: "PRR_bot" }),
      ]),
      thread("PRRT_3", "internal/store/terminal/terminal.go", 40, "left", true, true, [
        c("review_comment", "PRRC_4", "teammate-kim", "Why remove the size check?", 8 * HOUR, { path: "internal/store/terminal/terminal.go", reviewId: "PRR_kim_old" }),
      ]),
    ],
    checks: [
      check(t0, "test (macos-15)", "CI", "completed", "failure", { url: run(11), startedAgo: 100 * MIN, completedAgo: 92 * MIN }),
      check(t0, "lint", "CI", "completed", "failure", { url: run(12), startedAgo: 100 * MIN, completedAgo: 98 * MIN }),
      check(t0, "build", "CI", "completed", "success", { url: run(13), startedAgo: 100 * MIN, completedAgo: 95 * MIN }),
      check(t0, "test (ubuntu-24.04)", "CI", "completed", "success", { url: run(14), startedAgo: 100 * MIN, completedAgo: 90 * MIN }),
      check(t0, "e2e (webkit)", "CI", "in_progress", "", { url: run(15), startedAgo: 10 * MIN }),
      check(t0, "e2e (chromium)", "CI", "queued", "", { url: run(16) }),
      check(t0, "release-notes", "Release", "completed", "skipped", { startedAgo: 100 * MIN, completedAgo: 100 * MIN }),
    ],
    nodeId: "PR_kwMock145",
  };
}

/** #138: merged with a merge commit, approved; revertable. */
function mergedDetail(t0: number, pr: PullRequestView): PullRequestDetailView {
  const c = (kind: PullRequestCommentView["kind"], id: string, author: string, body: string, ago: number, o: Partial<PullRequestCommentView> = {}) => comment(t0, 138, kind, id, author, body, ago, o);
  return {
    ...detailBase(pr, t0),
    body: "## Summary\n\nEvery GitHub request goes through one worker with a minimum gap, so bursts cannot trip the secondary rate limit.",
    labels: [{ name: "chore", color: "c5def5" }],
    reviewers: [reviewer("teammate-kim", { state: "approved", submittedAtMs: t0 - DAY - 2 * HOUR })],
    commits: [commit(t0, "1f0e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6", "chore(gh): one worker for every request", 2 * DAY), commit(t0, "2a1f3e4d5c6b7a8998a7b6c5d4e3f2a1b0c9d8e7", "test(gh): pacing", DAY + 5 * HOUR)],
    commitCount: 2,
    comments: [c("review", "PRR_ok", "teammate-kim", "LGTM", DAY + 2 * HOUR, { reviewState: "approved" }), c("issue_comment", "IC_m1", VIEWER, "Merging; the 1s gap is in the note.", DAY + HOUR)],
    reviewThreads: [
      {
        id: "PRRT_m1",
        path: "internal/store/gh/pace.go",
        line: 31,
        side: "right",
        isResolved: true,
        isOutdated: false,
        comments: [c("review_comment", "PRRC_m1", "teammate-kim", "Jitter here too?", DAY + 3 * HOUR, { path: "internal/store/gh/pace.go", authorAvatarUrl: "" })],
        commentsTruncated: false,
      },
    ],
    checks: ["build", "lint", "test (macos-15)"].map((n) => check(t0, n, "CI", "completed", "success", { startedAgo: DAY + 4 * HOUR, completedAgo: DAY + 3 * HOUR })),
    mergeCommitSha: "3c3c4651aa0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d",
    mergedBy: VIEWER,
    closedAtMs: pr.mergedAtMs,
    mergeMethods: [],
    nodeId: "PR_kwMock138",
  };
}

function closedDetail(t0: number): PullRequestDetailView {
  const pr = prSummary(t0, SLUG, 131, "feat(gui): tabbed terminals (superseded by split panes)", { headRef: "feat/tabs", state: "closed", ageMs: 4 * DAY, checks: rollup("success", 2) });
  return {
    ...detailBase(pr, t0),
    body: "Superseded by the split pane layout; closing.",
    commits: [commit(t0, "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d", "feat(gui): terminal tabs", 5 * DAY)],
    commitCount: 1,
    comments: [comment(t0, 131, "issue_comment", "IC_c1", VIEWER, "Closing in favour of split panes.", 4 * DAY)],
    checks: [check(t0, "build", "CI", "completed", "success", { startedAgo: 5 * DAY, completedAgo: 5 * DAY - 4 * MIN }), check(t0, "test (macos-15)", "CI", "completed", "success", { startedAgo: 5 * DAY, completedAgo: 5 * DAY - 9 * MIN })],
    closedAtMs: t0 - 4 * DAY,
    mergeMethods: [],
  };
}

function readOnlyDetail(t0: number): PullRequestDetailView {
  const pr = prSummary(t0, SLUG, 140, "docs: contributing guide", { author: "outside-contrib", headRef: "docs/contributing", ageMs: 2 * DAY, checks: rollup("pending", 0, 0, 1) });
  return {
    ...detailBase(pr, t0),
    body: "Adds CONTRIBUTING.md.",
    reviewers: [reviewer("teammate-kim", { requested: true })],
    commits: [commit(t0, "4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a", "docs: contributing guide", 2 * DAY, "outside-contrib", "Contributor")],
    commitCount: 1,
    checks: [check(t0, "build", "CI", "queued", "", { description: "Waiting for a maintainer to approve the workflow run" })],
    viewerCanUpdate: false,
    viewerPermission: "read",
  };
}

function forkDetail(t0: number): PullRequestDetailView {
  const pr = prSummary(t0, SLUG, 146, "fix(cli): typo in --help", { author: "outside-contrib", headRef: "patch-1", headSha: HEAD_146, isCrossRepository: true, review: "approved", mergeState: "clean", ageMs: 6 * HOUR, checks: rollup("success", 1) });
  return {
    ...detailBase(pr, t0),
    body: "Fixes a typo.",
    commits: [commit(t0, HEAD_146, "fix(cli): typo in --help", 6 * HOUR, "outside-contrib", "Contributor")],
    commitCount: 1,
    checks: [check(t0, "build", "CI", "completed", "success", { startedAgo: 6 * HOUR, completedAgo: 6 * HOUR - 3 * MIN })],
  };
}

/** A minimal detail from a listed pull request's summary (the mock's fromSummary). */
function fromSummary(t0: number, pr: PullRequestView): PullRequestDetailView {
  return {
    ...detailBase(pr, t0),
    reviewers: pr.reviewRequests.map((login) => reviewer(login, { isTeam: login.includes("/"), requested: true })),
    viewerCanUpdate: pr.author === VIEWER,
    viewerPermission: pr.author === VIEWER ? "admin" : "read",
    mergedBy: pr.state === "merged" ? pr.author : "",
    closedAtMs: pr.mergedAtMs,
  };
}

/** The mock's dashboard lists (mock/github.ts reset). */
function dashboardLists(t0: number) {
  const pr = (slug: string, n: number, title: string, o: Parameters<typeof prSummary>[4] = {}) => prSummary(t0, slug, n, title, o);
  const sha = (tag: string) => tag.padEnd(40, "0");
  return {
    authored: [
      pr(SLUG, 142, "feat(gui): virtualized sidebar tree with thread rows", { headRef: "feat/sidebar", headSha: HEAD_142, review: "approved", mergeState: "clean", checks: rollup("success", 31, 0, 0, 2), ageMs: 40 * MIN }),
      pr(SLUG, 145, "fix(terminal): resize race between attach and first output", { headRef: "fix/resize", draft: true, review: "changes_requested", checks: rollup("failure", 2, 2, 2, 1), ageMs: 5 * HOUR }),
      pr(GP_SLUG, 12, "renderer: port glyph cache to the new atlas", { headRef: "atlas", checks: rollup("pending", 9, 0, 4), reviewRequests: ["teammate-kim"], ageMs: 2 * DAY }),
    ],
    reviewRequested: [
      pr(SLUG, 139, "feat(thread): JSONL transcript discovery", { author: "teammate-kim", headRef: "jsonl", checks: rollup("success", 30), reviewRequests: [VIEWER], ageMs: 3 * HOUR }),
      pr("other-org/lib", 77, "chore: bump deps", { author: "renovate", checks: rollup("success", 4), reviewRequests: ["other-org/maintainers"], ageMs: 6 * HOUR }),
    ],
    reviewed: [
      pr(SLUG, 133, "refactor(api): one events stream", { author: "teammate-kim", headRef: "events", headSha: sha("133"), latestReviews: [{ author: VIEWER, state: "approved", submittedAtMs: t0 - 10 * HOUR, commitSha: sha("133") }], ageMs: 9 * HOUR }),
      pr(GP_SLUG, 14, "renderer: subpixel glyph positioning", { author: "teammate-kim", headRef: "subpixel", headSha: sha("14b"), latestReviews: [{ author: VIEWER, state: "changes_requested", submittedAtMs: t0 - DAY, commitSha: sha("14a") }], ageMs: 4 * HOUR }),
      pr("other-org/lib", 81, "feat: streaming parser", { author: "someone", headRef: "stream", headSha: sha("81"), checks: rollup("failure", 3, 1), latestReviews: [{ author: VIEWER, state: "changes_requested", submittedAtMs: t0 - 2 * DAY, commitSha: sha("81") }], ageMs: 2 * DAY }),
    ],
    recentlyMerged: [
      pr(SLUG, 138, "chore(gh): pace requests through one worker", { headRef: "gh-pacing", mergedAgoMs: DAY, ageMs: DAY }),
      pr(SLUG, 136, "fix(repo): ignore Chmod-only fs events", { author: "teammate-kim", headRef: "kqueue-chmod", mergedAgoMs: 2 * DAY, ageMs: 2 * DAY }),
      pr(GP_SLUG, 10, "build: zig 0.16", { headRef: "zig-016", mergedAgoMs: 6 * DAY, ageMs: 6 * DAY }),
      pr("other-org/lib", 70, "docs: README", { author: "someone", mergedAgoMs: 3 * DAY, ageMs: 3 * DAY }),
    ],
  };
}

/** The mock's activity stats: the last six months, newest first. */
function stats(t0: number, rows: [number, number][]): StatsView {
  const d = new Date(t0);
  const months = rows.map(([commits, merged], i) => {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    return { month: `${String(m.getFullYear())}-${String(m.getMonth() + 1).padStart(2, "0")}`, commits, merged };
  });
  return { months, commitsSource: "search", fetchedAtMs: t0 - 8_000, lastError: "" };
}

interface Candidate {
  kind: "user" | "team";
  login: string;
  name: string;
  isRequested?: boolean;
}

/** The rest of the organization: 120 assignable users, "ada-abbott" … "zoe-zimmerman". */
const ORG_MEMBERS: readonly Candidate[] = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Zoe"].flatMap((first) =>
  ["Abbott", "Brook", "Castro", "Dunn", "Ellis", "Fox", "Grant", "Hale", "Ito", "Zimmerman"].map((last) => ({ kind: "user" as const, login: `${first}-${last}`.toLowerCase(), name: `${first} ${last}` })),
);

/** Names stored "Last, First"; outside-olga has no access (GitHub takes her request without adding her). */
const STORED_LAST_FIRST: readonly Candidate[] = [
  { kind: "user", login: "jdoe", name: "Doe, Jane" },
  { kind: "user", login: "zdoe", name: "Doerr, Janelle" },
  { kind: "user", login: "outside-olga", name: "Outside, Olga" },
];
const NO_ACCESS = new Set(["outside-olga"]);

/** The daemon's search rank (mock/prDetail.ts searchRank). */
function searchRank(c: Candidate, term: string): number | null {
  const words = reviewerSearchTokens(term);
  if (words.length < 2) {
    const q = term.toLowerCase();
    return c.login.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) ? 0 : null;
  }
  if (!matchesReviewerSearch(c.login, c.name, term)) return null;
  const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const tokens = words.map(fold).filter((t) => t !== "");
  if (tokens.some((t) => fold(c.login).startsWith(t))) return 0;
  const nameWords = c.name.split(/[^\p{L}\p{N}']+/u).map(fold);
  return tokens.every((t) => nameWords.some((w) => w.startsWith(t))) ? 1 : 2;
}

const titles: Record<string, string> = {
  "pr.refresh": "Refresh Pull Request",
  "pr.review.request": "Request Review",
  "pr.revert": "Revert Pull Request",
  "pr.merge": "Merge Pull Request",
  "pr.review": "Review Pull Request",
  "pr.comment": "Comment on Pull Request",
  "pr.ask": "Ask About Pull Request",
  "pr.explain": "Explain Pull Request",
  "pr.fix.findings": "Fix Pull Request Findings",
};

/** The pr.* commands as CommandService.List returns them (their titles name a failure's toast). */
export const PR_COMMANDS: CommandView[] = Object.entries(titles).map(([name, title]) => ({ name, title, description: "", category: "Pull Request", args: [], keybindings: [], available: true }));

const methodWords: Record<string, string> = { merge: "a merge commit", squash: "squash", rebase: "rebase" };
const reviewVerdicts: Record<string, { state: ReviewStateView; done: string; own?: string }> = {
  approve: { state: "approved", done: "Approved #%d", own: "Review Can not approve your own pull request" },
  "request-changes": { state: "changes_requested", done: "Requested changes on #%d", own: "Review Can not request changes on your own pull request" },
  comment: { state: "commented", done: "Commented on #%d (review)" },
};

/**
 * The world: details by key, candidates, the dashboard, and the mock's controls (failNext,
 * hold) as methods. Every pr.* handler is registered in daemonFakes' daemon by seedPrWorld.
 */
export class PrWorld {
  readonly t0 = Date.now();
  readonly details = new Map<string, PullRequestDetailView>();
  readonly candidates = new Map<string, Candidate[]>();
  dashboard: DashboardView;
  /** Reads of the dashboard (GetDashboard) and of a detail (GetPullRequestDetail), by key. */
  readonly reads = { dashboard: 0, detail: new Map<string, number>(), candidates: [] as string[] };
  /** Commands whose next run fails (the mock's POST /__mock/gh/pr-fail?command=…). */
  readonly failNext = new Set<string>();
  private readonly holds = new Map<string, Promise<void>>();
  private readonly memos = new Map<string, ConnectError | true>();
  private readonly reverts = new Map<string, number>();
  private nextNumber = 151;
  private nextThread = 1;
  /** Detail keys whose next read fails with this error (a poll error). */
  readonly readErrors = new Map<string, Error>();

  constructor() {
    const t0 = this.t0;
    const lists = dashboardLists(t0);
    this.dashboard = {
      viewer: { login: VIEWER, name: "Alex", url: `https://github.com/${VIEWER}` },
      authenticated: true,
      ...lists,
      dashboardsDisabled: false,
      stats: stats(t0, [
        [16, 2],
        [463, 38],
        [210, 17],
        [96, 9],
        [0, 0],
        [41, 3],
      ]),
      fetchedAtMs: t0 - 8_000,
      lastError: "",
      trackedSlugs: [SLUG, GP_SLUG],
    };
    const find = (n: number) => [...lists.authored, ...lists.reviewRequested, ...lists.recentlyMerged].find((p) => p.repoSlug === SLUG && p.number === n);
    const set = (d: PullRequestDetailView) => this.details.set(key(d.pullRequest.repoSlug, d.pullRequest.number), d);
    const pr145 = find(145);
    const pr138 = find(138);
    const pr142 = find(142);
    const pr139 = find(139);
    if (pr145) set(openDetail(t0, pr145));
    if (pr138) set(mergedDetail(t0, pr138));
    set(closedDetail(t0));
    set(readOnlyDetail(t0));
    set(forkDetail(t0));
    if (pr142) set(fromSummary(t0, pr142));
    if (pr139) set({ ...fromSummary(t0, pr139), reviewers: [reviewer(VIEWER, { requested: true })], viewerCanUpdate: true, viewerPermission: "write" });
    this.candidates.set(key(SLUG, 145), [
      { kind: "team", login: "acme/core", name: "Core", isRequested: true },
      { kind: "user", login: "teammate-ana", name: "Ana", isRequested: true },
      { kind: "user", login: "teammate-kim", name: "Kim", isRequested: true },
      { kind: "user", login: "teammate-lee", name: "Lee" },
      { kind: "user", login: "teammate-max", name: "" },
      ...STORED_LAST_FIRST.map((m) => ({ ...m })),
      ...ORG_MEMBERS.map((m) => ({ ...m })),
    ]);
  }

  /** The detail of a pull request, or undefined. */
  detail(n: number, slug = SLUG): PullRequestDetailView | undefined {
    return this.details.get(key(slug, n));
  }

  /** Replaces a detail (by its pull request's key), as a poll would. */
  update(n: number, f: (d: PullRequestDetailView) => PullRequestDetailView, slug = SLUG): void {
    const d = this.detail(n, slug);
    if (d) this.details.set(key(slug, n), f(d));
  }

  /**
   * Makes command's runs wait until the returned release is called (the mock's
   * POST /__mock/gh/pr-delay, without the clock). Release once for all held runs.
   */
  hold(command: string): () => void {
    let release!: () => void;
    this.holds.set(
      command,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    return () => {
      this.holds.delete(command);
      release();
    };
  }

  private async gate(command: string): Promise<void> {
    const h = this.holds.get(command);
    if (h) await h;
  }

  readDetail(slug: string, number: number): PullRequestDetailView {
    const k = key(slug, number);
    this.reads.detail.set(k, (this.reads.detail.get(k) ?? 0) + 1);
    const err = this.readErrors.get(k);
    if (err) throw err;
    const d = this.details.get(k);
    // getPullRequestDetail marks NOT_FOUND this way (api/gh.ts).
    if (!d) throw new Error(`not found: Could not resolve to a PullRequest with the number of ${String(number)}.`);
    return d;
  }

  /** The pending requests, then (for a query) up to 20 people matching it, as the mock lists them. */
  listCandidates(slug: string, number: number, query: string): ReviewerCandidatesView {
    const q = query.trim();
    this.reads.candidates.push(q);
    const list = this.candidateList(slug, number);
    const byLogin = (a: Candidate, b: Candidate) => a.login.localeCompare(b.login);
    const requested = list.filter((c) => c.isRequested).sort(byLogin);
    const found =
      q === ""
        ? []
        : list
            .filter((c) => c.kind !== "team")
            .map((c) => ({ c, rank: searchRank(c, q) }))
            .filter((x): x is { c: Candidate; rank: number } => x.rank !== null)
            .slice(0, 20)
            .filter((x) => !x.c.isRequested)
            .sort((a, b) => a.rank - b.rank || byLogin(a.c, b.c))
            .map((x) => x.c);
    const view = (c: Candidate): ReviewerCandidateView => ({ id: `${c.kind === "team" ? "T" : "U"}_${c.login}`, kind: c.kind, login: c.login, name: c.name, avatarUrl: avatar(c.login), isRequested: c.isRequested ?? false });
    return { candidates: [...requested, ...found].map(view) };
  }

  private candidateList(slug: string, number: number): Candidate[] {
    const k = key(slug, number);
    let list = this.candidates.get(k);
    if (!list) {
      const author = this.details.get(k)?.pullRequest.author ?? "";
      list = ["teammate-ana", "teammate-kim", "teammate-lee", VIEWER].filter((l) => l !== author).map((login): Candidate => ({ kind: "user", login, name: "" }));
      list.push(...ORG_MEMBERS.map((m) => ({ ...m })));
      this.candidates.set(k, list);
    }
    return list;
  }

  private target(inv: Invocation): [string, number, PullRequestDetailView] {
    const slug = inv.args["repo-slug"] ?? "";
    const n = Number(inv.args.number);
    const d = this.details.get(key(slug, n));
    if (!d) throw new ConnectError(`Could not resolve to a PullRequest with the number of ${String(n)}.`, Code.NotFound);
    return [slug, n, d];
  }

  private refuse(why: string): ConnectError {
    return new ConnectError(`failed precondition: ${why}`, Code.FailedPrecondition);
  }

  /** Registers the pr.* commands' handlers and their titles in daemonFakes' daemon. */
  install(): void {
    daemon.commands = [...daemon.commands.filter((c) => !c.name.startsWith("pr.")), ...PR_COMMANDS];
    const h = daemon.handlers;
    h.set("pr.refresh", (inv) => {
      const [, n, d] = this.target(inv);
      if (this.failNext.delete("pr.refresh")) throw new ConnectError(`refresh #${String(n)} failed, the cached copy is unchanged: github graphql: 502 Bad Gateway`, Code.Unavailable);
      this.details.set(key(d.pullRequest.repoSlug, n), { ...d, fetchedAtMs: Date.now() });
      // No detail in the result: the store reads the (fresh) cache again.
      return { message: `Refreshed #${String(n)}: ${d.pullRequest.title}`, resultJson: "" };
    });
    h.set("pr.review.request", (inv) => {
      const [slug, n, d] = this.target(inv);
      const login = (inv.args.login ?? "").trim();
      const requested = inv.args.requested !== "false";
      const isTeam = inv.args.kind === "team";
      if (requested && NO_ACCESS.has(login.toLowerCase())) throw this.refuse(`GitHub did not add ${login} as a reviewer (they may lack access to the repository)`);
      const list = this.candidateList(slug, n);
      let cand = list.find((c) => c.login === login);
      if (!cand) {
        cand = { kind: isTeam ? "team" : "user", login, name: "" };
        list.push(cand);
      }
      cand.isRequested = requested;
      let reviewers = d.reviewers.map((r) => (r.login === login ? { ...r, requested } : r));
      if (requested && !reviewers.some((r) => r.login === login)) reviewers = [reviewer(login, { isTeam, requested: true }), ...reviewers];
      this.details.set(key(slug, n), { ...d, reviewers: reviewers.filter((r) => r.requested || r.state !== "") });
      return { message: requested ? `Requested a review from ${login} on #${String(n)}` : `Withdrew the review request for ${login} on #${String(n)}`, resultJson: "" };
    });
    h.set("pr.revert", (inv) => {
      const [slug, n, d] = this.target(inv);
      if (!inv.confirmed) throw needsConfirm({ command: "pr.revert", title: titles["pr.revert"], message: `This opens a new pull request that reverses the changes merged by #${String(n)}.` });
      const done = this.reverts.get(key(slug, n));
      const made = done ?? this.nextNumber++;
      if (done === undefined) {
        if (d.pullRequest.state !== "merged") throw this.refuse(`pull request #${String(n)} is ${d.pullRequest.state}, not merged`);
        this.reverts.set(key(slug, n), made);
        const pr: PullRequestView = { ...d.pullRequest, number: made, title: `Revert "${d.pullRequest.title}"`, author: VIEWER, url: `https://github.com/${slug}/pull/${String(made)}`, state: "open", headRef: `revert-${String(n)}-${d.pullRequest.headRef}`, mergedAtMs: null, createdAtMs: Date.now(), updatedAtMs: Date.now() };
        this.details.set(key(slug, made), fromSummary(this.t0, pr));
        this.dashboard = { ...this.dashboard, authored: [pr, ...this.dashboard.authored] };
      }
      const url = `https://github.com/${slug}/pull/${String(made)}`;
      return { message: `Opened #${String(made)} to revert #${String(n)}: ${url}`, resultJson: JSON.stringify({ number: made, url }) };
    });
    h.set("pr.merge", async (inv) => {
      const [slug, n, d] = this.target(inv);
      const pr = d.pullRequest;
      const method = inv.args.method ?? "";
      if (!inv.confirmed) {
        let msg = `Merge #${String(n)} “${pr.title}” into ${pr.baseRef} in ${slug} with ${methodWords[method] ?? method}?`;
        if (inv.args["delete-branch"] === "true" && !pr.isCrossRepository) msg += ` Branch origin/${pr.headRef} is deleted afterwards.`;
        throw needsConfirm({ command: "pr.merge", title: titles["pr.merge"], message: msg });
      }
      await this.gate("pr.merge");
      if (pr.state !== "open") throw this.refuse(`pull request #${String(n)} is ${pr.state}, not open`);
      if (this.failNext.delete("pr.merge")) throw this.refuse(`pull request #${String(n)} changed on GitHub since it was loaded (${pr.headRef} has new commits); refresh and review it before merging`);
      const sha = `e2e${String(n).padStart(4, "0")}${"0".repeat(33)}`;
      const merged: PullRequestView = { ...pr, state: "merged", mergedAtMs: Date.now(), updatedAtMs: Date.now(), mergeable: null, mergeState: "" };
      this.details.set(key(slug, n), { ...d, pullRequest: merged, mergeCommitSha: sha, mergedBy: VIEWER, closedAtMs: Date.now() });
      const dash = this.dashboard;
      this.dashboard = { ...dash, authored: dash.authored.filter((p) => !(p.repoSlug === slug && p.number === n)), recentlyMerged: [merged, ...dash.recentlyMerged] };
      let message = `Merged #${String(n)} (${sha.slice(0, 7)})`;
      if (inv.args["delete-branch"] === "true") message += pr.isCrossRepository ? `; kept ${pr.headRef}: it is in a fork` : `; deleted origin/${pr.headRef}`;
      return { message, resultJson: JSON.stringify({ merged: true, sha, message, branchDeleted: !pr.isCrossRepository && inv.args["delete-branch"] === "true" }) };
    });
    h.set("pr.review", async (inv) => {
      const [slug, n, d] = this.target(inv);
      const v = reviewVerdicts[inv.args.verdict ?? ""];
      if (!v) throw new ConnectError("verdict must be approve, request-changes, or comment", Code.InvalidArgument);
      await this.gate("pr.review");
      const body = (inv.args.body ?? "").trim();
      // The daemon's write memo: the same text within 2 minutes gets the first answer.
      const memo = `${key(slug, n)}|${inv.args.verdict ?? ""}|${body}`;
      const was = this.memos.get(memo);
      if (was instanceof ConnectError) throw was;
      if (this.failNext.delete("pr.review")) {
        const err = new ConnectError(`pull request #${String(n)}: GitHub did not confirm the review, and it may have been posted; check GitHub before trying again: github graphql: 502 Bad Gateway`, Code.Unavailable);
        this.memos.set(memo, err);
        throw err;
      }
      if (v.own && d.pullRequest.author === VIEWER) throw this.refuse(v.own);
      const now = Date.now();
      const id = `PRR_mock_${String(n)}_${String(d.comments.length + 1)}`;
      const added = comment(this.t0, n, "review", id, VIEWER, body, this.t0 - now, { reviewState: v.state });
      const rest = d.reviewers.filter((r) => r.login !== VIEWER);
      const reviewers = [...rest.filter((r) => r.requested), reviewer(VIEWER, { state: v.state, submittedAtMs: now }), ...rest.filter((r) => !r.requested)];
      this.details.set(key(slug, n), { ...d, comments: [...d.comments, added], reviewers, fetchedAtMs: now });
      this.memos.set(memo, true);
      return { message: v.done.replace("%d", String(n)), resultJson: "" };
    });
    const startThread = (kind: "pr.ask" | "pr.explain" | "pr.fix.findings") => async (inv: Invocation) => {
      const [slug, n] = this.target(inv);
      await this.gate(kind);
      if (this.failNext.delete(kind)) {
        throw kind === "pr.fix.findings"
          ? new ConnectError(`#${String(n)} comes from a fork and no worktree of ${slug} has its head checked out: check it out (for example \`gh pr checkout ${String(n)}\` in a worktree) and pass --worktree`, Code.FailedPrecondition)
          : new ConnectError(`read #${String(n)}: github graphql: 502 Bad Gateway`, Code.Unavailable);
      }
      const id = `s-new-${String(this.nextThread++)}`;
      return { message: `Started thread ${id} for PR #${String(n)}`, resultJson: JSON.stringify({ id }) };
    };
    h.set("pr.ask", startThread("pr.ask"));
    h.set("pr.explain", startThread("pr.explain"));
    h.set("pr.fix.findings", startThread("pr.fix.findings"));
    h.set("view.open.url", () => OK);
  }
}

/** The world the fakes read; seedPrWorld replaces it. */
export let prWorld = new PrWorld();

/** A fresh world with its command handlers installed (call after resetDaemon, in beforeEach). */
export function seedPrWorld(): PrWorld {
  prWorld = new PrWorld();
  prWorld.install();
  return prWorld;
}

/** GhService reads against prWorld (spread over the real @/api/gh in vi.mock). */
export const prGhFakes = {
  getPullRequestDetail: (slug: string, number: number): Promise<PullRequestDetailView> => {
    try {
      return Promise.resolve(structuredClone(prWorld.readDetail(slug, number)));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
  listReviewerCandidates: (slug: string, number: number, query: string): Promise<ReviewerCandidatesView> => Promise.resolve(prWorld.listCandidates(slug, number, query)),
  getDashboard: (): Promise<DashboardView> => {
    prWorld.reads.dashboard++;
    return Promise.resolve(structuredClone(prWorld.dashboard));
  },
  getViewer: () => Promise.resolve({ login: VIEWER, name: "Alex", url: `https://github.com/${VIEWER}` }),
};
