/**
 * The Pull request panel's readiness box (ReadinessBox.tsx) as pure data: a headline, one
 * row per requirement (draft, checks, reviews, conversations, conflicts, behind), and the
 * footer's controls. Table-tested in readiness.test.ts. The daemon and GitHub decide; this
 * only says what the detail shows.
 */
import type { CheckView, MergeMethodView, PullRequestDetailView, PullRequestReviewerView } from "@/api/gh";
import { mergeAvailability } from "./merge";
import { ago, checkTone, threadLocation, type Tone } from "./model";
import { reviewVisible, sameLogin } from "./review";

/** A row's or the headline's colour: the PR tones plus info (auto-merge). */
export type ReadyTone = Tone | "info";

/** The glyph of a row or the headline (ReadinessBox maps them to lucide icons). */
export type ReadyIcon =
  | "draft"
  | "failure"
  | "running"
  | "success"
  | "clock"
  | "eye"
  | "conversation"
  | "conflict"
  | "behind"
  | "approval"
  | "merged"
  | "closed"
  | "warning"
  | "auto-merge"
  | "lock"
  | "none";

/**
 * The issue an issue row hands to a thread: pr.task's kinds (internal/command). PR D2 fills
 * the row's slot with its "Fix/Address/Resolve/Update/Review in …" button.
 */
export type TaskKind = "checks" | "review" | "conversations" | "conflicts" | "behind" | "review-request";

export type RowId = "draft" | "checks" | "workflow-approval" | "review" | "review-request" | "conversations" | "conflicts" | "behind" | "blocked" | "mergeable" | "merged" | "closed";

/** A line under a row's title. */
export type SubLine =
  | { kind: "text"; text: string }
  /** A check by name (the component adds its duration with its own clock). */
  | { kind: "check"; check: CheckView }
  | { kind: "person"; login: string; avatarUrl: string; tone: ReadyTone; text: string }
  /** Review threads: "file.go:12" each, the full path for the tooltip. */
  | { kind: "locations"; items: { text: string; path: string; outdated: boolean }[] }
  | { kind: "commit"; sha: string };

/** A row's own button (the thread tasks are `task`, not an action). */
export type RowAction = { kind: "ready" } | { kind: "approve-workflow"; url: string } | { kind: "revert" };

export interface ReadinessRow {
  id: RowId;
  tone: ReadyTone;
  icon: ReadyIcon;
  title: string;
  /** Muted text after the title ("· 2 running · 2 passed"); "" for none. */
  meta: string;
  lines: SubLine[];
  action: RowAction | null;
  /** The issue this row can hand to a thread; null for passing rows. */
  task: TaskKind | null;
  /** It keeps the pull request from merging: counted in "N left". */
  blocking: boolean;
  /** The checks row: it expands to every check. */
  expandable: boolean;
}

export type FooterMerge = "merge" | "auto-merge" | "cancel-auto-merge";

export interface ReadinessFooter {
  /** Review ▾ (reviewVisible). */
  review: boolean;
  /** The viewer's review is requested: Review ▾ is the primary button. */
  reviewPrimary: boolean;
  /** The right-hand control; null for a viewer who cannot merge. */
  merge: FooterMerge | null;
  /** A line inside the Merge ▾ menu ("Auto-merge is off for this repository"). */
  mergeNote: string | null;
}

export interface Readiness {
  headline: { icon: ReadyIcon; tone: ReadyTone; title: string; meta: string };
  rows: ReadinessRow[];
  /** Null for merged and closed pull requests. */
  footer: ReadinessFooter | null;
}

export const AUTO_MERGE_OFF_NOTE = "Auto-merge is off for this repository";

/** How many failing (or running) checks a row names before "and N more". */
export const NAMED_CHECKS = 3;

const METHOD_WORDS: Record<MergeMethodView, string> = { merge: "merge commit", squash: "squash", rebase: "rebase" };

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Whether the detail was fetched from GitHub on this read, not a cached copy served after a
 * failed fetch (that copy may predate fields such as autoMergeAllowed, which then read
 * false: never treat false as final for it). A failed checks page leaves lastError set on
 * a fresh fetch, with checksTruncated.
 */
