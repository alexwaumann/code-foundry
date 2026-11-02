/**
 * The Pull Requests page's model (docs/notes/prs-page-2-gui.md): its five sections, their
 * rows and counts, the summary cards' subtitles, and the header's freshness. Pure.
 */
import type { DashboardView, ProjectPullRequestsView, PullRequestView } from "@/api/gh";
import type { Freshness } from "@/stores/gh";
import { ACTION_RANK, authoredRows, authoredStatus, type AuthoredRow, type AuthoredStatus, type AuthoredStatusKind } from "./authoredStatus";
import { reviewQueue, type NeedsRow, type ReviewedRow } from "./reviewQueue";

/** The page's sections, in page (and keyboard) order; each is a nav key prefix and a summary card. */
export type Section = "review" | "reviewed" | "authored" | "else" | "merged";

export const SECTIONS: readonly Section[] = ["review", "reviewed", "authored", "else", "merged"];

/** A row of "Everything else open in your projects": someone else's pull request and its status. */
export interface OtherRow {
  pr: PullRequestView;
  status: AuthoredStatus;
}

/** A row of "Merged in the last 7 days"; `involved` when it is in the viewer's own merged search (not dimmed). */
export interface MergedRowModel {
  pr: PullRequestView;
  involved: boolean;
}

export interface PageModel {
  needs: NeedsRow[];
  reviewed: ReviewedRow[];
  authored: AuthoredRow[];
  others: OtherRow[];
  merged: MergedRowModel[];
  /** What each card and section title counts: the rows, plus what a capped list holds beyond them. */
  counts: Record<Section, number>;
  /** Merged: the viewer's and the rest (counts.merged is their sum). */
  mergedInvolved: number;
  mergedMore: number;
  /**
   * A section whose project-wide list GitHub capped: the rows the section shows, the
   * count its title and card give (the same numbers as the table above the footer), and
   * the search on GitHub. Null when the list is not capped.
   */
  othersCap: Cap | null;
  mergedCap: Cap | null;
}

export interface Cap {
  shown: number;
  total: number;
  searchUrl: string;
}

/** The nav key of a section's cap footer: an option after its rows, so the keyboard reaches it too. */
export const capKey = (section: Section): string => `cap:${section}`;

export const prId = (p: Pick<PullRequestView, "repoSlug" | "number">): string => `${p.repoSlug.toLowerCase()}#${String(p.number)}`;

/** The pull requests GitHub matched beyond the list it returned (0 when uncapped). */
const hiddenCount = (l: ProjectPullRequestsView): number => Math.max(0, l.totalCount - l.pullRequests.length);

/** The footer for a section built on `l`, when `l` is capped: what the section shows of what it counts. */
function cap(l: ProjectPullRequestsView, shown: number, total: number): Cap | null {
  return l.pullRequests.length < l.totalCount ? { shown, total, searchUrl: l.searchUrl } : null;
}

/**
 * Someone else's open pull request's status, in the authored table's vocabulary
 * (authoredStatus), except that an approved, mergeable one is "Approved" (and one
 * mergeable without a required review "Mergeable"): "Ready to merge" is an author's call.
 */
export function otherStatus(pr: PullRequestView): AuthoredStatus {
  const s = authoredStatus(pr);
  if (s.kind !== "ready") return s;
  return { ...s, label: pr.review === "approved" ? "Approved" : "Mergeable" };
}

/**
 * "Everything else open": the project-wide open list minus what the viewer's own lists
 * already show (GitHub's index can lag behind the search's negations), newest updated first.
 */
export function otherRows(open: readonly PullRequestView[], shown: ReadonlySet<string>): OtherRow[] {
  const seen = new Set(shown);
  const out: OtherRow[] = [];
  for (const pr of open) {
    const id = prId(pr);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ pr, status: otherStatus(pr) });
  }
  return out.sort((a, b) => (b.pr.updatedAtMs ?? -Infinity) - (a.pr.updatedAtMs ?? -Infinity));
}

