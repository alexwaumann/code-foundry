import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  ExternalLink,
  Eye,
  GitMerge,
  GitMergeConflict,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  Lock,
  MessageSquare,
  ShieldAlert,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestKey, useViewerLogin } from "@/stores/gh";
import { revertPullRequest, setAutoMerge, setPullRequestDraft, toggleSection, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { AutoMergeButton } from "./AutoMergeButton";
import { Avatar } from "./Avatar";
import { MergeButton } from "./MergeButton";
import { checkMeta, checkTone } from "./model";
import { checkIcon, useChecksClock } from "./checkIcons";
import { CheckList } from "./PrChecks";
import { detailFresh, readiness, type ReadinessRow, type ReadyIcon, type ReadyTone, type RowAction, type SubLine } from "./readiness";
import { ReviewButton } from "./ReviewButton";
import { TaskButton } from "./TaskButton";
import { taskVerb } from "./taskRouting";
import type { Verdict } from "./review";
import { toneText } from "./tones";

const icons: Record<ReadyIcon, LucideIcon> = {
  draft: GitPullRequestDraft,
  failure: CircleX,
  running: LoaderCircle,
  success: CircleCheck,
  clock: Clock,
  eye: Eye,
  conversation: MessageSquare,
  conflict: GitMergeConflict,
  behind: ArrowDownToLine,
  approval: ShieldAlert,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  warning: TriangleAlert,
  "auto-merge": Zap,
  lock: Lock,
  none: CircleDashed,
};

const tone = (t: ReadyTone): string => (t === "info" ? "text-cf-info-text" : toneText[t]);

const ring: Partial<Record<ReadyTone, string>> = { success: "ring-cf-success", failure: "ring-cf-error", pending: "ring-cf-warning" };

/** A named check under the checks row: its icon, name, workflow and duration; opens its log. */
function CheckLine({ c, now }: { c: PullRequestDetailView["checks"][number]; now: number }) {
  const t = checkTone(c);
  const Icon = checkIcon[t];
  const meta = [c.workflow, checkMeta(c, now)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      disabled={!c.url}
      className="flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-none enabled:hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus disabled:cursor-default"
      data-testid="pr-ready-check"
      data-tone={t}
      onClick={() => void openUrl(c.url)}
    >
      <Icon className={cn("size-3 shrink-0", toneText[t])} aria-hidden />
      <span className="min-w-0 truncate text-cf-text-secondary">{c.name}</span>
      {meta && <span className="shrink-0 tabular-nums">{meta}</span>}
    </button>
  );
}

function Line({ line, now }: { line: SubLine; now: number }) {
  switch (line.kind) {
    case "text":
      return <span className="break-words">{line.text}</span>;
    case "check":
      return <CheckLine c={line.check} now={now} />;
    case "person":
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar login={line.login} src={line.avatarUrl} size={16} className={cn("ring-1", ring[line.tone] ?? "ring-cf-border")} />
          <span className="min-w-0 truncate">{line.text}</span>
        </span>
      );
    case "locations":
      return (
        <span className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5" data-testid="pr-ready-locations">
          {line.items.map((it, i) => (
            <span key={`${it.path}/${String(i)}`} className="whitespace-nowrap">
              {i > 0 && <span aria-hidden>· </span>}
              {/* The file name only: the tooltip has the path (hidden), so it takes focus to show it from the keyboard. */}
              {it.path === it.text ? (
                <span>{it.text}</span>
              ) : (
                <Tip label={it.path}>
                  <span tabIndex={0} className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-cf-focus" data-testid="pr-ready-location">
                    {it.text}
                  </span>
                </Tip>
              )}
              {it.outdated && <span className={toneText.pending}> (outdated)</span>}
            </span>
          ))}
        </span>
      );
    case "commit":
      return (
        <span className="text-code" data-testid="pr-ready-commit">
          {line.sha.slice(0, 7)}
        </span>
      );
  }
}