export function detailFresh(d: Pick<PullRequestDetailView, "lastError" | "checksTruncated">): boolean {
  return d.lastError === "" || d.checksTruncated;
}

/**
 * A queued run a maintainer has to approve: a first-time contributor's workflow
 * (GitHub's action_required), or a run waiting on an approval.
 */
export function awaitingApproval(c: Pick<CheckView, "conclusion" | "status" | "description">): boolean {
  if (c.conclusion === "action_required" || c.status === "waiting") return true;
  return checkTone(c) === "pending" && /approv/i.test(c.description);
}

interface CheckCounts {
  failed: number;
  running: number;
  passed: number;
  skipped: number;
  /** The rollup says failing without a failed count (a commit status). */
  failing: boolean;
}

/** The checks' counts: from the list (approval runs left out), else from the rollup (a detail built from a summary lists none). */
function checkCounts(d: PullRequestDetailView, checks: CheckView[]): CheckCounts {
  if (d.checks.length === 0) {
    const r = d.pullRequest.checks;
    return { failed: r.failed, running: r.pending, passed: r.passed, skipped: r.skipped, failing: r.failed === 0 && (r.state === "failure" || r.state === "error") };
  }
  const n = { failed: 0, running: 0, passed: 0, skipped: 0, failing: false };
  for (const c of checks) {
    const t = checkTone(c);
    if (t === "failure") n.failed++;
    else if (t === "pending") n.running++;
    else if (t === "success") n.passed++;
    else n.skipped++;
  }
  return n;
}

const named = (checks: CheckView[]): SubLine[] => {
  const lines: SubLine[] = checks.slice(0, NAMED_CHECKS).map((check) => ({ kind: "check", check }));
  if (checks.length > NAMED_CHECKS) lines.push({ kind: "text", text: `and ${String(checks.length - NAMED_CHECKS)} more` });
  return lines;
};

/** The checks row, or null when every check waits for approval (that row says so). */
function checksRow(d: PullRequestDetailView, checks: CheckView[], open: boolean): ReadinessRow | null {
  if (d.checks.length > 0 && checks.length === 0) return null;
  const n = checkCounts(d, checks);
  const total = n.failed + n.running + n.passed + n.skipped;
  const row = (tone: ReadyTone, icon: ReadyIcon, title: string, meta: string[], lines: SubLine[], blocking: boolean): ReadinessRow => ({
    id: "checks",
    tone,
    icon,
    title,
    meta: meta.filter(Boolean).join(" · "),
    lines,
    action: null,
    task: blocking && tone === "failure" && open ? "checks" : null,
    blocking: blocking && open,
    expandable: d.checks.length > 0,
  });
  const running = n.running > 0 ? `${String(n.running)} running` : "";
  const passed = n.passed > 0 ? `${String(n.passed)} passed` : "";
  const skipped = n.skipped > 0 ? `${String(n.skipped)} skipped` : "";
  if (n.failed > 0) {
    return row("failure", "failure", `${plural(n.failed, "check")} failing`, [running, passed, skipped], named(checks.filter((c) => checkTone(c) === "failure")), true);
  }
  if (n.failing) return row("failure", "failure", "Checks failing", [running, passed, skipped], [], true);
  if (n.running > 0) {
    return row("pending", "running", `${plural(n.running, "check")} running`, [passed, skipped], open ? named(checks.filter((c) => checkTone(c) === "pending")) : [], true);
  }
  if (total === 0) return row("neutral", "none", "No checks", [], [], false);
  if (n.passed === 0) return row("neutral", "none", `${plural(n.skipped, "check")} skipped`, [], [], false);
  const title = n.passed === 1 && n.skipped === 0 ? "1 check passed" : open ? `All ${plural(n.passed, "check")} passed` : `${plural(n.passed, "check")} passed`;
  return row("success", "success", title, [skipped], open ? [] : [{ kind: "text", text: "on the last push" }], false);
}