/**
 * "Merged in the last 7 days": the viewer's merged search (any repository) and the
 * project-wide one, deduplicated, newest merge first. A row only in the project list is
 * not the viewer's (dimmed).
 */
export function mergedRows(involved: readonly PullRequestView[], project: readonly PullRequestView[]): MergedRowModel[] {
  const seen = new Set<string>();
  const out: MergedRowModel[] = [];
  for (const [list, mine] of [
    [involved, true],
    [project, false],
  ] as const) {
    for (const pr of list) {
      const id = prId(pr);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ pr, involved: mine });
    }
  }
  return out.sort((a, b) => (b.pr.mergedAtMs ?? -Infinity) - (a.pr.mergedAtMs ?? -Infinity));
}

/**
 * The merged section's counts. `more` counts the rows not involving the viewer, plus the
 * project matches GitHub did not return when capped, less the viewer's own merges in
 * tracked repositories that are among those (they are counted as involving already).
 * Never fewer than the rows shown.
 */
export function mergedCounts(rows: readonly MergedRowModel[], project: ProjectPullRequestsView, trackedSlugs: readonly string[]): { involved: number; more: number } {
  const involved = rows.filter((r) => r.involved).length;
  const shownMore = rows.length - involved;
  const hidden = hiddenCount(project);
  if (hidden === 0) return { involved, more: shownMore };
  const tracked = new Set(trackedSlugs.map((s) => s.toLowerCase()));
  const inProject = new Set(project.pullRequests.map(prId));
  // The viewer's merges in a tracked repository that the capped list did not return: GitHub counted them in its total.
  const hiddenMine = rows.filter((r) => r.involved && tracked.has(r.pr.repoSlug.toLowerCase()) && !inProject.has(prId(r.pr))).length;
  return { involved, more: shownMore + Math.max(0, hidden - hiddenMine) };
}

export function pageModel(d: DashboardView): PageModel {
  const viewer = d.viewer?.login ?? "";
  const queue = reviewQueue(d.reviewRequested, d.reviewed, viewer);
  const authored = authoredRows(d.authored);
  const mine = new Set([...d.reviewRequested, ...d.reviewed, ...d.authored].map(prId));
  const others = otherRows(d.projectOpen.pullRequests, mine);
  const merged = mergedRows(d.recentlyMerged, d.projectMerged.pullRequests);
  const m = mergedCounts(merged, d.projectMerged, d.trackedSlugs);
  // Beyond the cap, the search's negations already left out the viewer's own.
  const elseCount = others.length + hiddenCount(d.projectOpen);
  const mergedCount = m.involved + m.more;
  return {
    needs: queue.needs,
    reviewed: queue.reviewed,
    authored,
    others,
    merged,
    counts: {
      review: queue.needs.length,
      reviewed: queue.reviewed.length,
      authored: authored.length,
      else: elseCount,
      merged: mergedCount,
    },
    mergedInvolved: m.involved,
    mergedMore: m.more,
    othersCap: cap(d.projectOpen, others.length, elseCount),
    mergedCap: cap(d.projectMerged, merged.length, mergedCount),
  };
}

/** How many rows a section shows (0: the section is hidden and its card disabled). */
export function sectionRows(m: PageModel, s: Section): number {
  switch (s) {
    case "review":
      return m.needs.length;
    case "reviewed":
      return m.reviewed.length;
    case "authored":
      return m.authored.length;
    case "else":
      return m.others.length;
    case "merged":
      return m.merged.length;
  }
}

/** The card filter as shown: none when it names a section that has no rows (it emptied after a poll). */
export function liveFilter(m: PageModel, filter: Section | null): Section | null {
  return filter !== null && sectionRows(m, filter) > 0 ? filter : null;
}

/** "a · b", leaving out empty parts. */
const join = (...parts: (string | false)[]): string => parts.filter(Boolean).join(" · ");

