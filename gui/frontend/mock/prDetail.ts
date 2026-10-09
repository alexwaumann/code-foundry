/**
 * Mock GhService pull request detail panel: GetPullRequestDetail, ListReviewerCandidates,
 * SetReviewRequest, RevertPullRequest, MergePullRequest. Two rich fixtures on
 * alexwaumann/code-foundry, and the mergeable one:
 *
 *   #145 open, draft, failing, in-progress and queued checks, changes requested by a
 *        reviewer who is stale and re-requested, a team and a user pending, a bot
 *        review, reviewers_truncated, unresolved and outdated review threads (with
 *        review ids), labels, issue comments (one by a deleted account)
 *   #138 merged with a merge commit (the default branch head in mock/github.ts), an
 *        approval, a resolved thread; revertable
 *   #131 closed without merging (revert: FAILED_PRECONDITION); two passed checks
 *   #140 open, someone else's, the viewer has read access only (viewer_can_update false);
 *        one check queued (a first-time contributor's workflow awaiting approval)
 *   #142 open, approved, checks passing, merge state clean: the merge button works, and a
 *        merge flips it to merged (it moves to the dashboard's recently merged)
 *   #146 open from a fork (outside-contrib:patch-1), approved, mergeable, the viewer an
 *        admin: merging never deletes its branch
 *
 * #131, #140 and #146 are on no dashboard: open them by number. Every other pull request the
 * dashboards or branches list gets a minimal detail built from its summary, so any row
 * the GUI shows can open the panel.
 *
 * The panel's actions are commands (pr.revert, pr.merge, pr.review.request, pr.refresh;
 * see commands()), like the daemon's; the RPCs they wrap are served too. Every open pull
 * request allows all three merge methods; every repository's default branch is main.
 * pr.merge refuses a head-sha other than the fixture's head. pr.refresh answers
 * with the detail (protojson), as the daemon does. POST /__mock/gh/pr-fail?command=pr.refresh
 * makes that command's next run fail (UNAVAILABLE, like a refresh GitHub refused);
 * ?command=pr.merge fails the next merge like a moved head (FAILED_PRECONDITION).
 */
import { create, toJson, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import {
  CheckConclusion,
  CheckRollupState,
  CheckStatus,
  DiffSide,
  PullRequestCommentKind,
  PullRequestReviewState,
  PullRequestState,
  ReviewDecision,
  ReviewerKind,
  type GhEventSchema,
  PullRequestDetailSchema,
  PullRequestMergeMethod,
  MergeStateStatus,
  Mergeable,
  type ReviewerCandidateSchema,
} from "../src/gen/codefoundry/v1/gh_pb";
import type { PrInit } from "./github";
import type { InvokeOut } from "./gitops";

type DetailInit = MessageInitShape<typeof PullRequestDetailSchema>;
type CandidateInit = MessageInitShape<typeof ReviewerCandidateSchema>;
/** Plain init shapes (no $typeName arm) so spreads type-check, like PrInit. */
interface CommentInit {
  id: string;
  kind: PullRequestCommentKind;
  author: string;
  authorIsBot?: boolean;
  authorAvatarUrl?: string;
  body?: string;
  createdAt?: Timestamp;
  url?: string;
  path?: string;
  reviewState?: PullRequestReviewState;
  reviewId?: string;
}
type GhEventInit = MessageInitShape<typeof GhEventSchema>;

/** Thrown for RPC errors; prDetailCall maps `code` to a ConnectError code. */
export class PrDetailError extends Error {
  constructor(
    readonly code: "not_found" | "failed_precondition" | "invalid_argument" | "permission_denied",
    message: string,
  ) {
    super(message);
  }
}

const prDetailCodes = {
  not_found: Code.NotFound,
  failed_precondition: Code.FailedPrecondition,
  invalid_argument: Code.InvalidArgument,
  permission_denied: Code.PermissionDenied,
};

/** Runs a pull request detail RPC or command, mapping PrDetailError to its Connect code. */
export function prDetailCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof PrDetailError) throw new ConnectError(err.message, prDetailCodes[err.code]);
    throw err;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CF = "alexwaumann/code-foundry";

const ALL_METHODS = [PullRequestMergeMethod.MERGE, PullRequestMergeMethod.SQUASH, PullRequestMergeMethod.REBASE];
const methodNames: Record<string, PullRequestMergeMethod> = { merge: PullRequestMergeMethod.MERGE, squash: PullRequestMergeMethod.SQUASH, rebase: PullRequestMergeMethod.REBASE };
const methodWords: Record<string, string> = { merge: "a merge commit", squash: "squash", rebase: "rebase" };

/** MergePullRequestResponse, as JSON (the command's result) and the RPC's answer. */
interface MergeOut {
  merged: boolean;
  sha: string;
  message: string;
  branchDeleted: boolean;
}

