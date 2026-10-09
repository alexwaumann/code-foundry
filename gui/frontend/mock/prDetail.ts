/**
 * Mock GhService pull request detail panel: GetPullRequestDetail, ListReviewerCandidates,
 * SetReviewRequest, RevertPullRequest. Two rich fixtures on alexwaumann/code-foundry:
 *
 *   #145 open, draft, failing checks, changes requested (stale), two pending requests
 *        (a team and a user), a bot review, unresolved and outdated review threads,
 *        labels, issue comments
 *   #138 merged with a merge commit (the default branch head in mock/github.ts), an
 *        approval, a resolved thread; revertable
 *
 * Every other pull request the dashboards or branches list gets a minimal detail built
 * from its summary, so any row the GUI shows can open the panel.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import {
  CheckConclusion,
  CheckStatus,
  DiffSide,
  PullRequestCommentKind,
  PullRequestReviewState,
  PullRequestState,
  ReviewerKind,
  type GhEventSchema,
  type PullRequestDetailSchema,
  type ReviewerCandidateSchema,
} from "../src/gen/codefoundry/v1/gh_pb";
import type { PrInit } from "./github";

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
}
type GhEventInit = MessageInitShape<typeof GhEventSchema>;

/** Thrown for RPC errors; server.ts maps `code` to a ConnectError code. */
export class PrDetailError extends Error {
  constructor(
    readonly code: "not_found" | "failed_precondition" | "invalid_argument",
    message: string,
  ) {
    super(message);
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CF = "alexwaumann/code-foundry";

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
  count: (rpc: string) => void;
}

export class PrDetailWorld {
  private readonly details = new Map<string, DetailInit>();
  private readonly candidates = new Map<string, CandidateInit[]>();
  private readonly reverts = new Map<string, { number: number; url: string }>();
  private nextNumber = 151;

  constructor(private readonly h: PrDetailHooks) {
    const open = h.findPr(CF, 145);
    const merged = h.findPr(CF, 138);
    if (open) this.details.set(key(CF, 145), this.openDetail(open));
    if (merged) this.details.set(key(CF, 138), this.mergedDetail(merged));
    this.candidates.set(key(CF, 145), [
      { id: "T_core", kind: ReviewerKind.TEAM, login: "acme/core", name: "Core", avatarUrl: avatar("acme/core"), isRequested: true },
      { id: "U_ana", kind: ReviewerKind.USER, login: "teammate-ana", name: "Ana", avatarUrl: avatar("teammate-ana"), isRequested: true },
      { id: "U_kim", kind: ReviewerKind.USER, login: "teammate-kim", name: "Kim", avatarUrl: avatar("teammate-kim") },
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
      reviewers: [
        { login: "acme/core", isTeam: true, requested: true, avatarUrl: avatar("acme/core") },
        { login: "teammate-ana", requested: true, avatarUrl: avatar("teammate-ana") },
        { login: "teammate-kim", state: PullRequestReviewState.CHANGES_REQUESTED, submittedAt: this.at(3 * HOUR), stale: true, avatarUrl: avatar("teammate-kim") },
        { login: "coderabbitai", isBot: true, state: PullRequestReviewState.COMMENTED, submittedAt: this.at(6 * HOUR), stale: true, avatarUrl: avatar("coderabbitai") },
      ],
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
            c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_1", "teammate-kim", "A resize queued while `snapshot()` runs is overwritten here.", 3 * HOUR, { path: "internal/store/terminal/actor.go" }),
            c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_2", this.h.viewer, "Good catch. Keeping the last pending size instead.", 2 * HOUR, { path: "internal/store/terminal/actor.go" }),
          ],
        },
        {
          id: "PRRT_2",
          path: "internal/store/terminal/attach.go",
          line: 88,
          side: DiffSide.RIGHT,
          isResolved: false,
          isOutdated: false,
          comments: [c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_3", "coderabbitai", "Consider returning the error from `Resize` instead of logging it.", 6 * HOUR, { authorIsBot: true, path: "internal/store/terminal/attach.go" })],
        },
        {
          id: "PRRT_3",
          path: "internal/store/terminal/terminal.go",
          line: 40,
          side: DiffSide.LEFT,
          isResolved: true,
          isOutdated: true,
          comments: [c(PullRequestCommentKind.REVIEW_COMMENT, "PRRC_4", "teammate-kim", "Why remove the size check?", 8 * HOUR, { path: "internal/store/terminal/terminal.go" })],
        },
      ],
      reviewThreadsTruncated: false,
      checks: [
        { name: "test (macos-15)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/11", startedAt: this.at(100 * MIN), completedAt: this.at(92 * MIN) },
        { name: "lint", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.FAILURE, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/12", startedAt: this.at(100 * MIN), completedAt: this.at(98 * MIN) },
        { name: "build", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/13", startedAt: this.at(100 * MIN), completedAt: this.at(95 * MIN) },
        { name: "test (ubuntu-24.04)", workflow: "CI", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SUCCESS, url: "https://github.com/alexwaumann/code-foundry/actions/runs/1/job/14", startedAt: this.at(100 * MIN), completedAt: this.at(90 * MIN) },
        { name: "release-notes", workflow: "Release", status: CheckStatus.COMPLETED, conclusion: CheckConclusion.SKIPPED, startedAt: this.at(100 * MIN), completedAt: this.at(100 * MIN) },
      ],
      nodeId: "PR_kwMock145",
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

  /** A minimal detail from a listed pull request's summary. */
  private fromSummary(pr: PrInit): DetailInit {
    return {
      pullRequest: pr,
      body: "",
      reviewers: (pr.reviewRequests ?? []).map((login) => ({ login, isTeam: login.includes("/"), requested: true, avatarUrl: avatar(login) })),
      nodeId: `PR_kwMock${String(pr.number)}`,
      viewerCanUpdate: pr.author === this.h.viewer,
      viewerPermission: pr.author === this.h.viewer ? "admin" : "read",
      mergedBy: pr.state === PullRequestState.MERGED ? pr.author : "",
      closedAt: pr.mergedAt,
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
