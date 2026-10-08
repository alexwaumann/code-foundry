/**
 * Mock GhService dashboards/activity/branch PRs and RepoService.GetWorktreeDetail data
 * (Phase 3a). Deterministic, relative to the time the world was reset. Paths match
 * world.ts's repos.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { EventSource } from "../src/gen/codefoundry/v1/events_pb";
import {
  CheckConclusion,
  CheckRollupState,
  CheckStatus,
  PullRequestState,
  ReviewDecision,
  type DefaultBranchStatusSchema,
  type GhEventSchema,
  type ActivityStatsSchema,
} from "../src/gen/codefoundry/v1/gh_pb";
import type { RepoEventSchema, WorktreeDetailSchema } from "../src/gen/codefoundry/v1/repo_pb";
import type { UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";

/** Plain init shapes (no $typeName arm), so spreads stay assignable to the RPC responses. */
interface PrInit {
  repoSlug: string;
  number: number;
  title: string;
  author: string;
  url: string;
  state: PullRequestState;
  draft?: boolean;
  headRef: string;
  baseRef: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  mergedAt?: Timestamp;
  checks: { state: CheckRollupState; total: number; passed: number; failed: number; pending: number; skipped: number };
  reviewDecision: ReviewDecision;
}
interface DashboardInit {
  viewer: { login: string; name: string; url: string };
  authenticated: boolean;
  authored: PrInit[];
  reviewRequested: PrInit[];
  recentlyMerged: PrInit[];
  stats: MessageInitShape<typeof ActivityStatsSchema>;
  fetchedAt?: Timestamp;
  lastError: string;
  trackedSlugs?: string[];
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
type RepoEventInit = MessageInitShape<typeof RepoEventSchema>;
type IntentInit = MessageInitShape<typeof UiIntentSchema>;
type FileInit = { path: string; status: string; added?: number; deleted?: number; binary?: boolean; uncommitted?: boolean; isDir?: boolean; oldPath?: string };

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

const rollup = (state: CheckRollupState, passed: number, failed = 0, pending = 0, skipped = 0) => ({
  state,
  total: passed + failed + pending + skipped,
  passed,
  failed,
  pending,
  skipped,
});

/** All the mock's GitHub-side state; reset() restores it. */
export class GhWorld {
  t0 = Date.now();
  dashboard!: DashboardInit;
  activity = new Map<string, ActivityInit>();
  branches = new Map<string, PrInit[]>();
  details = new Map<string, DetailInit>();
  calls: Record<string, number> = {};
  /** Viewer is authenticated (POST /__mock/gh/auth?ok=false flips it). */
  authenticated = true;

  constructor(
    private readonly publishGh: (e: GhEventInit) => void,
    private readonly publishRepo: (e: RepoEventInit) => void,
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
      ...rest,
    };
  }

