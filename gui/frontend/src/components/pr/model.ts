/**
 * Pure view logic of the Pull request surface: state badge, checks headline, check
 * tones and durations, reviewer status, the summary's conversation and the timeline.
 */
import type { CheckRollupView, CheckView, PullRequestCommentView, PullRequestCommitView, PullRequestDetailView, PullRequestReviewerView, PullRequestView, ReviewThreadView } from "@/api/gh";
import { shortAge } from "@/components/prs/format";
import { formatUptime } from "@/lib/format";
import type { SortOrder } from "@/stores/prPanel";

export type Tone = "success" | "failure" | "pending" | "neutral" | "merged" | "draft";

/** The header's state badge: Open, Draft, Merged or Closed. */
export function stateBadge(pr: Pick<PullRequestView, "state" | "draft">): { label: string; tone: Tone } {
  switch (pr.state) {
    case "merged":
      return { label: "Merged", tone: "merged" };
    case "closed":
      return { label: "Closed", tone: "failure" };
    case "open":
      return pr.draft ? { label: "Draft", tone: "draft" } : { label: "Open", tone: "success" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}

/**
 * The header's checks line from the rollup: "All checks passed", "2 failing", "3 pending",
 * "No checks". A failing or pending state without a count says so without a number.
 */
export function checksHeadline(c: CheckRollupView): { tone: Tone; text: string } {
  if (c.total === 0 && c.state === "none") return { tone: "neutral", text: "No checks" };
  if (c.failed > 0) return { tone: "failure", text: `${String(c.failed)} failing` };
  if (c.state === "failure" || c.state === "error") return { tone: "failure", text: "Checks failing" };
  if (c.pending > 0) return { tone: "pending", text: `${String(c.pending)} pending` };
  if (c.state === "pending" || c.state === "expected") return { tone: "pending", text: "Checks pending" };
  return { tone: "success", text: "All checks passed" };
}

const failing = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);
const skipped = new Set(["skipped", "neutral", "stale"]);

/** One check's status bucket: from its conclusion once completed, else pending. */
export function checkTone(c: Pick<CheckView, "conclusion" | "status">): "success" | "failure" | "pending" | "skipped" {
  if (c.conclusion === "success") return "success";
  if (failing.has(c.conclusion)) return "failure";
  if (skipped.has(c.conclusion)) return "skipped";
  return c.status === "completed" && c.conclusion !== "" ? "skipped" : "pending";
}

/** "1m 32s" from start to completion (or to now while running); "" when it never started. */
export function checkDuration(c: Pick<CheckView, "startedAtMs" | "completedAtMs">, now: number): string {
  if (c.startedAtMs === null) return "";
  const end = c.completedAtMs ?? now;
  return formatUptime(Math.max(0, (end - c.startedAtMs) / 1000));
}

/** Whether a check is running now (its duration grows every second). */
export function checkRunning(c: Pick<CheckView, "startedAtMs" | "completedAtMs" | "status">): boolean {
  return c.startedAtMs !== null && c.completedAtMs === null && c.status !== "completed";
}

/** A check row's right-hand text: "skipped", its duration, or its pending status ("queued"). */
export function checkMeta(c: Pick<CheckView, "conclusion" | "status" | "startedAtMs" | "completedAtMs">, now: number): string {
  const tone = checkTone(c);
  if (tone === "skipped") return "skipped";
  const duration = checkDuration(c, now);
  if (duration) return duration;
  return tone === "pending" ? c.status.replace("_", " ") : "";
}

/**
 * Relative age with "ago", on the Pull Requests page's scale (shortAge): "just now",
 * "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago"; "" when unknown.
 */
export function ago(ms: number | null, now: number): string {
  if (ms === null) return "";
  const a = shortAge(ms, now);
  return a === "now" ? "just now" : `${a} ago`;
}

export type ReviewerStatus = "approved" | "changes_requested" | "commented" | "dismissed" | "requested" | "none";

/** What a reviewer row shows: the latest review's state, else a pending request. */
export function reviewerStatus(r: Pick<PullRequestReviewerView, "state" | "requested" | "stale">): { status: ReviewerStatus; label: string } {
  const suffix = (r.requested && r.state ? " · review requested again" : "") + (r.stale ? " · on an older commit" : "");
  switch (r.state) {
    case "approved":
      return { status: "approved", label: `Approved${suffix}` };
    case "changes_requested":
      return { status: "changes_requested", label: `Requested changes${suffix}` };
    case "commented":
      return { status: "commented", label: `Commented${suffix}` };
    case "dismissed":
      return { status: "dismissed", label: `Review dismissed${suffix}` };
    default:
      return r.requested ? { status: "requested", label: "Review requested" } : { status: "none", label: "" };
  }
}

/** A review's verb for its comment header: "approved", "requested changes", "reviewed". */
export function reviewVerb(state: PullRequestCommentView["reviewState"]): string {
  switch (state) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "requested changes";
    case "dismissed":
      return "review dismissed";
    default:
      return "reviewed";
  }
}

/**
 * Newest first or oldest first by `at` (default atMs); unknown times (null) always last;
 * ties by rank, then input order.
 */