/** A status as a count's noun phrase: "1 CI failing", "2 awaiting review". */
const STATUS_PHRASE: Record<AuthoredStatusKind, string> = {
  conflicts: "with conflicts",
  ci_failing: "CI failing",
  changes_requested: "changes requested",
  behind: "behind base",
  blocked: "blocked",
  draft: "draft",
  awaiting_review: "awaiting review",
  no_reviewers: "no reviewers",
  ci_running: "CI running",
  ready: "ready to merge",
  open: "open",
};

/**
 * Which statuses the card names first: the ones that need the author (action needed,
 * worst first, then ready to merge), before the ones that wait on someone else.
 */
const subtitleOrder = (kind: AuthoredStatusKind, rank: number): number => (rank <= ACTION_RANK ? rank : kind === "ready" ? ACTION_RANK + 0.5 : rank + 100);

/**
 * The viewer's own pull requests in two status counts at most, in subtitleOrder:
 * "1 CI failing · 1 ready to merge", "1 draft · 2 awaiting review".
 */
export function authoredSubtitle(rows: readonly AuthoredRow[]): string {
  if (rows.length === 0) return "none open";
  const byKind = new Map<AuthoredStatusKind, { n: number; rank: number }>();
  for (const { status } of rows) {
    const c = byKind.get(status.kind);
    byKind.set(status.kind, { n: (c?.n ?? 0) + 1, rank: status.rank });
  }
  return [...byKind.entries()]
    .sort((a, b) => subtitleOrder(a[0], a[1].rank) - subtitleOrder(b[0], b[1].rank))
    .slice(0, 2)
    .map(([k, { n }]) => `${String(n)} ${STATUS_PHRASE[k]}`)
    .join(" · ");
}

/** "2 requested · 1 re-review": requests (by name or team) and reviews gone stale; "nothing waiting on you" at 0. */
export function needsSubtitle(rows: readonly NeedsRow[]): string {
  if (rows.length === 0) return "nothing waiting on you";
  const requested = rows.filter((r) => r.why === "requested" || r.why === "requested_team").length;
  const again = rows.length - requested;
  return join(requested > 0 && `${String(requested)} requested`, again > 0 && `${String(again)} re-review`);
}

/** "4 involving you · 3 more" (the card) or "… more in your projects" (the section title). */
export function mergedSubtitle(involved: number, more: number, long = false): string {
  if (involved + more === 0) return "nothing this week";
  return join(involved > 0 && `${String(involved)} involving you`, more > 0 && (long ? `${String(more)} more in your projects` : `${String(more)} more`));
}

export interface Card {
  section: Section;
  label: string;
  count: number;
  subtitle: string;
  /** The count in the warning colour (something waits on the viewer). */
  warn: boolean;
}

export function cards(m: PageModel): Card[] {
  return [
    { section: "review", label: "Needs your review", count: m.counts.review, subtitle: needsSubtitle(m.needs), warn: m.counts.review > 0 },
    { section: "reviewed", label: "Reviewed by you", count: m.counts.reviewed, subtitle: "open, waiting on the author", warn: false },
    { section: "authored", label: "Your pull requests", count: m.counts.authored, subtitle: authoredSubtitle(m.authored), warn: false },
    { section: "else", label: "Everything else open", count: m.counts.else, subtitle: "in your projects, updated in the last month", warn: false },
    { section: "merged", label: "Merged · 7 days", count: m.counts.merged, subtitle: mergedSubtitle(m.mergedInvolved, m.mergedMore), warn: false },
  ];
}

/**
 * The header's freshness over both of the page's fetches: the older fetch time (the
 * project lists' only once they were fetched) and the first error.
 */
export function olderFreshness(dashboard: Freshness, projects: Freshness): Freshness {
  const a = dashboard.fetchedAtMs;
  const b = projects.fetchedAtMs;
  return { fetchedAtMs: a === null || b === null ? a : Math.min(a, b), lastError: dashboard.lastError || projects.lastError };
}