function ActionButton({ action, prRef, panelKey }: { action: RowAction; prRef: PrRef; panelKey: string }) {
  const busy = usePrPanelStore((s) => s.changing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  switch (action.kind) {
    case "ready":
      return (
        <Button variant="outline" size="xs" data-testid="pr-ready-for-review" aria-disabled={busy || undefined} onClick={() => !busy && void setPullRequestDraft(prRef, false)}>
          Ready for review
        </Button>
      );
    case "approve-workflow":
      return (
        <Button variant="outline" size="xs" data-testid="pr-approve-workflow" onClick={() => void openUrl(action.url)}>
          Approve on GitHub
          <ExternalLink aria-hidden />
        </Button>
      );
    case "revert":
      return (
        <Button variant="outline" size="xs" data-testid="pr-revert" onClick={() => void revertPullRequest(prRef, panelKey)}>
          Revert
        </Button>
      );
  }
}

/**
 * One requirement: its icon, title (and muted counts), the lines under it, and its button
 * under the text. The checks row's title unfolds the full check list (per panel tab). An
 * issue row carries `data-task` (pr.task's kind) and, when the viewer may hand it to a
 * thread (taskVerb), its TaskButton ("Fix in this thread") under the text.
 */
function Row({ row, d, prRef, panelKey, tabKey, now, viewer }: { row: ReadinessRow; d: PullRequestDetailView; prRef: PrRef; panelKey: string; tabKey: string; now: number; viewer: string }) {
  const open = usePrPanelStore((s) => s.byTab[tabKey]?.open.checks ?? false) && row.expandable;
  const Icon = icons[row.icon];
  const verb = taskVerb(row.task, d, viewer);
  const Chevron = open ? ChevronDown : ChevronRight;
  const title = (
    <>
      <span className="font-medium text-cf-text">{row.title}</span>
      {row.meta && <span className="text-cf-text-muted"> · {row.meta}</span>}
    </>
  );
  return (
    <div className="flex min-w-0 items-start gap-2.5 border-b border-cf-divider px-3 py-2 last:border-b-0" data-testid="pr-ready-row" data-row={row.id} data-tone={row.tone} data-task={row.task ?? undefined}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone(row.tone))} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        {row.expandable ? (
          <button
            type="button"
            aria-expanded={open}
            className="-mx-1 flex min-w-0 items-start gap-1 rounded-sm px-1 text-left text-body-sm outline-none hover:bg-cf-control-hover/60 focus-visible:ring-1 focus-visible:ring-cf-focus"
            data-testid="pr-ready-checks-toggle"
            onClick={() => {
              toggleSection(tabKey, "checks");
            }}
          >
            <span className="min-w-0 flex-1 break-words" data-testid="pr-ready-title">
              {title}
            </span>
            <Chevron className="mt-0.5 size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
          </button>
        ) : (
          <span className="min-w-0 text-body-sm break-words" data-testid="pr-ready-title">
            {title}
          </span>
        )}
        {open ? (
          <div className="pt-1">
            <CheckList d={d} />
          </div>
        ) : (
          row.lines.length > 0 && (
            <div className="flex min-w-0 flex-col items-start gap-0.5 pt-0.5 text-caption text-cf-text-muted" data-testid="pr-ready-lines">
              {row.lines.map((l, i) => (
                <Line key={i} line={l} now={now} />
              ))}
            </div>
          )
        )}
        {(row.action || (row.task && verb)) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-2">
            {row.action && <ActionButton action={row.action} prRef={prRef} panelKey={panelKey} />}
            {row.task && verb && <TaskButton kind={row.task} verb={verb} prRef={prRef} detail={d} />}
          </div>
        )}
      </div>
    </div>
  );
}

function CancelAutoMerge({ prRef }: { prRef: PrRef }) {
  const busy = usePrPanelStore((s) => s.changing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  return (
    <Button variant="outline" size="xs" className="h-7 px-2" data-testid="pr-cancel-auto-merge" aria-disabled={busy || undefined} onClick={() => !busy && void setAutoMerge(prRef, null, "")}>
      Cancel auto-merge
    </Button>
  );
}

/**
 * The readiness box under the header: a headline (ready, waiting, not ready · N left,
 * merged, …), a row per requirement, and the footer: Review ▾ at the left, Merge,
 * Auto-merge or Cancel auto-merge at the right. Built from readiness() (pure). `compact`
 * (the Code tab, whose diff needs the height) drops the rows: the headline and the
 * footer's controls share one line, the controls wrapping under it when the panel is too
 * narrow for both.
 */
export function ReadinessBox({ d, prRef, panelKey, tabKey, onReview, compact = false }: { d: PullRequestDetailView; prRef: PrRef; panelKey: string; tabKey: string; onReview: (v: Verdict) => void; compact?: boolean }) {
  const viewer = useViewerLogin();
  const clock = useNow(30_000);
  const checksNow = useChecksClock(d.checks);
  const r = useMemo(() => readiness(d, viewer, detailFresh(d), clock), [d, viewer, clock]);
  const HeadIcon = icons[r.headline.icon];
  const f = r.footer;
  const headline = (
    <div
      className={cn("flex min-w-0 items-center gap-2", compact ? "flex-1 basis-40" : "border-b border-cf-divider px-3 py-2")}
      data-testid="pr-ready-headline"
      data-tone={r.headline.tone}
    >
      <HeadIcon className={cn("size-3.5 shrink-0", tone(r.headline.tone))} aria-hidden />
      <span className="min-w-0 truncate text-body-sm font-medium text-cf-text">{r.headline.title}</span>
      {r.headline.meta && (
        <Tip label={r.headline.meta} whenTruncated>
          <span className="min-w-0 truncate text-caption text-cf-text-muted" data-testid="pr-ready-meta">
            {r.headline.meta}
          </span>
        </Tip>
      )}
    </div>
  );
  const controls = f && (f.review || f.merge) && (
    <>
      {f.review && <ReviewButton prRef={prRef} detail={d} onChoose={onReview} primary={f.reviewPrimary} />}
      <span className="ml-auto flex min-w-0 items-center">
        {f.merge === "merge" && <MergeButton prRef={prRef} detail={d} note={f.mergeNote} />}
        {f.merge === "auto-merge" && <AutoMergeButton prRef={prRef} detail={d} />}
        {f.merge === "cancel-auto-merge" && <CancelAutoMerge prRef={prRef} />}
      </span>
    </>
  );
  return (
    <section className="mx-4 mt-3 shrink-0 overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised @max-[340px]:mx-3" data-testid="pr-readiness" data-compact={compact || undefined} aria-label="Merge readiness">
      {compact ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
          {headline}
          {controls && (
            <div className="ml-auto flex min-w-0 items-center gap-2" data-testid="pr-ready-footer">
              {controls}
            </div>
          )}
        </div>
      ) : (
        <>
          {headline}
          {r.rows.map((row) => (
            <Row key={row.id} row={row} d={d} prRef={prRef} panelKey={panelKey} tabKey={tabKey} now={row.id === "checks" ? checksNow : clock} viewer={viewer} />
          ))}
          {controls && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 bg-cf-surface-sunken/60 px-3 py-2" data-testid="pr-ready-footer">
              {controls}
            </div>
          )}
        </>
      )}
    </section>
  );
}