function byTime<T extends { atMs: number | null }>(items: T[], order: SortOrder, rank: (t: T) => number = () => 0, at: (t: T) => number | null = (t) => t.atMs): T[] {
  const dir = order === "newest" ? -1 : 1;
  return items
    .map((it, i) => ({ it, i, at: at(it) }))
    .sort((a, b) => {
      if (a.at === null || b.at === null) return a.at === b.at ? a.i - b.i : a.at === null ? 1 : -1;
      return (a.at - b.at) * dir || (rank(b.it) - rank(a.it)) * -dir || a.i - b.i;
    })
    .map((x) => x.it);
}

export type ConversationItem =
  | { kind: "comment"; key: string; atMs: number | null; comment: PullRequestCommentView }
  | { kind: "thread"; key: string; atMs: number | null; thread: ReviewThreadView };

/**
 * The summary's Comments: issue comments and reviews, plus review threads (each one item,
 * at its first comment's time, its comments oldest first inside), in `order`.
 */
export function conversation(d: Pick<PullRequestDetailView, "comments" | "reviewThreads">, order: SortOrder): ConversationItem[] {
  const items: ConversationItem[] = [
    ...d.comments.map((c): ConversationItem => ({ kind: "comment", key: `c:${c.id}`, atMs: c.createdAtMs, comment: c })),
    ...d.reviewThreads.map((t): ConversationItem => ({ kind: "thread", key: `t:${t.id}`, atMs: t.comments[0]?.createdAtMs ?? null, thread: t })),
  ];
  return byTime(items, order);
}

/**
 * Comments the header and the summary count: issue comments, reviews with a body or a
 * verdict, and every thread comment (replies included). The Timeline counts its entries
 * instead (it leaves thread comments in the summary).
 */
export function commentCount(d: Pick<PullRequestDetailView, "comments" | "reviewThreads">): number {
  return d.comments.length + d.reviewThreads.reduce((n, t) => n + t.comments.length, 0);
}

export type TimelineEntry =
  | { kind: "merged"; key: string; atMs: number | null; actor: string }
  | { kind: "closed"; key: string; atMs: number | null }
  | { kind: "opened"; key: string; atMs: number | null; actor: string }
  | { kind: "commit"; key: string; atMs: number | null; commit: PullRequestCommitView }
  | { kind: "comment"; key: string; atMs: number | null; comment: PullRequestCommentView }
  | { kind: "review"; key: string; atMs: number | null; comment: PullRequestCommentView };

/** Same-time order, newest first: the end state, then reviews, comments, commits, and the opening. */
const timelineRank: Record<TimelineEntry["kind"], number> = { merged: 5, closed: 5, review: 4, comment: 3, commit: 2, opened: 1 };

/**
 * The Timeline tab: merged (or closed), opened, commits, issue comments and reviews, in
 * `order` (newest first by default). Inline review comments stay in the summary's threads.
 */
export function timeline(d: Pick<PullRequestDetailView, "pullRequest" | "commits" | "comments" | "mergedBy" | "closedAtMs">, order: SortOrder = "newest"): TimelineEntry[] {
  const pr = d.pullRequest;
  const out: TimelineEntry[] = [];
  if (pr.state === "merged") out.push({ kind: "merged", key: "merged", atMs: pr.mergedAtMs ?? d.closedAtMs, actor: d.mergedBy });
  else if (pr.state === "closed") out.push({ kind: "closed", key: "closed", atMs: d.closedAtMs });
  out.push({ kind: "opened", key: "opened", atMs: pr.createdAtMs, actor: pr.author });
  for (const c of d.commits) out.push({ kind: "commit", key: `k:${c.sha}`, atMs: c.committedAtMs, commit: c });
  for (const c of d.comments) {
    if (c.kind === "review") out.push({ kind: "review", key: `r:${c.id}`, atMs: c.createdAtMs, comment: c });
    else out.push({ kind: "comment", key: `c:${c.id}`, atMs: c.createdAtMs, comment: c });
  }
  // The end state is the latest event even when its time is unknown: it sorts after
  // everything (first when newest first), not with the unknowns.
  const end = (e: TimelineEntry) => e.kind === "merged" || e.kind === "closed";
  return byTime(out, order, (e) => timelineRank[e.kind], (e) => (end(e) && e.atMs === null ? Number.MAX_SAFE_INTEGER : e.atMs));
}

/** A thread's location: "path:line" (the line is left out when unknown). */
export function threadLocation(t: Pick<ReviewThreadView, "path" | "line">): string {
  return t.line > 0 ? `${t.path}:${String(t.line)}` : t.path;
}

/** GitHub avatar for a login when the daemon gave none ("" for deleted accounts and teams). */
export function avatarFor(login: string, known = ""): string {
  if (known) return known;
  if (!login || login.includes("/")) return "";
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`;
}

/** Absolute http(s) URL for a link in a GitHub body (relative ones are github.com paths); null otherwise. */
export function resolveLink(href: string | undefined): string | null {
  if (!href || href.startsWith("#")) return null;
  try {
    const u = new URL(href, "https://github.com/");
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