const names = (rs: readonly PullRequestReviewerView[]): string => rs.map((r) => r.login).join(", ");

/**
 * The reviews rows of an open pull request: the viewer's requested review, then what the
 * reviews say (changes requested, approved, required). The viewer is never in the
 * "waiting on" lists: their own row says it.
 */
function reviewRows(d: PullRequestDetailView, viewer: string, now: number): ReadinessRow[] {
  const pr = d.pullRequest;
  const isViewer = (r: PullRequestReviewerView) => !r.isTeam && sameLogin(r.login, viewer);
  const mine = d.reviewers.find((r) => r.requested && isViewer(r));
  const rows: ReadinessRow[] = [];
  const base = { action: null, expandable: false } as const;
  if (mine) {
    rows.push({
      ...base,
      id: "review-request",
      tone: "pending",
      icon: "eye",
      title: "Your review is requested",
      meta: "",
      lines: [{ kind: "text", text: pr.author ? `${pr.author} asked for your review` : "Asked for your review" }],
      task: "review-request",
      // Required reviews: the viewer's is the one missing.
      blocking: pr.review === "review_required",
    });
  }
  const changes = d.reviewers.filter((r) => r.state === "changes_requested");
  const approved = d.reviewers.filter((r) => r.state === "approved");
  const waiting = d.reviewers.filter((r) => r.requested && r.state !== "changes_requested" && !isViewer(r));
  const approvals: SubLine[] = approved.slice(0, NAMED_CHECKS).map((r) => ({
    kind: "person",
    login: r.login,
    avatarUrl: r.avatarUrl,
    tone: "success",
    text: `${r.login} approved${r.submittedAtMs === null ? "" : ` ${ago(r.submittedAtMs, now)}`}`,
  }));
  if (changes.length > 0 || pr.review === "changes_requested") {
    const who = [names(changes), waiting.length > 0 ? `still waiting on ${names(waiting)}` : ""].filter(Boolean).join(" · ");
    rows.push({ ...base, id: "review", tone: "failure", icon: "failure", title: "Changes requested", meta: "", lines: who ? [{ kind: "text", text: who }] : [], task: "review", blocking: true });
    return rows;
  }
  if (pr.review === "review_required") {
    if (mine && approvals.length === 0 && waiting.length === 0) return rows;
    const lines: SubLine[] = [...approvals, { kind: "text", text: waiting.length > 0 ? `Waiting on ${names(waiting)}` : "Waiting on a reviewer with write access" }];
    rows.push({ ...base, id: "review", tone: "pending", icon: "clock", title: approvals.length > 0 ? "More approvals required" : "Review required", meta: "", lines, task: null, blocking: true });
    return rows;
  }
  if (approvals.length > 0 || pr.review === "approved") {
    rows.push({ ...base, id: "review", tone: "success", icon: "success", title: "Approved", meta: "", lines: approvals, task: null, blocking: false });
    return rows;
  }
  // Reviews are not required here.
  if (mine) return rows;
  rows.push({
    ...base,
    id: "review",
    tone: "neutral",
    icon: "clock",
    title: waiting.length > 0 ? "Review requested" : "No reviews yet",
    meta: "",
    lines: waiting.length > 0 ? [{ kind: "text", text: `Waiting on ${names(waiting)}` }] : [],
    task: null,
    blocking: false,
  });
  return rows;
}

function conversationsRow(d: PullRequestDetailView): ReadinessRow | null {
  const open = d.reviewThreads.filter((t) => !t.isResolved);
  if (open.length === 0) return null;
  return {
    id: "conversations",
    tone: "pending",
    icon: "conversation",
    title: `${String(open.length)}${d.reviewThreadsTruncated ? "+" : ""} unresolved ${open.length === 1 ? "conversation" : "conversations"}`,
    meta: "",
    lines: [{ kind: "locations", items: open.map((t) => ({ text: threadLocation({ path: baseOf(t.path), line: t.line }), path: threadLocation(t), outdated: t.isOutdated })) }],
    action: null,
    task: "conversations",
    blocking: true,
    expandable: false,
  };
}

