import {
  Ban,
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Eye,
  GitCompareArrows,
  GitPullRequest,
  GitPullRequestDraft,
  MessageCircle,
  RotateCw,
  TriangleAlert,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import type { PullRequestView } from "@/api/gh";
import { YOUR_REVIEW_SPECS } from "@/components/pr/review";
import { statusPill, toneText } from "@/components/pr/tones";
import { GroupLabel, RowGrid, TABLE_BODY, TABLE_BOX, TABLE_ROW, TABLE_ROW_H, TableHead } from "@/components/table/TableParts";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { QUIET } from "@/lib/quiet";
import { useWidth } from "@/lib/useWidth";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestKey } from "@/stores/gh";
import { usePrPrefetch } from "@/stores/prPrefetch";
import type { AuthoredRow, AuthoredStatus, AuthoredStatusKind } from "./authoredStatus";
import { COLUMNS, gridTemplate, RIGHT, visibleColumns, type Column } from "./columns";
import { prKey, repoName } from "./format";
import { capKey, tableItems, type Cap, type MergedRowModel, type OtherRow, type Section } from "./pageModel";
import { Age, ChecksBadge, Diff, PrStateIcon } from "./PrBits";
import { needsLabel, type NeedsRow, type NeedsWhy, type ReviewedRow, type Verdict } from "./reviewQueue";
import { RowList, VIRTUALIZE_OVER } from "./RowList";

/** The columns a table shows and their grid template, from its own width (PrTable); rows read it. */
interface Shown {
  cols: readonly Column[];
  template: string;
}
const ShownColumns = createContext<Shown | null>(null);

const WHY_LOOK: Record<NeedsWhy, { icon: LucideIcon; cls: string }> = {
  requested: { icon: Eye, cls: "text-cf-text" },
  requested_team: { icon: Eye, cls: toneText.neutral },
  new_commits: { icon: RotateCw, cls: toneText.pending },
  dismissed: { icon: RotateCw, cls: toneText.pending },
};

const VERDICT_LOOK: Record<Verdict, { icon: LucideIcon; cls: string }> = {
  approved: { icon: Check, cls: toneText.success },
  changes_requested: { icon: TriangleAlert, cls: toneText.failure },
  commented: { icon: MessageCircle, cls: toneText.neutral },
};

const STATUS_ICON: Record<AuthoredStatusKind, LucideIcon> = {
  conflicts: GitCompareArrows,
  ci_failing: CircleX,
  changes_requested: TriangleAlert,
  behind: Clock,
  blocked: Ban,
  draft: GitPullRequestDraft,
  awaiting_review: Eye,
  no_reviewers: UserX,
  ci_running: CircleDot,
  ready: CircleCheck,
  open: GitPullRequest,
};

