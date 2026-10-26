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
import type { ReactNode } from "react";
import type { PullRequestView } from "@/api/gh";
import { statusPill, toneText } from "@/components/pr/tones";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import type { AuthoredRow, AuthoredStatus, AuthoredStatusKind } from "./authoredStatus";
import { prKey, repoName } from "./format";
import { Age, ChecksBadge, PrStateIcon } from "./PrBits";
import { needsLabel, verdictLabel, type NeedsRow, type NeedsWhy, type ReviewedRow, type Verdict } from "./reviewQueue";
import { RowList } from "./RowList";

const ROW_H = 28;

/** The page's sections, in keyboard order; each is a nav key prefix. */
export type Section = "review" | "reviewed" | "authored" | "merged";

// Flexible tracks only (fr with a floor): fixed maxima grow before an fr track gets any
// room, which squeezed the title to nothing beside the side panel. Review and reviewed
// share a template, so the reviewed sub-card's columns line up under the queue's.
const REVIEW_COLS = "grid-cols-[minmax(5rem,0.8fr)_5rem_minmax(5rem,0.8fr)_minmax(6rem,2.4fr)_minmax(8.5rem,1.3fr)_minmax(6.5rem,1fr)_3rem]";
const columns: Record<Section, string> = {
  review: REVIEW_COLS,
  reviewed: REVIEW_COLS,
  authored: "grid-cols-[minmax(5rem,0.8fr)_5rem_minmax(6rem,2.4fr)_minmax(8.5rem,1.2fr)_minmax(6.5rem,1fr)_minmax(4.5rem,0.5fr)_3rem]",
  merged: "grid-cols-[minmax(5rem,0.8fr)_5rem_minmax(5rem,0.8fr)_minmax(6rem,2.4fr)_3rem]",
};

const headers: Record<Section, string[]> = {
  review: ["Repository", "#", "Author", "Title", "Why", "Checks", "Age"],
  reviewed: [],
  authored: ["Repository", "#", "Title", "Status", "Checks", "Comments", "Age"],
  merged: ["Repository", "#", "Author", "Title", "Merged"],
};

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

/** The cells every row starts with: repository and number. */
function Lead({ pr }: { pr: PullRequestView }) {
  return (
    <>
      <Tip label={pr.repoSlug}>
        <span className="truncate text-cf-text-muted">{repoName(pr.repoSlug)}</span>
      </Tip>
      <span className="flex items-center gap-1 text-cf-text-muted tabular-nums">
        <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
      </span>
    </>
  );
}

function Author({ pr, viewer }: { pr: PullRequestView; viewer: string }) {
  const you = pr.author !== "" && pr.author.toLowerCase() === viewer.toLowerCase();
  return <span className="truncate text-cf-text-muted">{you ? "you" : pr.author || "ghost"}</span>;
}

function Title({ pr }: { pr: PullRequestView }) {
  return (
    <Tip label={pr.title}>
      <span className="truncate">
        {pr.draft && <span className="mr-1.5 rounded-sm bg-cf-surface-sunken px-1 text-caption-sm uppercase">draft</span>}
        {pr.title}
      </span>
    </Tip>
  );
}

/** A table row: Enter and click open it in the side panel (the page's nav), cmd+click on GitHub. */
function Row({ section, pr, className, children }: { section: Section; pr: PullRequestView; className?: string; children: ReactNode }) {
  return (
    <NavRow
      navKey={prKey(section, pr)}
      activateOnClick
      onCmdClick={() => void openUrl(pr.url)}
      className={cn("grid h-full items-center gap-3 rounded-md px-2 text-body", columns[section], className)}
    >
      {children}
    </NavRow>
  );
}

export function NeedsReviewRow({ row, viewer }: { row: NeedsRow; viewer: string }) {
  const { pr, why } = row;
  const look = WHY_LOOK[why];
  return (
    <Row section="review" pr={pr}>
      <Lead pr={pr} />
      <Author pr={pr} viewer={viewer} />
      <Title pr={pr} />
      <IconLabel icon={look.icon} cls={look.cls} label={needsLabel[why]} testId="prs-why" value={why} />
      <ChecksBadge checks={pr.checks} />
      <Age ms={pr.updatedAtMs} className="text-right" />
    </Row>
  );
}

export function ReviewedByYouRow({ row, viewer }: { row: ReviewedRow; viewer: string }) {
  const { pr, verdict } = row;
  const look = VERDICT_LOOK[verdict];
  return (
    // Waiting on the author: dimmed until hovered or under the cursor.
    <Row section="reviewed" pr={pr} className="opacity-60 hover:opacity-100 aria-selected:opacity-100">
      <Lead pr={pr} />
      <Author pr={pr} viewer={viewer} />
      <Title pr={pr} />
      <IconLabel icon={look.icon} cls={look.cls} label={verdictLabel[verdict]} testId="prs-verdict" value={verdict} />
      <ChecksBadge checks={pr.checks} />
      <Age ms={pr.updatedAtMs} className="text-right" />
    </Row>
  );
}

export function AuthoredPrRow({ row }: { row: AuthoredRow }) {
  const { pr, status } = row;
  const comments = pr.comments + pr.reviews;
  return (
    <Row section="authored" pr={pr}>
      <Lead pr={pr} />
      <Title pr={pr} />
      <StatusPill status={status} />
      <ChecksBadge checks={pr.checks} />
      <span className="flex items-center gap-1 text-body-sm text-cf-text-muted tabular-nums" aria-label={`${String(comments)} comments and reviews`} data-testid="prs-comments">
        <MessageCircle className="size-3.5 shrink-0" aria-hidden />
        {comments}
      </span>
      <Age ms={pr.updatedAtMs} className="text-right" />
    </Row>
  );
}

export function MergedRow({ pr, viewer }: { pr: PullRequestView; viewer: string }) {
  return (
    <Row section="merged" pr={pr}>
      <Lead pr={pr} />
      <Author pr={pr} viewer={viewer} />
      <Title pr={pr} />
      <Age ms={pr.mergedAtMs} className="text-right" />
    </Row>
  );
}

/** A bordered table: the column header row (when the section has one) and the rows. */
export function PrTable<T extends { pr: PullRequestView }>({ section, rows, render, className }: { section: Section; rows: readonly T[]; render: (row: T) => ReactNode; className?: string }) {
  const head = headers[section];
  return (
    <div className={cn("rounded-lg border", className)}>
      {head.length > 0 && (
        <div className={cn("grid gap-3 border-b px-2 py-1 text-overline", columns[section])}>
          {head.map((h, i) => (
            <span key={h} className={cn(i === head.length - 1 && "text-right")}>
              {h}
            </span>
          ))}
        </div>
      )}
      <div className="p-0.5">
        <RowList rows={rows} rowKey={(r) => prKey(section, r.pr)} rowHeight={ROW_H} render={render} />
      </div>
    </div>
  );
}
