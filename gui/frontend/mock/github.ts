/**
 * Mock GhService dashboards/activity/branch PRs and ProjectService.GetWorktreeDetail data
 * (Phase 3a). Deterministic, relative to the time the world was reset. Paths match
 * world.ts's projects.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { ArgType } from "../src/gen/codefoundry/v1/command_pb";
import { EventSource } from "../src/gen/codefoundry/v1/events_pb";
import {
  CheckConclusion,
  CheckRollupState,
  CheckStatus,
  Mergeable,
  MergeStateStatus,
  PullRequestReviewState,
  PullRequestState,
  ReviewDecision,
  type DefaultBranchStatusSchema,
  type GhEventSchema,
  type ActivityStatsSchema,
} from "../src/gen/codefoundry/v1/gh_pb";
import type { ProjectEventSchema, WorktreeDetailSchema } from "../src/gen/codefoundry/v1/project_pb";
import { PrDetailWorld } from "./prDetail";
import { PrDiffWorld } from "./prDiff";

/** Plain init shapes (no $typeName arm), so spreads stay assignable to the RPC responses. */
export interface PrInit {
  repoSlug: string;
  number: number;
  title: string;
  author: string;
  url: string;
  state: PullRequestState;
  draft?: boolean;
  headRef: string;
  /** The head commit; the merge button sends it as pr.merge's head-sha. */
  headSha?: string;
  isCrossRepository?: boolean;
  baseRef: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  mergedAt?: Timestamp;
  checks: { state: CheckRollupState; total: number; passed: number; failed: number; pending: number; skipped: number };
  reviewDecision: ReviewDecision;
  mergeable?: Mergeable;
  mergeStateStatus?: MergeStateStatus;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commentCount?: number;
  reviewCount?: number;
  reviewRequests?: string[];
  /** Each reviewer's latest review; commitSha is the head it was submitted on ("" when GitHub has none). */
  latestReviews?: { author: string; state: PullRequestReviewState; submittedAt?: Timestamp; commitSha: string }[];
}
/** One project-wide search (GetDashboardResponse.project_open / project_merged). */
interface ProjectListInit {
  pullRequests: PrInit[];
  totalCount: number;
  searchUrl: string;
}
interface DashboardInit {
  viewer: { login: string; name: string; url: string };
  authenticated: boolean;
  authored: PrInit[];
  reviewRequested: PrInit[];
  reviewed: PrInit[];
  recentlyMerged: PrInit[];
  dashboardsDisabled?: boolean;
  stats: MessageInitShape<typeof ActivityStatsSchema>;
  fetchedAt?: Timestamp;
  lastError: string;
  trackedSlugs?: string[];
  /** Others' open PRs in the tracked repositories (not the viewer's, not asking for or reviewed by them). */
  projectOpen: ProjectListInit;
  /** Every PR merged in a tracked repository in the last 7 days. */
  projectMerged: ProjectListInit;
  projectsFetchedAt?: Timestamp;
  projectsLastError: string;
}
interface ActivityInit {
  repoSlug: string;
  tracked: boolean;
  stats: MessageInitShape<typeof ActivityStatsSchema>;
  defaultBranch?: MessageInitShape<typeof DefaultBranchStatusSchema>;
  recentlyMerged: PrInit[];
}
type DetailInit = MessageInitShape<typeof WorktreeDetailSchema>;
type GhEventInit = MessageInitShape<typeof GhEventSchema>;
type ProjectEventInit = MessageInitShape<typeof ProjectEventSchema>;
type FileInit = { path: string; status: string; added?: number; deleted?: number; binary?: boolean; uncommitted?: boolean; oldPath?: string };