/** Conflicts, behind (only when GitHub reports BEHIND: it then blocks), or no conflicts. */
function mergeabilityRows(d: PullRequestDetailView): ReadinessRow[] {
  const pr = d.pullRequest;
  const base = pr.baseRef || "the base branch";
  const row = (id: RowId, tone: ReadyTone, icon: ReadyIcon, title: string, lines: SubLine[], task: TaskKind | null): ReadinessRow => ({ id, tone, icon, title, meta: "", lines, action: null, task, blocking: task !== null, expandable: false });
  if (pr.mergeable === "conflicting" || pr.mergeState === "dirty") return [row("conflicts", "failure", "conflict", `Conflicts with ${base}`, [], "conflicts")];
  const rows: ReadinessRow[] = [];
  if (pr.mergeState === "behind") rows.push(row("behind", "pending", "behind", `Behind ${base}`, [{ kind: "text", text: `This repository only merges branches that are up to date with ${base}.` }], "behind"));
  if (pr.mergeable === "mergeable") rows.push(row("mergeable", "success", "success", `No conflicts with ${base}`, [], null));
  return rows;
}

function openRows(d: PullRequestDetailView, viewer: string, now: number): ReadinessRow[] {
  const pr = d.pullRequest;
  const rows: ReadinessRow[] = [];
  if (pr.draft) {
    const mayChange = d.viewerCanUpdate || sameLogin(pr.author, viewer);
    rows.push({
      id: "draft",
      tone: "draft",
      icon: "draft",
      title: "Draft",
      meta: "",
      lines: [{ kind: "text", text: "Reviewers are not notified until it is ready." }],
      action: mayChange ? { kind: "ready" } : null,
      task: null,
      blocking: true,
      expandable: false,
    });
  }
  const approval = d.checks.filter(awaitingApproval);
  const checks = d.checks.filter((c) => !awaitingApproval(c));
  const c = checksRow(d, checks, true);
  if (c) rows.push(c);
  if (approval.length > 0) {
    rows.push({
      id: "workflow-approval",
      tone: "pending",
      icon: "approval",
      title: `${plural(approval.length, "workflow")} waiting for approval`,
      meta: "",
      lines: [{ kind: "text", text: "A maintainer has to approve the run (a first-time contributor's, or a protected environment's)." }],
      action: { kind: "approve-workflow", url: approval.find((a) => a.url)?.url || pr.url },
      task: null,
      blocking: true,
      expandable: false,
    });
  }
  rows.push(...reviewRows(d, viewer, now));
  const conv = conversationsRow(d);
  if (conv) rows.push(conv);
  rows.push(...mergeabilityRows(d));
  // Blocked with nothing above to say why: a requirement this detail does not show.
  if (pr.mergeState === "blocked" && !rows.some((r) => r.blocking)) {
    rows.push({ id: "blocked", tone: "pending", icon: "warning", title: "Blocked by branch protection", meta: "", lines: [{ kind: "text", text: "A required check, review or rule is not met yet." }], action: null, task: null, blocking: true, expandable: false });
  }
  return rows;
}

/** The footer of an open pull request: Review ▾, and Merge, Auto-merge or Cancel auto-merge. */
function openFooter(d: PullRequestDetailView, fresh: boolean, reviewPrimary: boolean): ReadinessFooter {
  const pr = d.pullRequest;
  const review = reviewVisible(d);
  const out = (merge: FooterMerge | null, mergeNote: string | null = null): ReadinessFooter => ({ review, reviewPrimary: review && reviewPrimary, merge, mergeNote });
  if (!d.viewerCanUpdate) return out(null);
  if (d.autoMergeEnabled) return out("cancel-auto-merge");
  if (mergeAvailability(d).reason === null) return out("merge");
  // Requirements still pending (checks, reviews, an update): GitHub can merge it once they pass.
  const pending = !pr.draft && pr.mergeable !== "conflicting" && (pr.mergeState === "blocked" || pr.mergeState === "behind");
  if (!pending || !fresh) return out("merge");
  return d.autoMergeAllowed ? out("auto-merge") : out("merge", AUTO_MERGE_OFF_NOTE);
}