function IconLabel({ icon: Icon, cls, label, testId, value }: { icon: LucideIcon; cls: string; label: string; testId: string; value: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-body-sm", cls)} data-testid={testId} data-value={value}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function StatusPill({ status }: { status: AuthoredStatus }) {
  const Icon = STATUS_ICON[status.kind];
  return (
    <span
      className={cn("flex h-5 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-caption font-medium", statusPill[status.tone])}
      data-testid="prs-status"
      data-status={status.kind}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{status.label}</span>
    </span>
  );
}

function Repo({ pr }: { pr: PullRequestView }) {
  return (
    <Tip label={pr.repoSlug}>
      <span className="truncate text-cf-text-muted">{repoName(pr.repoSlug)}</span>
    </Tip>
  );
}

function Num({ pr }: { pr: PullRequestView }) {
  return (
    <span className="flex items-center gap-1 text-cf-text-muted tabular-nums">
      <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
    </span>
  );
}

function Author({ pr, viewer }: { pr: PullRequestView; viewer: string }) {
  const you = pr.author !== "" && pr.author.toLowerCase() === viewer.toLowerCase();
  return <span className="truncate text-cf-text-muted">{you ? "you" : pr.author || "ghost"}</span>;
}

function Title({ pr }: { pr: PullRequestView }) {
  return (
    <Tip label={pr.title} whenTruncated>
      <span className="truncate">
        {pr.draft && <span className="mr-1.5 rounded-sm bg-cf-surface-sunken px-1 text-caption-sm uppercase">draft</span>}
        {pr.title}
      </span>
    </Tip>
  );
}

type Cells = Partial<Record<Column, ReactNode>>;

/**
 * A table row: the cells of the columns its table shows, in order. Enter and click open
 * it in a tab (the page's nav), cmd+click on GitHub.
 */
function Row({ section, pr, className, cells }: { section: Section; pr: PullRequestView; className?: string; cells: Cells }) {
  const shown = useContext(ShownColumns);
  const cols = shown?.cols ?? COLUMNS[section];
  const warm = usePrPrefetch(pullRequestKey(pr.repoSlug, pr.number));
  return (
    <NavRow
      navKey={prKey(section, pr)}
      activateOnClick
      onCmdClick={() => void openUrl(pr.url)}
      {...warm}
      className={cn(TABLE_ROW, className)}
    >
      <RowGrid template={shown?.template ?? gridTemplate(cols)}>
        {cols.map((c) => (
          <Fragment key={c}>{cells[c]}</Fragment>
        ))}
      </RowGrid>
    </NavRow>
  );
}


export function NeedsReviewRow({ row, viewer }: { row: NeedsRow; viewer: string }) {
  const { pr, why } = row;
  const look = WHY_LOOK[why];
  return (
    <Row
      section="review"
      pr={pr}
      cells={{
        Repository: <Repo pr={pr} />,
        "#": <Num pr={pr} />,
        Author: <Author pr={pr} viewer={viewer} />,
        Title: <Title pr={pr} />,
        Why: <IconLabel icon={look.icon} cls={look.cls} label={needsLabel[why]} testId="prs-why" value={why} />,
        Checks: <ChecksBadge checks={pr.checks} />,
        Diff: <Diff pr={pr} />,
        Age: <Age ms={pr.updatedAtMs} className="text-right" />,
      }}
    />
  );
}

export function ReviewedByYouRow({ row, viewer }: { row: ReviewedRow; viewer: string }) {
  const { pr, verdict } = row;
  const look = VERDICT_LOOK[verdict];
  return (
    // Waiting on the author.
    <Row
      section="reviewed"
      pr={pr}
      className={QUIET}
      cells={{
        Repository: <Repo pr={pr} />,
        "#": <Num pr={pr} />,
        Author: <Author pr={pr} viewer={viewer} />,
        Title: <Title pr={pr} />,
        "Your review": <IconLabel icon={look.icon} cls={look.cls} label={YOUR_REVIEW_SPECS[verdict].label} testId="prs-verdict" value={verdict} />,
        Checks: <ChecksBadge checks={pr.checks} />,
        Diff: <Diff pr={pr} />,
        Age: <Age ms={pr.updatedAtMs} className="text-right" />,
      }}
    />
  );
}

export function AuthoredPrRow({ row }: { row: AuthoredRow }) {
  const { pr, status } = row;
  const comments = pr.comments + pr.reviews;
  return (
    <Row
      section="authored"
      pr={pr}
      cells={{
        Repository: <Repo pr={pr} />,
        "#": <Num pr={pr} />,
        Title: <Title pr={pr} />,
        Status: <StatusPill status={status} />,
        Checks: <ChecksBadge checks={pr.checks} />,
        Comments: (
          <span className="flex items-center gap-1 text-body-sm text-cf-text-muted tabular-nums" aria-label={`${String(comments)} comments and reviews`} data-testid="prs-comments">
            <MessageCircle className="size-3.5 shrink-0" aria-hidden />
            {comments}
          </span>
        ),
        Diff: <Diff pr={pr} />,
        Age: <Age ms={pr.updatedAtMs} className="text-right" />,
      }}
    />
  );
}

/** Someone else's open pull request in a tracked repository (its repository is the group label above it). */
export function OtherPrRow({ row, viewer }: { row: OtherRow; viewer: string }) {
  const { pr, status } = row;
  return (
    <Row
      section="else"
      pr={pr}
      cells={{
        "#": <Num pr={pr} />,
        Author: <Author pr={pr} viewer={viewer} />,
        Title: <Title pr={pr} />,
        Status: <StatusPill status={status} />,
        Checks: <ChecksBadge checks={pr.checks} />,
        Diff: <Diff pr={pr} />,
        Age: <Age ms={pr.updatedAtMs} className="text-right" />,
      }}
    />
  );
}

/** A merge this week (its repository is the group label above it); one not involving the viewer (the project-wide list only) is dimmed. */
export function MergedRow({ row, viewer }: { row: MergedRowModel; viewer: string }) {
  const { pr, involved } = row;
  return (
    <Row
      section="merged"
      pr={pr}
      className={involved ? undefined : QUIET}
      cells={{
        "#": <Num pr={pr} />,
        Author: <Author pr={pr} viewer={viewer} />,
        Title: <Title pr={pr} />,
        Diff: <Diff pr={pr} />,
        Merged: <Age ms={pr.mergedAtMs} className="text-right" />,
      }}
    />
  );
}

/**
 * A capped project-wide list's last line: how many of GitHub's matches show, and the
 * search there.
 *
 * An option of the page's listbox like the rows (no button inside it): Enter, click and
 * cmd+click open the search on GitHub (the page's nav item does it).
 */
function CapFooter({ section, cap }: { section: Section; cap: Cap }) {
  return (
    <div className="border-t p-0.5" data-testid="prs-cap">
      <NavRow navKey={capKey(section)} activateOnClick onCmdClick={() => void openUrl(cap.searchUrl)} className="flex h-7 items-center gap-1.5 px-2 text-caption">
        <span className="tabular-nums">
          Showing {cap.shown} of {cap.total}
        </span>
        <span aria-hidden>·</span>
        <span className="text-link" data-testid="prs-cap-link">
          See all on GitHub
        </span>
      </NavRow>
    </div>
  );
}

/** The sections whose rows are grouped by repository (pageModel's groupByRepo order) under a label row each. */
const GROUPED: ReadonlySet<Section> = new Set<Section>(["else", "merged"]);

/**
 * A bordered table: the column header row, the rows (under repository labels in a
 * grouped section), and the cap footer when GitHub matched more. It measures its own
 * width and shows the columns that fit (visibleColumns), least important dropped first.
 */
export function PrTable<T extends { pr: PullRequestView }>({ section, rows, render, cap, className }: { section: Section; rows: readonly T[]; render: (row: T) => ReactNode; cap?: Cap | null; className?: string }) {
  const [ref, width] = useWidth(1100);
  // clientWidth: the border is already out.
  const cols = useMemo(() => visibleColumns(section, width), [section, width]);
  const shown = useMemo<Shown>(() => ({ cols, template: gridTemplate(cols) }), [cols]);
  const items = useMemo(() => tableItems(rows, GROUPED.has(section)), [rows, section]);
  return (
    <ShownColumns value={shown}>
      <div ref={ref} className={cn(TABLE_BOX, className)} data-columns={cols.join(",")}>
        <TableHead template={shown.template}>
          {cols.map((h) => (
            <span key={h} className={cn(RIGHT.has(h) && "text-right")}>
              {h}
            </span>
          ))}
        </TableHead>
        <div className={TABLE_BODY}>
          <RowList
            rows={items}
            // The label lines do not make a list long: only its pull requests count.
            virtualize={rows.length > VIRTUALIZE_OVER}
            rowKey={(it) => (it.kind === "group" ? `group:${section}:${it.slug.toLowerCase()}` : prKey(section, it.row.pr))}
            rowHeight={TABLE_ROW_H}
            render={(it) => (it.kind === "group" ? <GroupLabel name={it.name} count={it.count} testId="prs-group" /> : render(it.row))}
          />
        </div>
        {cap && <CapFooter section={section} cap={cap} />}
      </div>
    </ShownColumns>
  );
}