const HOME = "/Users/dev";
const CF = `${HOME}/src/code-foundry`;
const CFW = `${HOME}/src/code-foundry.worktrees`;
const GP = `${HOME}/src/ghostty-playground`;
export const VIEWER = "alexwaumann";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function monthLabel(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Stats months newest first from now: counts[i] is [commits, merged] of the month i back. */
function statsMonths(now: Date, counts: [number, number][]) {
  return counts.map(([commits, merged], i) => ({ month: monthLabel(new Date(now.getFullYear(), now.getMonth() - i, 1)), commits, merged }));
}

const rollup = (state: CheckRollupState, passed: number, failed = 0, pending = 0, skipped = 0) => ({
  state,
  total: passed + failed + pending + skipped,
  passed,
  failed,
  pending,
  skipped,
});

/** The github.com search URL the daemon sends for a query (ProjectList.SearchURL). */
const searchUrl = (q: string): string => `https://github.com/search?${new URLSearchParams({ q, type: "pullrequests" }).toString()}`;

/** A 40-character commit id from a short tag ("14a" -> "14a000…"). */
const sha = (tag: string): string => tag.padEnd(40, "0");

/** All the mock's GitHub-side state; reset() restores it. */
export class GhWorld {
  t0 = Date.now();
  dashboard!: DashboardInit;
  activity = new Map<string, ActivityInit>();
  branches = new Map<string, PrInit[]>();
  details = new Map<string, DetailInit>();
  calls: Record<string, number> = {};
  /** Answers as a daemon before its first poll (setCold). */
  private cold = false;
  /** The pull request detail panel's fixtures (mock/prDetail.ts). */
  prDetails!: PrDetailWorld;
  /** The Code tab's diff and files (mock/prDiff.ts). */
  prDiffs!: PrDiffWorld;
  /** Viewer is authenticated (POST /__mock/gh/auth?ok=false flips it). */
  authenticated = true;

  constructor(
    private readonly publishGh: (e: GhEventInit) => void,
    private readonly publishProjectEvent: (e: ProjectEventInit) => void,
  ) {
    this.reset();
  }

  private at(msAgo: number) {
    return timestampFromDate(new Date(this.t0 - msAgo));
  }

  private pr(repoSlug: string, number: number, title: string, o: Partial<PrInit> & { ageMs?: number; mergedAgoMs?: number } = {}): PrInit {
    const { ageMs = 3 * HOUR, mergedAgoMs, ...rest } = o;
    return {
      repoSlug,
      number,
      title,
      author: VIEWER,
      url: `https://github.com/${repoSlug}/pull/${String(number)}`,
      state: mergedAgoMs !== undefined ? PullRequestState.MERGED : PullRequestState.OPEN,
      headRef: `branch-${String(number)}`,
      baseRef: "main",
      createdAt: this.at(ageMs + DAY),
      updatedAt: this.at(ageMs),
      mergedAt: mergedAgoMs !== undefined ? this.at(mergedAgoMs) : undefined,
      checks: rollup(CheckRollupState.SUCCESS, 12),
      reviewDecision: ReviewDecision.REVIEW_REQUIRED,
      mergeable: mergedAgoMs !== undefined ? Mergeable.UNSPECIFIED : Mergeable.MERGEABLE,
      mergeStateStatus: mergedAgoMs !== undefined ? MergeStateStatus.UNSPECIFIED : MergeStateStatus.BLOCKED,
      additions: 10 * number,
      deletions: number,
      changedFiles: 3,
      commentCount: 2,
      reviewCount: 1,
      ...rest,
    };
  }

  reset(): void {
    this.t0 = Date.now();
    this.calls = {};
    this.cold = false;
    this.authenticated = true;
    const now = new Date(this.t0);
    const cf = "alexwaumann/code-foundry";
    const gp = "alexwaumann/ghostty-playground";
    const sidebarPr = this.pr(cf, 142, "feat(gui): virtualized sidebar tree with thread rows", {
      headRef: "feat/sidebar",
      // The merge button sends it as pr.merge's head-sha; the mock refuses another.
      headSha: "5eb1d0a142000000000000000000000000000000",
      reviewDecision: ReviewDecision.APPROVED,
      // Ready to merge (mock/prDetail.ts): approved, checks passing, no conflicts.
      mergeStateStatus: MergeStateStatus.CLEAN,
      checks: rollup(CheckRollupState.SUCCESS, 31, 0, 0, 2),
      ageMs: 40 * MIN,
    });
    const resizePr = this.pr(cf, 145, "fix(terminal): resize race between attach and first output", {
      headRef: "fix/resize",
      draft: true,
      reviewDecision: ReviewDecision.CHANGES_REQUESTED,
      // The detail's 7 checks (mock/prDetail.ts): 2 passed, 2 failed, 2 pending, 1 skipped.
      checks: rollup(CheckRollupState.FAILURE, 2, 2, 2, 1),
      ageMs: 5 * HOUR,
    });
    const merged138 = this.pr(cf, 138, "chore(gh): pace requests through one worker", { headRef: "gh-pacing", mergedAgoMs: 1 * DAY, ageMs: 1 * DAY });
    const merged136 = this.pr(cf, 136, "fix(repo): ignore Chmod-only fs events", { author: "teammate-kim", headRef: "kqueue-chmod", mergedAgoMs: 2 * DAY, ageMs: 2 * DAY });
    const merged10 = this.pr(gp, 10, "build: zig 0.16", { headRef: "zig-016", mergedAgoMs: 6 * DAY, ageMs: 6 * DAY });
    // The project-wide lists (GetDashboardResponse.project_open/project_merged): others'
    // open PRs in the two tracked repositories, and every PR merged in them this week.
    const repos = `(repo:${cf} OR repo:${gp})`; // github.com ANDs repeated repo: qualifiers
    const projectOpen = [
      this.pr(cf, 148, "feat(prs): per-project open pull requests", { author: "teammate-kim", headRef: "prs-per-project", reviewRequests: ["teammate-lee", "someone"], checks: rollup(CheckRollupState.SUCCESS, 30), additions: 412, deletions: 58, changedFiles: 14, commentCount: 3, reviewCount: 0, ageMs: 50 * MIN }),
      this.pr(cf, 149, "feat(usage): weekly totals on the Usage page", { author: "teammate-kim", headRef: "usage-weekly", draft: true, checks: rollup(CheckRollupState.PENDING, 8, 0, 22), additions: 188, deletions: 20, changedFiles: 6, commentCount: 0, reviewCount: 0, ageMs: 4 * HOUR }),
      this.pr(gp, 16, "fix: font fallback on Linux", {
        author: "someone",
        headRef: "font-fallback",
        reviewDecision: ReviewDecision.APPROVED,
        latestReviews: [{ author: "teammate-kim", state: PullRequestReviewState.APPROVED, submittedAt: this.at(7 * HOUR), commitSha: sha("16") }],
        headSha: sha("16"),
        mergeStateStatus: MergeStateStatus.CLEAN,
        checks: rollup(CheckRollupState.SUCCESS, 9, 0, 0, 1),
        additions: 54,
        deletions: 9,
        changedFiles: 2,
        commentCount: 1,
        reviewCount: 1,
        ageMs: 6 * HOUR,
      }),
      this.pr(gp, 15, "docs: atlas layout notes", { author: "someone", headRef: "atlas-notes", reviewDecision: ReviewDecision.UNSPECIFIED, mergeStateStatus: MergeStateStatus.CLEAN, checks: rollup(CheckRollupState.UNSPECIFIED, 0), additions: 40, deletions: 0, changedFiles: 1, commentCount: 0, reviewCount: 0, ageMs: DAY }),
      this.pr(cf, 144, "build(deps): bump vite from 7.1.4 to 7.2.0", { author: "dependabot", headRef: "dependabot/npm_and_yarn/vite-7.2.0", reviewDecision: ReviewDecision.UNSPECIFIED, checks: rollup(CheckRollupState.SUCCESS, 30), additions: 12, deletions: 12, changedFiles: 2, commentCount: 0, reviewCount: 0, ageMs: 2 * DAY }),
    ];
    const projectMerged = [
      merged138,
      this.pr(cf, 137, "fix(sidebar): keep pinned rows on archive", { author: "teammate-kim", headRef: "pinned-archive", mergedAgoMs: 2 * DAY - HOUR, ageMs: 2 * DAY - HOUR, additions: 46, deletions: 12, changedFiles: 3 }),
      merged136,
      this.pr(cf, 135, "build(deps): bump zustand from 5.0.14 to 5.0.15", { author: "dependabot", headRef: "dependabot/npm_and_yarn/zustand-5.0.15", mergedAgoMs: 4 * DAY, ageMs: 4 * DAY, additions: 3, deletions: 3, changedFiles: 2 }),
      this.pr(gp, 11, "ci: cache the zig toolchain", { author: "someone", headRef: "ci-cache", mergedAgoMs: 5 * DAY, ageMs: 5 * DAY, additions: 22, deletions: 4, changedFiles: 1 }),
      merged10,
    ];
    const since = `${new Date(this.t0 - 7 * DAY).toISOString().slice(0, 19)}+00:00`;
    this.dashboard = {
      viewer: { login: VIEWER, name: "Alex", url: `https://github.com/${VIEWER}` },
      authenticated: true,
      authored: [
        sidebarPr,
        resizePr,
        // Awaiting review: one request pending, checks still running.
        this.pr(gp, 12, "renderer: port glyph cache to the new atlas", { headRef: "atlas", checks: rollup(CheckRollupState.PENDING, 9, 0, 4), reviewRequests: ["teammate-kim"], ageMs: 2 * DAY }),
      ],
      // The PRs page's review queue (docs/notes/prs-inbox-2-gui.md): two requests (one
      // naming the viewer, one through a team), a review gone stale (needs review again)
      // and two that wait on their authors.
      reviewRequested: [
        this.pr(cf, 139, "feat(thread): JSONL transcript discovery", { author: "teammate-kim", headRef: "jsonl", checks: rollup(CheckRollupState.SUCCESS, 30), reviewRequests: [VIEWER], ageMs: 3 * HOUR }),
        this.pr("other-org/lib", 77, "chore: bump deps", { author: "renovate", checks: rollup(CheckRollupState.SUCCESS, 4), reviewRequests: ["other-org/maintainers"], ageMs: 6 * HOUR }),
      ],
      reviewed: [
        this.pr(cf, 133, "refactor(api): one events stream", {
          author: "teammate-kim",
          headRef: "events",
          headSha: sha("133"),
          latestReviews: [{ author: VIEWER, state: PullRequestReviewState.APPROVED, submittedAt: this.at(10 * HOUR), commitSha: sha("133") }],
          ageMs: 9 * HOUR,
        }),
        this.pr(gp, 14, "renderer: subpixel glyph positioning", {
          author: "teammate-kim",
          headRef: "subpixel",
          headSha: sha("14b"),
          // Reviewed on 14a; 14b was pushed after.
          latestReviews: [{ author: VIEWER, state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: this.at(DAY), commitSha: sha("14a") }],
          ageMs: 4 * HOUR,
        }),
        this.pr("other-org/lib", 81, "feat: streaming parser", {
          author: "someone",
          headRef: "stream",
          headSha: sha("81"),
          checks: rollup(CheckRollupState.FAILURE, 3, 1),
          latestReviews: [{ author: VIEWER, state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: this.at(2 * DAY), commitSha: sha("81") }],
          ageMs: 2 * DAY,
        }),
      ],
      recentlyMerged: [
        merged138,
        merged136,
        merged10,
        this.pr("other-org/lib", 70, "docs: README", { author: "someone", mergedAgoMs: 3 * DAY, ageMs: 3 * DAY }),
      ],
      stats: {
        months: statsMonths(now, [
          [16, 2],
          [463, 38],
          [210, 17],
          [96, 9],
          [0, 0],
          [41, 3],
        ]),
        commitsSource: "search",
        fetchedAt: this.at(8_000),
      },
      fetchedAt: this.at(8_000),
      lastError: "",
      projectOpen: { pullRequests: projectOpen, totalCount: projectOpen.length, searchUrl: searchUrl(`is:pr is:open archived:false updated:>=${new Date(this.t0 - 30 * DAY).toISOString().slice(0, 19)}+00:00 ${repos} -author:@me -reviewed-by:@me -review-requested:@me sort:updated-desc`) },
      projectMerged: { pullRequests: projectMerged, totalCount: projectMerged.length, searchUrl: searchUrl(`is:pr is:merged merged:>=${since} ${repos} sort:updated-desc`) },
      projectsFetchedAt: this.at(8_000),
      projectsLastError: "",
    };
    this.activity = new Map([
      [
        cf,
        {
          repoSlug: cf,
          tracked: true,
          stats: { months: statsMonths(now, [[9, 2], [75, 7], [30, 4], [12, 1], [0, 0], [5, 1]]), commitsSource: "search", fetchedAt: this.at(MIN) },
          defaultBranch: {
            branch: "main",
            sha: "3c3c4651aa",
            headline: "Merge pull request #138 from alexwaumann/gh-pacing",
            committedAt: this.at(DAY),
            rollup: rollup(CheckRollupState.FAILURE, 14, 2),
            failing: [
              { name: "error", workflow: "Jenkins", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://ci.example.com/job/code-foundry/main/812/" },
              { name: "continuous-integration/jenkins/branch", workflow: "", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://ci.example.com/job/code-foundry/main/812/console" },
            ],
            fetchedAt: this.at(20_000),
          },
          recentlyMerged: [],
        },
      ],
      [
        gp,
        {
          repoSlug: gp,
          tracked: true,
          stats: { months: statsMonths(now, [[7, 0], [12, 1], [3, 0], [0, 0], [0, 0], [1, 0]]), commitsSource: "search", fetchedAt: this.at(MIN) },
          defaultBranch: { branch: "main", sha: "77aa55cc", headline: "build: zig 0.16", committedAt: this.at(6 * DAY), rollup: rollup(CheckRollupState.SUCCESS, 9, 0, 0, 1), failing: [], fetchedAt: this.at(20_000) },
          recentlyMerged: [],
        },
      ],
    ]);
    this.branches = new Map([
      [`${cf}\u0000feat/sidebar`, [sidebarPr]],
      [`${cf}\u0000fix/resize`, [resizePr]],
    ]);
    this.details = new Map([
      [CF, this.detail(CF, "origin/main", [
        { path: ".pr1853.diff", status: "?", added: 1368, uncommitted: true },
        { path: "README.md", status: "M", added: 3, deleted: 1, uncommitted: true },
        { path: "notes/plan.md", status: "?", added: 12, uncommitted: true },
        { path: "notes/todo.md", status: "?", added: 4, uncommitted: true },
      ])],
      [`${CFW}/feat-sidebar`, this.detail(`${CFW}/feat-sidebar`, "origin/main", [
        { path: "gui/frontend/src/components/sidebar/Sidebar.tsx", status: "M", added: 120, deleted: 44 },
        { path: "gui/frontend/src/components/sidebar/SidebarRow.tsx", status: "A", added: 96 },
        { path: "gui/frontend/src/lib/tree.ts", status: "M", added: 61, deleted: 12 },
        { path: "gui/frontend/src/lib/tree.test.ts", status: "M", added: 40, deleted: 2, uncommitted: true },
        { path: "gui/frontend/src/lib/old-tree.ts", status: "D", deleted: 88 },
        { path: "docs/notes/sidebar.md", status: "R", oldPath: "docs/sidebar.md", added: 4, deleted: 1 },
        { path: "scratch.txt", status: "?", added: 3, uncommitted: true },
        { path: "assets/icon.png", status: "A", binary: true },
      ], "9a8b7c6d1e")],
      [`${CFW}/fix-resize`, this.detail(`${CFW}/fix-resize`, "origin/main", manyFiles(), "1f2e3d4caa")],
      [GP, this.detail(GP, "origin/main", [{ path: "src/renderer/atlas.zig", status: "M", added: 12, deleted: 3, uncommitted: true }])],
    ]);
    this.prDiffs = new PrDiffWorld({ shas: (slug, number) => this.prDetails.shas(slug, number), count: (rpc) => { this.count(rpc); } });
    this.prDetails = new PrDetailWorld({
      t0: this.t0,
      viewer: VIEWER,
      publishGh: this.publishGh,
      findPr: (slug, number) => this.findPr(slug, number),
      makePr: (slug, number, title, o) => this.pr(slug, number, title, o),
      addAuthored: (pr) => {
        this.dashboard = { ...this.dashboard, authored: [pr, ...this.dashboard.authored], fetchedAt: timestampFromDate(new Date()) };
        this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
      },
      markMerged: (pr) => {
        const d = this.dashboard;
        this.dashboard = {
          ...d,
          authored: d.authored.filter((p) => p !== pr),
          recentlyMerged: [pr, ...d.recentlyMerged.filter((p) => p !== pr)],
          fetchedAt: timestampFromDate(new Date()),
        };
        this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
        for (const [k, prs] of this.branches) {
          if (!prs.includes(pr)) continue;
          const [repoSlug = "", headRef = ""] = k.split("\u0000");
          this.publishGh({ event: { case: "branchPullRequestsUpdated", value: { repoSlug, headRef, fetchedAt: this.dashboard.fetchedAt } } });
        }
      },
      count: (rpc) => {
        this.count(rpc);
      },
    });
  }

  /**
   * Test control (workspace fixtures): an open pull request by the viewer on `head` with
   * failing checks (2 of 9), served by GetBranchPullRequests and announced like a poll.
   */
  addBranchPullRequest(slug: string, head: string, number: number, title: string): void {
    const pr = this.pr(slug, number, title, { headRef: head, checks: rollup(CheckRollupState.FAILURE, 6, 2, 0, 1), ageMs: 2 * HOUR });
    this.branches.set(`${slug}\u0000${head}`, [pr]);
    this.publishGh({ event: { case: "branchPullRequestsUpdated", value: { repoSlug: slug, headRef: head, fetchedAt: timestampFromDate(new Date()) } } });
  }

  /**
   * The thread info card's fixtures (World.addThreadInfo): a pull request on `head` (into
   * `base`) beside the branch's others, with its checks and review, so its detail resolves.
   */
  addCardPullRequest(slug: string, number: number, title: string, o: { head: string; base?: string; state: "open" | "draft" | "merged"; checks?: "ok" | "failed" | "running"; review?: "approved" | "required"; requested?: string[]; ageMs?: number }): void {
    const ageMs = o.ageMs ?? 2 * HOUR;
    const merged = o.state === "merged";
    const checks = o.checks === "failed" ? rollup(CheckRollupState.FAILURE, 9, 2) : o.checks === "running" ? rollup(CheckRollupState.PENDING, 4, 0, 5) : rollup(CheckRollupState.SUCCESS, 12);
    const pr = this.pr(slug, number, title, {
      headRef: o.head,
      baseRef: o.base ?? "main",
      ageMs,
      draft: o.state === "draft",
      state: merged ? PullRequestState.MERGED : PullRequestState.OPEN,
      mergedAt: merged ? this.at(ageMs) : undefined,
      checks,
      reviewDecision: o.review === "approved" ? ReviewDecision.APPROVED : ReviewDecision.REVIEW_REQUIRED,
      reviewRequests: o.requested ?? [],
    });
    const key = `${slug}\u0000${o.head}`;
    this.branches.set(key, [...(this.branches.get(key) ?? []).filter((p) => p.number !== number), pr]);
  }

  /** The thread info card's fixtures: a worktree's changes against its base (its detail's files). */
  setCardDetail(projectId: string, path: string, files: { path: string; added: number; deleted: number; uncommitted?: boolean }[]): void {
    const d = this.detail(path, "origin/main", files.map((f) => ({ status: f.added > 0 && f.deleted === 0 ? "A" : "M", ...f })));
    this.details.set(path, { ...d, projectId });
    this.publishProjectEvent({ event: { case: "worktreeDetailUpdated", value: { projectId, path, computedAt: d.computedAt } } });
  }

  /** A pull request any dashboard list or watched branch holds. */
  findPr(slug: string, number: number): PrInit | undefined {
    const d = this.dashboard;
    const all = [...d.authored, ...d.reviewRequested, ...d.reviewed, ...d.recentlyMerged, ...[...this.branches.values()].flat(), ...d.projectOpen.pullRequests, ...d.projectMerged.pullRequests];
    return all.find((p) => p.repoSlug.toLowerCase() === slug.toLowerCase() && p.number === number);
  }

  private detail(path: string, baseRef: string, files: FileInit[], head = "3c3c4651aa"): DetailInit {
    return {
      projectId: path.startsWith(GP) ? "repo-gp" : "repo-cf",
      path,
      baseRef,
      mergeBase: "3c3c4651aa",
      head,
      files: files.map((f) => ({ oldPath: "", added: 0, deleted: 0, binary: false, uncommitted: false, ...f })),
      filesTruncated: false,
      computedAt: this.at(5_000),
      error: "",
    };
  }

  count(rpc: string): void {
    this.calls[rpc] = (this.calls[rpc] ?? 0) + 1;
  }

  /** Like the daemon: every list in full, whatever the projects; `tracked` only fills tracked_slugs. */
  getDashboard(tracked: string[]): DashboardInit {
    this.count("GetDashboard");
    if (this.cold) return { ...this.coldDashboard(), authenticated: this.authenticated, trackedSlugs: tracked };
    return { ...this.dashboard, authenticated: this.authenticated, trackedSlugs: tracked };
  }

  /** What a daemon holds before its first poll: empty lists and no fetch time. */
  private coldDashboard(): DashboardInit {
    const none = { pullRequests: [], totalCount: 0, searchUrl: "" };
    return { ...this.dashboard, authored: [], reviewRequested: [], reviewed: [], recentlyMerged: [], projectOpen: none, projectMerged: none, fetchedAt: undefined, projectsFetchedAt: undefined };
  }

  /** Answers as a daemon before its first poll, or (off) as one whose first poll just found the lists. */
  setCold(on: boolean): void {
    this.cold = on;
    if (on) return;
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
    this.publishGh(this.polledEvent());
  }

  getRepoActivity(slug: string): ActivityInit {
    this.count("GetRepoActivity");
    const a = this.activity.get(slug) ?? { repoSlug: slug, tracked: false, stats: {}, recentlyMerged: [] };
    return { ...a, recentlyMerged: this.dashboard.recentlyMerged.filter((p) => p.repoSlug === slug) };
  }

  getBranchPullRequests(slug: string, head: string) {
    this.count("GetBranchPullRequests");
    const prs = this.branches.get(`${slug}\u0000${head}`) ?? [];
    return { pullRequests: prs, fetchedAt: this.at(30_000), lastError: "" };
  }

  getWorktreeDetail(projectId: string, path: string): DetailInit | null {
    this.count("GetWorktreeDetail");
    return this.details.get(path) ?? (path.startsWith(HOME) ? { projectId, path, baseRef: "", files: [], computedAt: timestampFromDate(new Date()) } : null);
  }

  // ---- controls (POST /__mock/gh/...) -------------------------------------------------

  /** The polled event: the daemon sends it after every poll and in its gh snapshot. */
  polledEvent(): GhEventInit {
    const d = this.dashboard;
    if (this.cold) return { event: { case: "polled", value: {} } };
    return { event: { case: "polled", value: { fetchedAt: d.fetchedAt, lastError: d.lastError, projectsFetchedAt: d.projectsFetchedAt, projectsLastError: d.projectsLastError } } };
  }

  /**
   * Inbox zero: no review requests and nothing stale; only the reviews that wait on their
   * authors are left. Announced like a poll.
   */
  inboxZero(): void {
    const d = this.dashboard;
    const fresh = (p: PrInit) => (p.latestReviews ?? []).every((r) => r.author !== VIEWER || r.commitSha === p.headSha);
    this.dashboard = { ...d, reviewRequested: [], reviewed: d.reviewed.filter(fresh), fetchedAt: timestampFromDate(new Date()) };
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
    this.publishGh(this.polledEvent());
  }

  /**
   * Test control (POST /__mock/gh/project-merged-capped?shown=3&total=64): the project-wide
   * merged list is capped, showing its first `shown` of `total` (GitHub's issueCount), like
   * a busy week. Announced like a poll.
   */
  capProjectMerged(shown: number, total: number): void {
    const d = this.dashboard;
    const at = timestampFromDate(new Date());
    this.dashboard = { ...d, projectMerged: { ...d.projectMerged, pullRequests: d.projectMerged.pullRequests.slice(0, shown), totalCount: total }, fetchedAt: at, projectsFetchedAt: at };
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: at } } });
    this.publishGh(this.polledEvent());
  }

  /**
   * Test control (POST /__mock/gh/many-prs?count=150): every list of the page holds `count`
   * copies of its first pull request, so each is past RowList's limit. Announced like a poll.
   */
  manyPrs(count: number): void {
    const d = this.dashboard;
    const at = timestampFromDate(new Date());
    const many = (prs: PrInit[], from: number): PrInit[] => {
      const first = prs[0];
      return first ? Array.from({ length: count }, (_, i) => ({ ...first, number: from + i, title: `Row ${String(i)}` })) : prs;
    };
    this.dashboard = {
      ...d,
      authored: many(d.authored, 3000),
      reviewRequested: many(d.reviewRequested, 4000),
      recentlyMerged: many(d.recentlyMerged, 5000),
      projectOpen: { ...d.projectOpen, pullRequests: many(d.projectOpen.pullRequests, 6000) },
      projectMerged: { ...d.projectMerged, pullRequests: many(d.projectMerged.pullRequests, 7000) },
      fetchedAt: at,
      projectsFetchedAt: at,
    };
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: at } } });
    this.publishGh(this.polledEvent());
  }

}