function openHeadline(d: PullRequestDetailView, rows: ReadinessRow[]): Readiness["headline"] {
  const pr = d.pullRequest;
  if (d.autoMergeEnabled) return { icon: "auto-merge", tone: "info", title: "Auto-merge on", meta: d.autoMergeMethod ? METHOD_WORDS[d.autoMergeMethod] : "" };
  if (rows.some((r) => r.id === "review-request")) return { icon: "eye", tone: "pending", title: "Waiting on your review", meta: "" };
  if (!d.viewerCanUpdate) return { icon: "lock", tone: "neutral", title: "You can't merge this", meta: d.viewerPermission ? `${d.viewerPermission} access` : "" };
  const blocking = rows.filter((r) => r.blocking);
  if (blocking.length === 0) {
    if (mergeAvailability(d).reason === null) return { icon: "success", tone: "success", title: "Ready to merge", meta: "" };
    if ((pr.mergeable === "unknown" || pr.mergeable === null) && (pr.mergeState === "unknown" || pr.mergeState === "")) {
      return { icon: "clock", tone: "neutral", title: "Checking mergeability", meta: "" };
    }
    return { icon: "warning", tone: "pending", title: "Not ready to merge", meta: mergeAvailability(d).reason ?? "" };
  }
  const [only] = blocking;
  if (blocking.length === 1 && only?.id === "checks" && only.tone === "pending") {
    return { icon: "running", tone: "pending", title: "Waiting on checks", meta: only.title.replace(/ checks? running$/, " running") };
  }
  return { icon: "warning", tone: "pending", title: "Not ready to merge", meta: `${String(blocking.length)} left` };
}

/**
 * The readiness box for d as `viewer` sees it at `now`. `fresh` (detailFresh): the detail
 * was fetched on this read, so autoMergeAllowed=false is the repository's setting and not
 * a cached copy's default; a stale copy shows nothing about auto-merge.
 */
export function readiness(d: PullRequestDetailView, viewer: string, fresh: boolean, now: number): Readiness {
  const pr = d.pullRequest;
  const base = pr.baseRef || "the base branch";
  if (pr.state === "merged") {
    const by = d.mergedBy ? ` by ${d.mergedBy}` : "";
    const when = ago(pr.mergedAtMs ?? d.closedAtMs, now);
    return {
      headline: { icon: "merged", tone: "merged", title: "Merged", meta: "" },
      rows: [
        {
          id: "merged",
          tone: "merged",
          icon: "merged",
          title: `Merged into ${base}${by}${when ? ` ${when}` : ""}`,
          meta: "",
          lines: d.mergeCommitSha ? [{ kind: "commit", sha: d.mergeCommitSha }] : [],
          action: d.viewerCanUpdate ? { kind: "revert" } : null,
          task: null,
          blocking: false,
          expandable: false,
        },
      ],
      footer: null,
    };
  }
  if (pr.state === "closed") {
    const when = ago(d.closedAtMs, now);
    const rows: ReadinessRow[] = [{ id: "closed", tone: "failure", icon: "closed", title: when ? `Closed ${when}` : "Closed", meta: "", lines: [], action: null, task: null, blocking: false, expandable: false }];
    const c = checksRow(d, d.checks, false);
    if (c) rows.push(c);
    return { headline: { icon: "closed", tone: "failure", title: "Closed without merging", meta: "" }, rows, footer: null };
  }
  if (pr.state !== "open") return { headline: { icon: "none", tone: "neutral", title: "Unknown state", meta: "" }, rows: [], footer: null };
  const rows = openRows(d, viewer, now);
  return { headline: openHeadline(d, rows), rows, footer: openFooter(d, fresh, rows.some((r) => r.id === "review-request")) };
}