/** Why a merge keeps pr's head branch even when asked (the daemon's keepBranch, plus forks), or "". */
function keepBranch(pr: { headRef?: string; baseRef?: string; isCrossRepository?: boolean }, defaultBranch: string): string {
  if (pr.isCrossRepository) return "it is in a fork";
  if (pr.headRef === defaultBranch) return "it is the repository's default branch";
  if (pr.headRef === pr.baseRef) return "it is the base branch";
  return "";
}

const avatar = (login: string) => `https://avatars.example.com/${login.replace("/", "-")}.png`;
const key = (slug: string, number: number) => `${slug.toLowerCase()}#${String(number)}`;

export interface PrDetailHooks {
  t0: number;
  viewer: string;
  publishGh: (e: GhEventInit) => void;
  /** The summary of a pull request the dashboards or branches list. */
  findPr: (slug: string, number: number) => PrInit | undefined;
  /** A new pull request authored by the viewer (a revert): add it to the dashboard. */
  addAuthored: (pr: PrInit) => void;
  /** pr (its state already MERGED) leaves the authored list for recently merged; announce it. */
  markMerged: (pr: PrInit) => void;
  /** A pull request summary built like the dashboards' (for fixtures on no dashboard). */
  makePr: (slug: string, number: number, title: string, o?: Partial<PrInit> & { ageMs?: number }) => PrInit;
  count: (rpc: string) => void;
}

export class PrDetailWorld {
  private readonly details = new Map<string, DetailInit>();
  private readonly candidates = new Map<string, CandidateInit[]>();
  private readonly reverts = new Map<string, { number: number; url: string }>();
  private readonly merges = new Map<string, { res: MergeOut; deleteAsked: boolean }>();
  private nextNumber = 151;
  /** Commands whose next run fails (POST /__mock/gh/pr-fail?command=…). */
  readonly failNext = new Set<string>();
  /** How long pr.ask, pr.explain, pr.fix.findings and pr.merge take (POST /__mock/gh/pr-delay?ms=…). */
  sessionDelayMs = 0;

  constructor(private readonly h: PrDetailHooks) {
    const open = h.findPr(CF, 145);
    const merged = h.findPr(CF, 138);
    if (open) this.details.set(key(CF, 145), this.openDetail(open));
    if (merged) this.details.set(key(CF, 138), this.mergedDetail(merged));
    this.details.set(key(CF, 131), this.closedDetail());
    this.details.set(key(CF, 140), this.readOnlyDetail());
    this.details.set(key(CF, 146), this.forkDetail());
    for (const d of this.details.values()) d.defaultBranch = "main";
    this.candidates.set(key(CF, 145), [
      { id: "T_core", kind: ReviewerKind.TEAM, login: "acme/core", name: "Core", avatarUrl: avatar("acme/core"), isRequested: true },
      { id: "U_ana", kind: ReviewerKind.USER, login: "teammate-ana", name: "Ana", avatarUrl: avatar("teammate-ana"), isRequested: true },
      { id: "U_kim", kind: ReviewerKind.USER, login: "teammate-kim", name: "Kim", avatarUrl: avatar("teammate-kim"), isRequested: true },
      { id: "U_lee", kind: ReviewerKind.USER, login: "teammate-lee", name: "Lee", avatarUrl: avatar("teammate-lee") },
      { id: "U_max", kind: ReviewerKind.USER, login: "teammate-max", name: "", avatarUrl: avatar("teammate-max") },
    ]);
  }

  private at(msAgo: number): Timestamp {
    return timestampFromDate(new Date(this.h.t0 - msAgo));
  }

  private mkComment(kind: PullRequestCommentKind, id: string, author: string, body: string, agoMs: number, extra: Partial<CommentInit> = {}): CommentInit {
    return {
      id,
      kind,
      author,
      authorAvatarUrl: avatar(author),
      body,
      createdAt: this.at(agoMs),
      url: `https://github.com/${CF}/pull/145#${id}`,
      ...extra,
    };
  }