/** 120 files across nested directories (the list virtualizes; directories start collapsed). */
function manyFiles() {
  const out: { path: string; status: string; added: number; deleted: number }[] = [];
  const dirs = ["internal/store/terminal", "internal/store/terminal/vt", "internal/api", "gui/frontend/src/terminal", "docs/notes"];
  for (let i = 0; i < 120; i++) {
    const dir = dirs[i % dirs.length] ?? "x";
    out.push({ path: `${dir}/file_${String(i).padStart(3, "0")}.go`, status: i % 7 === 0 ? "A" : "M", added: (i * 13) % 97, deleted: (i * 7) % 31 });
  }
  return out;
}

/** GhService event wrapper for the EventService hub. */
export function ghEvent(e: GhEventInit) {
  return { source: EventSource.GH, event: { event: { case: "gh" as const, value: e } } };
}

/** --pane of the page verbs: the pane's "+" menu (internal/command openPaneArg). */
const pagePaneArg = { name: "pane", type: ArgType.STRING, required: false, description: "Open the tab in this pane (the pane's + menu); a linked tab that is already open is focused where it is" };

/**
 * view.pullrequests and view.projects in the mock registry (view.open.url is in mock/gitops.ts, like 3c),
 * like the daemon's (commands_view.go showPageTab): the page's tab in the current space (--pane: that
 * pane), focused for the user's call (the app, the CLI outside a thread), from a thread only with
 * --focus. The tab is the whole effect: no intent goes out (docs/notes/shell-22-retire-verbs.md).
 */