  reset(): void {
    this.t0 = Date.now();
    this.calls = {};
    this.authenticated = true;
    const now = new Date(this.t0);
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const cf = "alexwaumann/code-foundry";
    const gp = "alexwaumann/ghostty-playground";
    const sidebarPr = this.pr(cf, 142, "feat(gui): virtualized sidebar tree with session rows", {
      headRef: "feat/sidebar",
      reviewDecision: ReviewDecision.APPROVED,
      checks: rollup(CheckRollupState.SUCCESS, 31, 0, 0, 2),
      ageMs: 40 * MIN,
    });
    const resizePr = this.pr(cf, 145, "fix(terminal): resize race between attach and first output", {
      headRef: "fix/resize",
      draft: true,
      reviewDecision: ReviewDecision.CHANGES_REQUESTED,
      checks: rollup(CheckRollupState.FAILURE, 28, 2, 0, 3),
      ageMs: 5 * HOUR,
    });
    this.dashboard = {
      viewer: { login: VIEWER, name: "Alex", url: `https://github.com/${VIEWER}` },
      authenticated: true,
      authored: [
        sidebarPr,
        resizePr,
        this.pr(gp, 12, "renderer: port glyph cache to the new atlas", { headRef: "atlas", checks: rollup(CheckRollupState.PENDING, 9, 0, 4), ageMs: 2 * DAY }),
      ],
      reviewRequested: [
        this.pr(cf, 139, "feat(session): JSONL transcript discovery", { author: "teammate-kim", headRef: "jsonl", checks: rollup(CheckRollupState.SUCCESS, 30), ageMs: 3 * HOUR }),
        this.pr("other-org/lib", 77, "chore: bump deps", { author: "renovate", checks: rollup(CheckRollupState.SUCCESS, 4), ageMs: 6 * HOUR }),
      ],
      recentlyMerged: [
        this.pr(cf, 138, "chore(gh): pace requests through one worker", { headRef: "gh-pacing", mergedAgoMs: 1 * DAY, ageMs: 1 * DAY }),
        this.pr(cf, 136, "fix(repo): ignore Chmod-only fs events", { author: "teammate-kim", headRef: "kqueue-chmod", mergedAgoMs: 2 * DAY, ageMs: 2 * DAY }),
        this.pr(gp, 10, "build: zig 0.16", { headRef: "zig-016", mergedAgoMs: 6 * DAY, ageMs: 6 * DAY }),
        this.pr("other-org/lib", 70, "docs: README", { author: "someone", mergedAgoMs: 3 * DAY, ageMs: 3 * DAY }),
      ],
      stats: {
        thisMonth: { month: monthLabel(now), commits: 16, merged: 2 },
        lastMonth: { month: monthLabel(last), commits: 463, merged: 38 },
        commitsSource: "search",
        fetchedAt: this.at(8_000),
      },
      fetchedAt: this.at(8_000),
      lastError: "",
    };
    this.activity = new Map([
      [
        cf,
        {
          repoSlug: cf,
          tracked: true,
          stats: { thisMonth: { month: monthLabel(now), commits: 9, merged: 2 }, lastMonth: { month: monthLabel(last), commits: 75, merged: 7 }, commitsSource: "search", fetchedAt: this.at(MIN) },
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
          stats: { thisMonth: { month: monthLabel(now), commits: 7, merged: 0 }, lastMonth: { month: monthLabel(last), commits: 12, merged: 1 }, commitsSource: "search", fetchedAt: this.at(MIN) },
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
        { path: "notes/", status: "?", uncommitted: true, isDir: true },
        { path: "README.md", status: "M", added: 3, deleted: 1, uncommitted: true },
      ], [])],
      [`${CFW}/feat-sidebar`, this.detail(`${CFW}/feat-sidebar`, "origin/main", [
        { path: "gui/frontend/src/components/sidebar/Sidebar.tsx", status: "M", added: 120, deleted: 44 },
        { path: "gui/frontend/src/components/sidebar/SidebarRow.tsx", status: "A", added: 96 },
        { path: "gui/frontend/src/lib/tree.ts", status: "M", added: 61, deleted: 12 },
        { path: "gui/frontend/src/lib/tree.test.ts", status: "M", added: 40, deleted: 2, uncommitted: true },
        { path: "gui/frontend/src/lib/old-tree.ts", status: "D", deleted: 88 },
        { path: "docs/notes/sidebar.md", status: "R", oldPath: "docs/sidebar.md", added: 4, deleted: 1 },
        { path: "scratch.txt", status: "?", added: 3, uncommitted: true },
        { path: "assets/icon.png", status: "A", binary: true },
      ], [
        ["9a8b7c6d1e", "feat(gui): row virtualization", 2 * HOUR],
        ["4f3e2d1c0b", "refactor(tree): flatten placement", 5 * HOUR],
        ["8e7d6c5b4a", "feat(gui): session rows in the sidebar", DAY],
      ])],
      [`${CFW}/fix-resize`, this.detail(`${CFW}/fix-resize`, "origin/main", manyFiles(), Array.from({ length: 12 }, (_, i): [string, string, number] => [`${(0x1f2e3d4c + i * 7919).toString(16)}aa`, `fix(terminal): step ${String(12 - i)} of the resize rework`, (i + 1) * 3 * HOUR]))],
      [GP, this.detail(GP, "origin/main", [{ path: "src/renderer/atlas.zig", status: "M", added: 12, deleted: 3, uncommitted: true }], [])],
    ]);
  }

  private detail(path: string, baseRef: string, files: FileInit[], log: [string, string, number][]): DetailInit {
    return {
      repoId: path.startsWith(GP) ? "repo-gp" : "repo-cf",
      path,
      baseRef,
      mergeBase: "3c3c4651aa",
      head: log[0]?.[0] ?? "3c3c4651aa",
      files: files.map((f) => ({ oldPath: "", added: 0, deleted: 0, binary: false, uncommitted: false, isDir: false, ...f })),
      filesTruncated: false,
      log: log.map(([sha, subject, ago]) => ({ sha: `${sha}${"0".repeat(40 - sha.length)}`, shortSha: sha.slice(0, 7), subject, authorName: "Alex", authorEmail: "alex@example.com", authoredAt: this.at(ago) })),
      logTotal: log.length,
      computedAt: this.at(5_000),
      error: "",
    };
  }

  count(rpc: string): void {
    this.calls[rpc] = (this.calls[rpc] ?? 0) + 1;
  }

  getDashboard(includeUntracked: boolean, tracked: string[]): DashboardInit {
    this.count("GetDashboard");
    const keep = (p: PrInit) => includeUntracked || tracked.includes(p.repoSlug);
    const d = this.dashboard;
    return {
      ...d,
      authenticated: this.authenticated,
      authored: d.authored.filter(keep),
      reviewRequested: d.reviewRequested.filter(keep),
      recentlyMerged: d.recentlyMerged.filter(keep),
      trackedSlugs: tracked,
    };
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

  getWorktreeDetail(repoId: string, path: string): DetailInit | null {
    this.count("GetWorktreeDetail");
    return this.details.get(path) ?? (path.startsWith(HOME) ? { repoId, path, baseRef: "", files: [], log: [], computedAt: timestampFromDate(new Date()) } : null);
  }

  // ---- controls (POST /__mock/gh/...) -------------------------------------------------

  /** A poll found a new PR: add it and announce the dashboard. */
  update(): void {
    const pr = this.pr("alexwaumann/code-foundry", 150, "feat(gui): Pull Requests page", { headRef: "phase3a", checks: rollup(CheckRollupState.PENDING, 3, 0, 5), ageMs: 0 });
    this.dashboard = { ...this.dashboard, authored: [pr, ...this.dashboard.authored], fetchedAt: timestampFromDate(new Date()) };
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
  }

  /** The last successful poll was 10 minutes ago, and the latest one failed. */
  stale(): void {
    this.dashboard = { ...this.dashboard, fetchedAt: timestampFromDate(new Date(Date.now() - 10 * MIN)), lastError: "github rate limit (secondary): paused" };
    this.publishGh({ event: { case: "dashboardUpdated", value: { fetchedAt: this.dashboard.fetchedAt } } });
  }

  /** A file appeared in a worktree: recompute and announce. */
  touch(path: string): boolean {
    const d = this.details.get(path);
    if (!d) return false;
    d.files = [...(d.files ?? []), { path: "later.txt", status: "?", added: 1, deleted: 0, binary: false, uncommitted: true, isDir: false, oldPath: "" }];
    d.computedAt = timestampFromDate(new Date());
    this.publishRepo({ event: { case: "worktreeDetailUpdated", value: { repoId: d.repoId, path, computedAt: d.computedAt } } });
    return true;
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

/** view.pullrequests in the mock registry (view.open.url is in mock/gitops.ts, like 3c). */
export function viewCommands(emit: (intent: IntentInit) => number) {
  return [
    {
      cmd: { name: "view.pullrequests", title: "Show Pull Requests", category: "View", description: "Show the Pull Requests page", keybindings: ["cmd+shift+d"], args: [] },
      when: () => true,
      run: () => {
        emit({ intent: { case: "showView", value: { name: "pullrequests" } } });
        return ""; // like the daemon: no toast
      },
    },
  ];
}