  private openDetail(pr: PrInit): DetailInit {
    const c = this.mkComment.bind(this);
    return {
      pullRequest: pr,
      body: [
        "## Summary",
        "",
        "Attach could race the first output chunk and size the terminal from a stale snapshot.",
        "This moves the resize into the terminal actor and replays it after the snapshot.",
        "",
        "## Test plan",
        "",
        "- [x] `go test ./internal/store/terminal/...`",
        "- [ ] resize a session while it prints (manual)",
      ].join("\n"),
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "terminal", color: "0e8a16" },
      ],
      // Requested first (most recent review first, then by login), then the rest; kim
      // reviewed an older head and was asked again.
      reviewers: [
        { login: "teammate-kim", state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: this.at(3 * HOUR), stale: true, requested: true, avatarUrl: avatar("teammate-kim") },
        { login: "acme/core", isTeam: true, requested: true, avatarUrl: avatar("acme/core") },
        { login: "teammate-ana", requested: true, avatarUrl: avatar("teammate-ana") },
        { login: "coderabbitai", isBot: true, state: PullRequestReviewState.COMMENTED, submittedAt: this.at(6 * HOUR), stale: true, avatarUrl: avatar("coderabbitai") },
      ],
      reviewersTruncated: true,
      commits: [
        ["5a1e0c3d2b9f8e7d6c5b4a39281706f5e4d3c2b1", "fix(terminal): size from the attach snapshot", 9 * HOUR],
        ["6b2f1d4e3c0a9f8e7d6c5b4a39281706f5e4d3c2", "test(terminal): resize during first output", 7 * HOUR],
        ["7c3a2e5f4d1b0a9f8e7d6c5b4a39281706f5e4d3", "refactor(terminal): resize inside the actor", 4 * HOUR],
        ["8d4b3f6a5e2c1b0a9f8e7d6c5b4a39281706f5e4", "fix(terminal): replay resize after snapshot", 2 * HOUR],
      ].map(([sha = "", headline = "", ago = 0]) => ({ sha: String(sha), headline: String(headline), authorLogin: this.h.viewer, authorName: "Alex", committedAt: this.at(Number(ago)) })),
      commitCount: 4,
      comments: [
        c(PullRequestCommentKind.REVIEW, "PRR_bot", "coderabbitai", "**Walkthrough**\n\nThe resize now happens on the actor goroutine. 2 actionable comments.", 6 * HOUR, {
          authorIsBot: true,
          reviewState: PullRequestReviewState.COMMENTED,
        }),
        c(PullRequestCommentKind.ISSUE_COMMENT, "IC_1", "teammate-kim", "Does this also fix the flicker when the sidebar collapses?", 5 * HOUR),
        c(PullRequestCommentKind.ISSUE_COMMENT, "IC_2", this.h.viewer, "Partly: the flicker had a second cause in the layout pass. Follow-up PR.", 4 * HOUR),
        c(PullRequestCommentKind.ISSUE_COMMENT, "IC_ghost", "", "Same race shows up on Linux under load.", 3.5 * HOUR, { authorAvatarUrl: "" }),
        c(PullRequestCommentKind.REVIEW, "PRR_kim", "teammate-kim", "The replay can still drop a resize that arrives during the snapshot. See inline.", 3 * HOUR, {
          reviewState: PullRequestReviewState.CHANGES_REQUESTED,
        }),
      ],
      commentsTruncated: false,
      reviewThreads: [
        {
          id: "PRRT_1",
          path: "internal/store/terminal/actor.go",
          line: 214,
          side: DiffSide.RIGHT,
          isResolved: false,
          isOutdated: false,
          comments: [
            c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_1", "teammate-kim", "A resize queued while `snapshot()` runs is overwritten here.", 3 * HOUR, { path: "internal/store/terminal/actor.go", reviewId: "PRR_kim" }),
            // A reply: its review (COMMENTED, empty body) is not in comments, like the daemon's.
            c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_2", this.h.viewer, "Good catch. Keeping the last pending size instead.", 2 * HOUR, { path: "internal/store/terminal/actor.go", reviewId: "PRR_reply" }),
          ],
        },
        {
          id: "PRRT_2",
          path: "internal/store/terminal/attach.go",
          line: 88,
          side: DiffSide.RIGHT,
          isResolved: false,
          isOutdated: false,
          comments: [c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_3", "coderabbitai", "Consider returning the error from `Resize` instead of logging it.", 6 * HOUR, { authorIsBot: true, path: "internal/store/terminal/attach.go", reviewId: "PRR_bot" })],
        },
        {
          id: "PRRT_3",
          path: "internal/store/terminal/terminal.go",
          line: 40,
          side: DiffSide.LEFT,
          isResolved: true,
          isOutdated: true,
          comments: [c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_4", "teammate-kim", "Why remove the size check?", 8 * HOUR, { path: "internal/store/terminal/terminal.go", reviewId: "PRR_kim_old" })],
        },
      ],
      reviewThreadsTruncated: false,
      checks: [
        { name: "test (macos-15)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/11", startedAt: this.at(100 * MIN), completedAt: this.at(92 * MIN) },
        { name: "lint", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/12", startedAt: this.at(100 * MIN), completedAt: this.at(98 * MIN) },
        { name: "build", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/13", startedAt: this.at(100 * MIN), completedAt: this.at(95 * MIN) },
        { name: "test (ubuntu-24.04)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/14", startedAt: this.at(100 * MIN), completedAt: this.at(90 * MIN) },
        { name: "e2e (webkit)", workflow: "CI", status: CheckStatus.IN_PROGRESS, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/15", startedAt: this.at(10 * MIN) },
        { name: "e2e (chromium)", workflow: "CI", status: CheckStatus.QUEUED, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/16" },
        { name: "release-notes", workflow: "Release", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SKIPPED, startedAt: this.at(100 * MIN), completedAt: this.at(100 * MIN) },
      ],
      nodeId: "PR_kwMock145",
      mergeMethodsAllowed: ALL_METHODS,
      viewerCanUpdate: true,
      viewerPermission: "admin",
      fetchedAt: this.at(20_000),
      lastError: "",
    };
  }

  private mergedDetail(pr: PrInit): DetailInit {
    const url = (id: string) => `https://github.com/${CF}/pull/138#${id}`;
    return {
      pullRequest: pr,
      body: "## Summary\n\nEvery GitHub request goes through one worker with a minimum gap, so bursts cannot trip the secondary rate limit.",
      labels: [{ name: "chore", color: "c5def5" }],
      reviewers: [{ login: "teammate-kim", state: PullRequestReviewState.APPROVED, submittedAt: this.at(DAY + 2 * HOUR), avatarUrl: avatar("teammate-kim") }],
      commits: [
        { sha: "1f0e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6", headline: "chore(gh): one worker for every request", authorLogin: this.h.viewer, authorName: "Alex", committedAt: this.at(2 * DAY) },
        { sha: "2a1f3e4d5c6b7a8998a7b6c5d4e3f2a1b0c9d8e7", headline: "test(gh): pacing", authorLogin: this.h.viewer, authorName: "Alex", committedAt: this.at(DAY + 5 * HOUR) },
      ],
      commitCount: 2,
      comments: [
        { id: "PRR_ok", kind: PullRequestCommentKind.REVIEW, author: "teammate-kim", authorAvatarUrl: avatar("teammate-kim"), body: "LGTM", createdAt: this.at(DAY + 2 * HOUR), url: url("PRR_ok"), reviewState: PullRequestReviewState.APPROVED },
        { id: "IC_m1", kind: PullRequestCommentKind.ISSUE_COMMENT, author: this.h.viewer, authorAvatarUrl: avatar(this.h.viewer), body: "Merging; the 1s gap is in the note.", createdAt: this.at(DAY + HOUR), url: url("IC_m1") },
      ],
      reviewThreads: [
        {
          id: "PRRT_m1",
          path: "internal/store/gh/pace.go",
          line: 31,
          side: DiffSide.RIGHT,
          isResolved: true,
          comments: [{ id: "PRRC_m1", kind: PullRequestCommentKind.REVIEW_COMMENT, author: "teammate-kim", body: "Jitter here too?", createdAt: this.at(DAY + 3 * HOUR), path: "internal/store/gh/pace.go", url: url("PRRC_m1") }],
        },
      ],
      checks: [
        { name: "build", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(DAY + 4 * HOUR), completedAt: this.at(DAY + 3 * HOUR) },
        { name: "lint", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(DAY + 4 * HOUR), completedAt: this.at(DAY + 3 * HOUR) },
        { name: "test (macos-15)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(DAY + 4 * HOUR), completedAt: this.at(DAY + 3 * HOUR) },
      ],
      mergeCommitSha: "3c3c4651aa0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d",
      mergedBy: this.h.viewer,
      closedAt: pr.mergedAt,
      nodeId: "PR_kwMock138",
      viewerCanUpdate: true,
      viewerPermission: "admin",
      fetchedAt: this.at(20_000),
      lastError: "",
    };
  }

  /** #131: closed without merging; the viewer's, so they could revert, but there is nothing to revert. */
  private closedDetail(): DetailInit {
    const pr = this.h.makePr(CF, 131, "feat(gui): tabbed terminals (superseded by split panes)", {
      headRef: "feat/tabs",
      state: PullRequestState.CLOSED,
      ageMs: 4 * DAY,
      reviewDecision: ReviewDecision.REVIEW_REQUIRED,
      checks: { state: CheckRollupState.SUCCESS, total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 },
    });
    return {
      pullRequest: pr,
      body: "Superseded by the split pane layout; closing.",
      commits: [{ sha: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d", headline: "feat(gui): terminal tabs", authorLogin: this.h.viewer, authorName: "Alex", committedAt: this.at(5 * DAY) }],
      commitCount: 1,
      comments: [{ id: "IC_c1", kind: PullRequestCommentKind.ISSUE_COMMENT, author: this.h.viewer, authorAvatarUrl: avatar(this.h.viewer), body: "Closing in favour of split panes.", createdAt: this.at(4 * DAY), url: `https://github.com/${CF}/pull/131#IC_c1` }],
      checks: [
        { name: "build", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(5 * DAY), completedAt: this.at(5 * DAY - 4 * MIN) },
        { name: "test (macos-15)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(5 * DAY), completedAt: this.at(5 * DAY - 9 * MIN) },
      ],
      closedAt: this.at(4 * DAY),
      nodeId: "PR_kwMock131",
      viewerCanUpdate: true,
      viewerPermission: "admin",
      fetchedAt: this.at(20_000),
    };
  }

  /**
   * #140: someone else's open pull request; the viewer can read only: the reviewer picker
   * explains that it needs write access instead of listing people, and there is no revert.
   */
  private readOnlyDetail(): DetailInit {
    const pr = this.h.makePr(CF, 140, "docs: contributing guide", {
      author: "outside-contrib",
      headRef: "docs/contributing",
      ageMs: 2 * DAY,
      checks: { state: CheckRollupState.PENDING, total: 1, passed: 0, failed: 0, pending: 1, skipped: 0 },
    });
    return {
      pullRequest: pr,
      body: "Adds CONTRIBUTING.md.",
      reviewers: [{ login: "teammate-kim", requested: true, avatarUrl: avatar("teammate-kim") }],
      commits: [{ sha: "4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a", headline: "docs: contributing guide", authorLogin: "outside-contrib", authorName: "Contributor", committedAt: this.at(2 * DAY) }],
      commitCount: 1,
      checks: [{ name: "build", workflow: "CI", status: CheckStatus.QUEUED, description: "Waiting for a maintainer to approve the workflow run" }],
      nodeId: "PR_kwMock140",
      mergeMethodsAllowed: ALL_METHODS,
      viewerCanUpdate: false,
      viewerPermission: "read",
      fetchedAt: this.at(20_000),
    };
  }

  /** #146: an outside contributor's open pull request from a fork, ready to merge. */
  private forkDetail(): DetailInit {
    const pr = this.h.makePr(CF, 146, "fix(cli): typo in --help", {
      author: "outside-contrib",
      headRef: "patch-1",
      headSha: "f04c146000000000000000000000000000000000",
      isCrossRepository: true,
      reviewDecision: ReviewDecision.APPROVED,
      mergeStateStatus: MergeStateStatus.CLEAN,
      ageMs: 6 * HOUR,
      checks: { state: CheckRollupState.SUCCESS, total: 1, passed: 1, failed: 0, pending: 0, skipped: 0 },
    });
    return {
      pullRequest: pr,
      body: "Fixes a typo.",
      commits: [{ sha: "f04c146000000000000000000000000000000000", headline: "fix(cli): typo in --help", authorLogin: "outside-contrib", authorName: "Contributor", committedAt: this.at(6 * HOUR) }],
      commitCount: 1,
      checks: [{ name: "build", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, startedAt: this.at(6 * HOUR), completedAt: this.at(6 * HOUR - 3 * MIN) }],
      nodeId: "PR_kwMock146",
      mergeMethodsAllowed: ALL_METHODS,
      viewerCanUpdate: true,
      viewerPermission: "admin",
      fetchedAt: this.at(20_000),
    };
  }

  /** A minimal detail from a listed pull request's summary. */
  private fromSummary(pr: PrInit): DetailInit {
    return {
      pullRequest: pr,
      body: "",
      reviewers: (pr.reviewRequests ?? []).map((login) => ({ login, isTeam: login.includes("/"), requested: true, avatarUrl: avatar(login) })),
      nodeId: `PR_kwMock${String(pr.number)}`,
      mergeMethodsAllowed: ALL_METHODS,
      viewerCanUpdate: pr.author === this.h.viewer,
      viewerPermission: pr.author === this.h.viewer ? "admin" : "read",
      mergedBy: pr.state === PullRequestState.MERGED ? pr.author : "",
      closedAt: pr.mergedAt,
      defaultBranch: "main",
      fetchedAt: this.at(20_000),
    };
  }

  private detailOf(slug: string, number: number): DetailInit {
    const k = key(slug, number);
    let d = this.details.get(k);
    if (!d) {
      const pr = this.h.findPr(slug, number);
      if (!pr) throw new PrDetailError("not_found", `Could not resolve to a PullRequest with the number of ${String(number)}.`);
      d = this.fromSummary(pr);
      this.details.set(k, d);
    }
    return d;
  }

  get(slug: string, number: number, refresh: boolean): DetailInit {
    this.h.count("GetPullRequestDetail");
    const d = this.detailOf(slug, number);
    if (refresh) d.fetchedAt = timestampFromDate(new Date());
    return d;
  }

  listCandidates(slug: string, number: number) {
    this.h.count("ListReviewerCandidates");
    const sorted = [...this.candidateList(slug, number)].sort(
      (a, b) => Number(Boolean(b.isRequested)) - Number(Boolean(a.isRequested)) || (a.login ?? "").localeCompare(b.login ?? ""),
    );
    return { candidates: sorted, truncated: false };
  }

  /** The candidates (stored, mutable), made up from teammates when none are set. */
  private candidateList(slug: string, number: number): CandidateInit[] {
    const d = this.detailOf(slug, number);
    const k = key(slug, number);
    let list = this.candidates.get(k);
    if (!list) {
      const author = d.pullRequest?.author ?? "";
      list = ["teammate-ana", "teammate-kim", "teammate-lee", this.h.viewer]
        .filter((l) => l !== author)
        .map((login) => ({ id: `U_${login}`, kind: ReviewerKind.USER, login, name: "", avatarUrl: avatar(login), isRequested: false }));
      this.candidates.set(k, list);
    }
    return list;
  }

  /** Requests or withdraws a review; updates the candidates and the detail's reviewers and announces it. */
  setReviewRequest(slug: string, number: number, login: string, kind: ReviewerKind, requested: boolean): string[] {
    this.h.count("SetReviewRequest");
    if (!login.trim()) throw new PrDetailError("invalid_argument", "login is required");
    const d = this.detailOf(slug, number);
    const list = this.candidateList(slug, number);
    const isTeam = kind === ReviewerKind.TEAM;
    let cand = list.find((c) => c.login === login);
    if (!cand) {
      cand = { id: `${isTeam ? "T" : "U"}_${login}`, kind: isTeam ? ReviewerKind.TEAM : ReviewerKind.USER, login, name: "", avatarUrl: avatar(login) };
      list.push(cand);
    }
    cand.isRequested = requested;
    const reviewers = d.reviewers ?? [];
    const cur = reviewers.find((r) => r.login === login);
    if (cur) {
      cur.requested = requested;
    } else if (requested) {
      reviewers.unshift({ login, isTeam, requested: true, avatarUrl: avatar(login) });
    }
    // A reviewer who never reviewed leaves the list with their request.
    d.reviewers = reviewers.filter((r) => r.requested || r.state);
    this.h.publishGh({ event: { case: "pullRequestDetailUpdated", value: { repoSlug: slug.toLowerCase(), number } } });
    return list.filter((c) => c.isRequested).map((c) => c.login ?? "");
  }

  /** The pull request detail panel's commands, as the daemon registers them (internal/command/commands_pr.go). */
  commands() {
    const slugArg = { name: "repo-slug", type: ArgType.STRING, required: true, description: 'GitHub repository, "owner/name"' };
    const numberArg = { name: "number", type: ArgType.INT, required: true, description: "Pull request number" };
    const target = (args: Record<string, string>): [string, number] => {
      const n = Number(args.number);
      if (!Number.isInteger(n) || n <= 0) throw new ConnectError("number must be a positive pull request number", Code.InvalidArgument);
      return [args["repo-slug"] ?? "", n];
    };
    const always = () => true;
    const out = (message: string, json: unknown): Promise<InvokeOut> => Promise.resolve({ message, resultJson: JSON.stringify(json) });
    return [
      {
        cmd: {
          name: "pr.merge",
          title: "Merge Pull Request",
          category: "Pull Request",
          description:
            "Merge an open pull request with a merge commit, squash, or rebase (GitHub's merge button); --delete-branch deletes its branch on GitHub afterwards (never local branches or worktrees).",
          keybindings: [],
          args: [
            slugArg,
            numberArg,
            { name: "method", type: ArgType.ENUM, required: true, description: "How to merge: a merge commit, squash, or rebase", enumValues: ["merge", "squash", "rebase"] },
            {
              name: "delete-branch",
              type: ArgType.BOOL,
              required: false,
              description: "Delete the head branch on GitHub (origin) after the merge; never a fork's, the default or the base branch, nor local branches or worktrees",
            },
            { name: "head-sha", type: ArgType.STRING, required: false, description: "Merge only if the head is still this commit (full SHA): refused when the pull request changed since you looked" },
          ],
          // Like the daemon's DynamicConfirm: the base from the detail, what merges without
          // head-sha, and the branch it deletes (origin's; not a fork's, the default or base).
          confirm: (_ctx: UiContext | undefined, args: Record<string, string>) => {
            const method = args.method ?? "";
            const k = key(args["repo-slug"] ?? "", Number(args.number));
            const d = this.details.get(k);
            const pr = d?.pullRequest ?? this.h.findPr(args["repo-slug"] ?? "", Number(args.number));
            if (!pr?.baseRef) return `Merge #${args.number ?? ""} with ${method}?`;
            let what = `#${args.number ?? ""}`;
            if (!args["head-sha"] && pr.headSha) {
              const c = d?.commitCount ?? 0;
              what += ` (${c === 1 ? "1 commit" : `${String(c)} commits`}, head ${pr.headSha.slice(0, 7)})`;
            }
            let msg = `Merge ${what} into ${pr.baseRef} with ${methodWords[method] ?? method}?`;
            if (args["delete-branch"] === "true" && keepBranch(pr, d?.defaultBranch ?? "main") === "") msg += ` Branch origin/${pr.headRef ?? ""} is deleted afterwards.`;
            return msg;
          },
        },
        when: always,
        run: async (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const [slug, n] = target(args);
          const method = methodNames[args.method ?? ""];
          if (method === undefined) throw new ConnectError("method must be merge, squash, or rebase", Code.InvalidArgument);
          if (this.sessionDelayMs > 0) await new Promise((r) => setTimeout(r, this.sessionDelayMs));
          const r = prDetailCall(() => this.merge(slug, n, method, args["delete-branch"] === "true", args["head-sha"] ?? ""));
          return out(r.message, r);
        },
      },
      {
        cmd: {
          name: "pr.revert",
          title: "Revert Pull Request",
          category: "Pull Request",
          description: "Open a pull request that reverses a merged one (GitHub's Revert button).",
          keybindings: [],
          args: [slugArg, numberArg],
          confirm: (_ctx: UiContext | undefined, args: Record<string, string>) => `This opens a new pull request that reverses the changes merged by #${args.number ?? ""}.`,
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const [slug, n] = target(args);
          const r = prDetailCall(() => this.revert(slug, n));
          return out(`Opened #${String(r.number)} to revert #${String(n)}: ${r.url}`, r);
        },
      },
      {
        cmd: {
          name: "pr.review.request",
          title: "Request Review",
          category: "Pull Request",
          description: "Request a review on a pull request from a user or team, or withdraw the request (--requested=false).",
          keybindings: [],
          args: [
            slugArg,
            numberArg,
            { name: "login", type: ArgType.STRING, required: true, description: 'User login, or a team as "org/team" (or its slug)' },
            { name: "kind", type: ArgType.ENUM, required: false, description: "Whether login is a user or a team", enumValues: ["user", "team"], defaultValue: "user" },
            { name: "requested", type: ArgType.BOOL, required: false, description: "Request the review (false withdraws the request)", defaultValue: "true" },
          ],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const [slug, n] = target(args);
          const login = (args.login ?? "").trim();
          const requested = args.requested !== "false";
          const kind = args.kind === "team" ? ReviewerKind.TEAM : ReviewerKind.USER;
          const pending = prDetailCall(() => this.setReviewRequest(slug, n, login, kind, requested));
          return out(requested ? `Requested a review from ${login} on #${String(n)}` : `Withdrew the review request for ${login} on #${String(n)}`, { requested: pending });
        },
      },
      {
        cmd: {
          name: "pr.refresh",
          title: "Refresh Pull Request",
          category: "Pull Request",
          description: "Fetch a pull request's detail from GitHub now instead of from the daemon's cache.",
          keybindings: [],
          args: [slugArg, numberArg],
        },
        when: always,
        run: (_ctx: UiContext | undefined, args: Record<string, string>) => {
          const [slug, n] = target(args);
          if (this.failNext.delete("pr.refresh")) {
            // Like the daemon: GitHub failed, so it answered with its cached copy and the command fails.
            throw new ConnectError(`refresh #${String(n)} failed, the cached copy is unchanged: github graphql: 502 Bad Gateway`, Code.Unavailable);
          }
          const d = prDetailCall(() => this.get(slug, n, true));
          return out(`Refreshed #${String(n)}: ${d.pullRequest?.title ?? ""}`, toJson(PullRequestDetailSchema, create(PullRequestDetailSchema, d)));
        },
      },
    ];
  }

  /** Opens a revert PR for a merged one (once; repeats return the same) and announces it. */
  revert(slug: string, number: number): { number: number; url: string } {
    this.h.count("RevertPullRequest");
    const k = key(slug, number);
    const done = this.reverts.get(k);
    if (done) return done;
    const state = this.detailOf(slug, number).pullRequest?.state;
    const pr = this.h.findPr(slug, number);
    if (state !== PullRequestState.MERGED || !pr) {
      const was = state === PullRequestState.CLOSED ? "closed" : "open";
      throw new PrDetailError("failed_precondition", `failed precondition: pull request #${String(number)} is ${was}, not merged`);
    }
    const n = this.nextNumber++;
    const res = { number: n, url: `https://github.com/${slug}/pull/${String(n)}` };
    this.reverts.set(k, res);
    this.h.addAuthored({
      ...pr,
      number: n,
      title: `Revert "${pr.title}"`,
      author: this.h.viewer,
      url: res.url,
      state: PullRequestState.OPEN,
      headRef: `revert-${String(number)}-${pr.headRef}`,
      mergedAt: undefined,
      createdAt: timestampFromDate(new Date()),
      updatedAt: timestampFromDate(new Date()),
    });
    this.h.publishGh({ event: { case: "pullRequestDetailUpdated", value: { repoSlug: slug.toLowerCase(), number } } });
    return res;
  }

  /**
   * Merges an open pull request (once; repeats in the session return the same, saying
   * when only the repeat asked for the branch), like the daemon: refused when it is not
   * open, a draft, conflicting, blocked, the method is not allowed, the viewer cannot
   * write, or expectedHeadSha is not its head. A success marks it merged, moves it to the
   * dashboard's recently merged and announces it. The branch (origin/<head>) is deleted
   * when asked, except a fork's, the default branch and the base branch.
   */
  merge(slug: string, number: number, method: PullRequestMergeMethod, deleteBranch: boolean, expectedHeadSha = ""): MergeOut {
    this.h.count("MergePullRequest");
    const k = key(slug, number);
    const done = this.merges.get(k);
    if (done) {
      if (deleteBranch && !done.deleteAsked) return { ...done.res, message: `${done.res.message}; branch not deleted: the first merge did not ask` };
      return done.res;
    }
    const d = this.detailOf(slug, number);
    const pr = d.pullRequest;
    if (method === PullRequestMergeMethod.UNSPECIFIED) throw new PrDetailError("invalid_argument", "method is required: merge, squash, or rebase");
    if (!pr) throw new PrDetailError("not_found", `Could not resolve to a PullRequest with the number of ${String(number)}.`);
    const refuse = (why: string) => new PrDetailError("failed_precondition", `failed precondition: ${why}`);
    if (pr.state !== PullRequestState.OPEN) throw refuse(`pull request #${String(number)} is ${pr.state === PullRequestState.MERGED ? "merged" : "closed"}, not open`);
    if (pr.draft) throw refuse(`pull request #${String(number)} is a draft`);
    if (!(d.mergeMethodsAllowed ?? []).includes(method)) throw refuse(`pull request #${String(number)} cannot be merged with ${methodWords[PullRequestMergeMethod[method].toLowerCase()] ?? "it"}: the repository does not allow it`);
    const head = pr.headSha ?? "";
    if (expectedHeadSha && expectedHeadSha.toLowerCase() !== head.toLowerCase()) {
      throw refuse(`pull request #${String(number)} changed since it was shown (head ${head.slice(0, 7)}, shown ${expectedHeadSha.slice(0, 7)}); refresh and try again`);
    }
    if (!d.viewerCanUpdate) throw new PrDetailError("permission_denied", "permission denied on github: Resource not accessible by integration");
    if (this.failNext.delete("pr.merge")) {
      throw refuse(`pull request #${String(number)} changed on GitHub since it was loaded (${pr.headRef ?? ""} has new commits); refresh and review it before merging`);
    }
    if (pr.mergeable === Mergeable.CONFLICTING) throw refuse("Pull Request is not mergeable");
    if (pr.mergeStateStatus === MergeStateStatus.BLOCKED) throw refuse("At least 1 approving review is required by reviewers with write access.");
    const now = timestampFromDate(new Date());
    const sha = `e2e${String(number).padStart(4, "0")}${"0".repeat(33)}`;
    pr.state = PullRequestState.MERGED;
    pr.mergedAt = now;
    pr.updatedAt = now;
    pr.mergeable = Mergeable.UNSPECIFIED;
    pr.mergeStateStatus = MergeStateStatus.UNSPECIFIED;
    d.mergeCommitSha = sha;
    d.mergedBy = this.h.viewer;
    d.closedAt = now;
    d.fetchedAt = now;
    const found = this.h.findPr(slug, number);
    if (found) this.h.markMerged(found);
    let message = `Merged #${String(number)} (${sha.slice(0, 7)})`;
    let branchDeleted = false;
    const branch = pr.headRef ?? "";
    if (deleteBranch && branch) {
      const why = keepBranch(pr, d.defaultBranch ?? "main");
      if (pr.isCrossRepository) message += `; kept ${branch}: ${why}`;
      else if (why) message += `; kept origin/${branch}: ${why}`;
      else {
        branchDeleted = true;
        message += `; deleted origin/${branch}`;
      }
    }
    const res: MergeOut = { merged: true, sha, message, branchDeleted };
    this.merges.set(k, { res, deleteAsked: deleteBranch });
    this.h.publishGh({ event: { case: "pullRequestDetailUpdated", value: { repoSlug: slug.toLowerCase(), number } } });
    return res;
  }

  /** A poll saw the pull request change: a new comment, announced like the daemon does. */
  addComment(slug: string, number: number, body: string): boolean {
    const d = this.details.get(key(slug, number));
    if (!d) return false;
    const id = `IC_mock_${String((d.comments ?? []).length + 1)}`;
    d.comments = [...(d.comments ?? []), { id, kind: PullRequestCommentKind.ISSUE_COMMENT, author: "teammate-kim", authorAvatarUrl: avatar("teammate-kim"), body, createdAt: timestampFromDate(new Date()), url: `https://github.com/${slug}/pull/${String(number)}#${id}` }];
    d.fetchedAt = timestampFromDate(new Date());
    this.h.publishGh({ event: { case: "pullRequestDetailUpdated", value: { repoSlug: slug.toLowerCase(), number } } });
    return true;
  }
}