export function viewCommands(openTab: (kind: string, pane: string, params: Record<string, string> | undefined, focus: boolean) => void) {
  const focusOf = (ctx: { activeView?: string; activeThreadId?: string } | undefined, a: Record<string, string>) =>
    a.focus !== undefined ? a.focus === "true" : Boolean(ctx?.activeView) || !ctx?.activeThreadId;
  return [
    {
      cmd: { name: "view.pullrequests", title: "Show Pull Requests", category: "View", description: "Show the Pull Requests page, its tab in the current space", keybindings: [], args: [pagePaneArg] },
      when: () => true,
      run: (ctx: { activeView?: string; activeThreadId?: string } | undefined, a: Record<string, string> = {}) => {
        openTab("prs", a.pane ?? "", undefined, focusOf(ctx, a));
        return ""; // like the daemon in the app: no toast
      },
    },
    {
      cmd: {
        name: "view.projects",
        title: "Show Projects",
        category: "View",
        description: "Show the Projects page, its tab in the current space: each project's worktrees and each workspace's members; --project or --workspace opens that one's page",
        keybindings: [],
        args: [
          { name: "project", type: ArgType.STRING, required: false, description: "Open this project's page" },
          { name: "workspace", type: ArgType.STRING, required: false, description: "Open this workspace's page" },
          pagePaneArg,
        ],
      },
      when: () => true,
      run: (ctx: { activeView?: string; activeThreadId?: string } | undefined, a: Record<string, string> = {}) => {
        // Like the daemon: which page in the tab's params (the ids as given; the mock resolves no
        // names); none is the index, an open tab's page left.
        const params: Record<string, string> = a.project ? { project: a.project } : a.workspace ? { workspace: a.workspace } : {};
        openTab("projects", a.pane ?? "", params, focusOf(ctx, a));
        return "";
      },
    },
  ];
}
