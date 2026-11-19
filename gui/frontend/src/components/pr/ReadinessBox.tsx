import {
  ArrowDownToLine,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  ExternalLink,
  Eye,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Lock,
  MessageSquare,
  ShieldAlert,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { WorkingCircle } from "@/components/status/StatusCircle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { statusRegistry } from "@/lib/statusRegistry";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestKey, useViewerLogin } from "@/stores/gh";
import { revertPullRequest, setAutoMerge, setPullRequestDraft, toggleSection, useMergingMethod, usePrPanelStore, usePullRequestChange } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { AutoMergeButton } from "./AutoMergeButton";
import { Avatar } from "./Avatar";
import { MergeButton } from "./MergeButton";
import { stateBadge } from "./model";
import { CheckList } from "./PrChecks";
import { cardChecks, readinessCards, statusTone, type Readiness, type ReadinessRow, type ReadyIcon, type ReadyTone, type StatusTone, type SubLine } from "./readiness";
import { ReviewButton } from "./ReviewButton";
import type { SeedReadiness } from "./seed";
import { TaskButton } from "./TaskButton";
import { taskVerb, type TaskRouting } from "./taskRouting";
import { useReadiness, useSeedReadiness } from "./useReadiness";
import { useTaskRouting } from "./useTaskRouting";
import { toneText } from "./tones";

/**
 * A card's icon. Running checks take the app's "something is running" mark, the working circle
 * the sidebar's Working rows show (statusRegistry), turning, in the card's tone; "No checks"
 * keeps a still dashed circle. A single running check inside the card keeps its own dot
 * (checkIcons.ts).
 */
const icons: Record<ReadyIcon, LucideIcon> = {
  draft: GitPullRequestDraft,
  failure: CircleX,
  running: statusRegistry.working.icon ?? WorkingCircle,
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

/** The header's status words and icon per status tone; a neutral status (a draft) keeps the text's own colour and a muted icon. */
const statusText: Record<StatusTone, string> = {
  success: toneText.success,
  warning: toneText.pending,
  merged: toneText.merged,
  failure: toneText.failure,
  neutral: "text-cf-text",
};
const statusIcon: Record<StatusTone, string> = { ...statusText, neutral: "text-cf-text-muted" };

/** The pull request's state icon in the status line, by stateBadge's label: open, draft, merged or closed. */
const stateIcons: Record<string, LucideIcon> = { Open: GitPullRequest, Draft: GitPullRequestDraft, Merged: GitMerge, Closed: GitPullRequestClosed };

/** The state's icon, its words in its tone, and the quiet text after them ("a3f9c21 into main 2h ago"). */
function StatusWords({ d, headline }: { d: PullRequestDetailView; headline: Readiness["headline"] }) {
  const t = statusTone(headline.tone);
  const Icon = stateIcons[stateBadge(d.pullRequest).label] ?? GitPullRequest;
  return (
    <>
      <Icon className={cn("size-4 shrink-0", statusIcon[t])} aria-hidden />
      <span className={cn("shrink-0 text-body font-semibold whitespace-nowrap", statusText[t])} data-testid="pr-ready-headline" data-tone={t}>
        {headline.title}
      </span>
      {headline.meta && (
        <Tip label={headline.meta} whenTruncated>
          <span className="min-w-0 truncate text-caption text-cf-text-muted" data-testid="pr-ready-meta">
            {headline.meta}
          </span>
        </Tip>
      )}
    </>
  );
}

/**
 * The status line: the state at the left, the buttons at the right. The buttons share the
 * line while they fit and wrap to their own line when they do not (a flex item breaks to a
 * new line by its content width). Sharing it they keep their natural size at the right;
 * on a line of their own they fill it, sharing its width. CSS alone tells the two apart:
 * the words grow 9999 times as fast as the buttons' box, so on a shared line the box gets
 * a ten-thousandth of the spare room (under a pixel) and its buttons, which grow to fill
 * it, stay at their natural size; alone on its line the box gets all of it.
 */
function StatusLine({ words, buttons }: { words: ReactNode; buttons: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2" data-testid="pr-status">
      <div className="flex min-h-7 max-w-full min-w-0 flex-[9999_1_auto] items-center gap-2">{words}</div>
      {buttons}
    </div>
  );
}

/**
 * A button whose change runs on GitHub: a spinner and `busyLabel` while `running`. `inert`
 * (this change or another of the pull request's) dims it and a press sends nothing; it stays
 * focusable.
 */
function ChangeButton({ label, busyLabel, running, inert, onRun, testId, icon: Icon }: { label: string; busyLabel: string; running: boolean; inert: boolean; onRun: () => void; testId: string; icon?: LucideIcon }) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="h-7 shrink-0 px-2.5 text-label has-[>svg]:px-2 aria-disabled:pointer-events-none aria-disabled:opacity-70"
      data-testid={testId}
      aria-disabled={inert || undefined}
      aria-busy={running || undefined}
      onClick={() => {
        if (!inert) onRun();
      }}
    >
      {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden data-testid={`${testId}-busy`} /> : Icon && <Icon className="size-3.5" aria-hidden />}
      {running ? busyLabel : label}
    </Button>
  );
}

/** The state's main action: Merge ▾, Auto-merge ▾, Cancel auto-merge, Ready for review or Revert. */
function MainActionButton({ f, d, prRef, panelKey }: { f: Readiness["footer"]; d: PullRequestDetailView; prRef: PrRef; panelKey: string }) {
  const change = usePullRequestChange(prRef);
  const reverting = usePrPanelStore((s) => s.reverting[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  switch (f.main) {
    case "merge":
      return <MergeButton prRef={prRef} detail={d} note={f.mergeNote} />;
    case "auto-merge":
      return <AutoMergeButton prRef={prRef} detail={d} />;
    case "cancel-auto-merge":
      return <ChangeButton label="Cancel auto-merge" busyLabel="Cancelling…" icon={Zap} running={change === "cancel-auto-merge"} inert={change !== null} onRun={() => void setAutoMerge(prRef, null, "")} testId="pr-cancel-auto-merge" />;
    case "ready":
      return <ChangeButton label="Ready for review" busyLabel="Marking ready…" running={change === "ready"} inert={change !== null} onRun={() => void setPullRequestDraft(prRef, false, { inView: true })} testId="pr-ready-for-review" />;
    case "revert":
      return <ChangeButton label="Revert" busyLabel="Reverting…" running={reverting} inert={reverting} onRun={() => void revertPullRequest(prRef, panelKey)} testId="pr-revert" />;
    case null:
      return null;
  }
}

/**
 * The header's status section: the state in words, then Review and the state's main action.
 * While a merge runs the words say "Merging into main…" in the state's tone; the detail
 * showing it merged turns them to Merged.
 */
export function HeaderStatus({ r, d, prRef, panelKey }: { r: Readiness; d: PullRequestDetailView; prRef: PrRef; panelKey: string }) {
  const f = r.footer;
  const merging = useMergingMethod(prRef) !== null && d.pullRequest.state === "open";
  const headline = merging ? { ...r.headline, title: `Merging into ${d.pullRequest.baseRef || "the base branch"}…`, meta: "" } : r.headline;
  return (
    <StatusLine
      words={<StatusWords d={d} headline={headline} />}
      buttons={
        (f.review || f.main) && (
          <div className="flex max-w-full min-w-0 flex-[1_1_auto] flex-wrap items-center justify-end gap-1.5 *:grow" data-testid="pr-ready-footer">
            {f.review && <ReviewButton prRef={prRef} detail={d} primary={f.reviewPrimary} />}
            <MainActionButton f={f} d={d} prRef={prRef} panelKey={panelKey} />
          </div>
        )
      }
    />
  );
}

/**
 * The status section while the detail is on its way: a merged or closed state in words, a
 * bar for an open one's verdict (it hangs on what only the detail has) and bars where its
 * buttons will be, so nothing here can be pressed. `failed`: nothing is on its way.
 */
export function SeededHeaderStatus({ r, d, failed }: { r: SeedReadiness; d: PullRequestDetailView; failed: boolean }) {
  const pending = r.footerPending && !failed;
  return (
    <StatusLine
      words={
        r.headline ? (
          <StatusWords d={d} headline={r.headline} />
        ) : failed ? (
          <span className="text-body font-semibold" data-testid="pr-ready-headline" data-tone="neutral">
            Readiness unknown
          </span>
        ) : (
          <Skeleton className="h-4 w-40" data-testid="pr-ready-pending" />
        )
      }
      buttons={
        pending && (
          <div className="flex flex-[1_0_auto] items-center justify-end gap-1.5 *:grow" data-testid="pr-ready-footer-pending">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-32" />
          </div>
        )
      }
    />
  );
}

function Line({ line }: { line: SubLine }) {
  switch (line.kind) {
    case "text":
      return <span className="break-words">{line.text}</span>;
    case "check":
      // The checks card lists its checks itself (CheckList).
      return null;
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

/** All N checks ⌄ / back, or Show / Hide on the passed card: unfolds every check (per panel tab). */
function ChecksToggle({ tabKey, open, label, back }: { tabKey: string; open: boolean; label: string; back: string }) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0"
      aria-expanded={open}
      data-testid="pr-ready-checks-toggle"
      onClick={() => {
        toggleSection(tabKey, "checks");
      }}
    >
      {open ? back : label}
      <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
    </Button>
  );
}

function useChecksOpen(tabKey: string): boolean {
  return usePrPanelStore((s) => s.byTab[tabKey]?.open.checks ?? false);
}

const rowTitle = (row: ReadinessRow) => (
  <span className="min-w-0 text-body-sm break-words" data-testid="pr-ready-title">
    <span className="font-medium text-cf-text">{row.title}</span>
    {row.meta && <span className="text-cf-text-muted"> · {row.meta}</span>}
  </span>
);

/**
 * One requirement that is not passing: its icon, title, the lines under it, and its button
 * at the right (under the text below 480px): the row's thread task (TaskButton), Approve on
 * GitHub, or for checks All N checks. A checks card lists its failing or running checks.
 */
function IssueCard({ row, d, prRef, tabKey, viewer, routing }: { row: ReadinessRow; d: PullRequestDetailView; prRef: PrRef; tabKey: string; viewer: string; routing: TaskRouting }) {
  const Icon = icons[row.icon];
  const verb = taskVerb(row.task, d, viewer);
  const checks = row.id === "checks" && d.checks.length > 0;
  const open = useChecksOpen(tabKey) && checks;
  const listed = useMemo(() => (checks ? cardChecks(row, d.checks) : []), [checks, row, d.checks]);
  const task = row.task !== null && verb !== null;
  const approve = row.action?.kind === "approve-workflow" ? row.action.url : null;
  // A card with a button that takes room (a task, Approve) wraps it under the text when narrow; All N checks stays at the right.
  const wraps = task || approve !== null;
  return (
    <div
      className={cn("flex min-w-0 items-start gap-2.5 rounded-lg border border-cf-border bg-cf-surface-raised px-3 py-2", row.tone === "failure" && "border-cf-error/35", wraps && "@max-[480px]:flex-wrap")}
      data-testid="pr-ready-row"
      data-row={row.id}
      data-tone={row.tone}
      data-task={row.task ?? undefined}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone(row.tone))} aria-hidden data-testid="pr-ready-icon" data-icon={row.icon} />
      <div className={cn("flex min-w-0 flex-1 flex-col", wraps && "@max-[480px]:basis-[calc(100%-24px)]")}>
        {rowTitle(row)}
        {checks ? (
          <div className="pt-1">
            <CheckList d={d} checks={open ? undefined : listed} />
          </div>
        ) : (
          row.lines.length > 0 && (
            <div className="flex min-w-0 flex-col items-start gap-0.5 pt-0.5 text-caption text-cf-text-muted" data-testid="pr-ready-lines">
              {row.lines.map((l, i) => (
                <Line key={i} line={l} />
              ))}
            </div>
          )
        )}
      </div>
      {(task || approve !== null || checks) && (
        <div className={cn("ml-auto flex shrink-0 flex-wrap items-center gap-1.5", checks ? "self-start" : "self-center", wraps && "@max-[480px]:ml-6 @max-[480px]:basis-[calc(100%-24px)]")}>
          {approve !== null && (
            <Button variant="outline" size="xs" data-testid="pr-approve-workflow" onClick={() => void openUrl(approve)}>
              Approve on GitHub
              <ExternalLink aria-hidden />
            </Button>
          )}
          {task && row.task && verb && <TaskButton kind={row.task} verb={verb} prRef={prRef} routing={routing} />}
          {checks && <ChecksToggle tabKey={tabKey} open={open} label={`All ${String(d.checks.length)} checks`} back={row.tone === "failure" ? "Failing only" : "Running only"} />}
        </div>
      )}
    </div>
  );
}

/** One line of the passed card; the checks line's Show unfolds every check under it. */
function PassedRow({ row, d, tabKey }: { row: ReadinessRow; d: PullRequestDetailView; tabKey: string }) {
  const checks = row.id === "checks" && d.checks.length > 0;
  const open = useChecksOpen(tabKey) && checks;
  const Icon = icons[row.icon];
  return (
    <div className="flex min-w-0 items-start gap-2.5" data-testid="pr-ready-row" data-row={row.id} data-tone={row.tone}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone(row.tone))} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        {rowTitle(row)}
        {open && (
          <div className="pt-1">
            <CheckList d={d} />
          </div>
        )}
      </div>
      {checks && <ChecksToggle tabKey={tabKey} open={open} label="Show" back="Hide" />}
    </div>
  );
}

/**
 * Overview's requirement cards (readinessCards): one card per requirement that is not
 * passing, then one quiet card for everything that passed. Nothing for a merged or closed
 * pull request.
 */
function Cards({ issues, passed, d, prRef, tabKey }: { issues: readonly ReadinessRow[]; passed: readonly ReadinessRow[]; d: PullRequestDetailView; prRef: PrRef; tabKey: string }) {
  const viewer = useViewerLogin();
  const routing = useTaskRouting(prRef, d.pullRequest);
  if (issues.length === 0 && passed.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2 px-4 pt-3 @max-[340px]:px-3" data-testid="pr-readiness" aria-label="Merge readiness">
      {issues.map((row) => (
        <IssueCard key={row.id} row={row} d={d} prRef={prRef} tabKey={tabKey} viewer={viewer} routing={routing} />
      ))}
      {passed.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-cf-border bg-cf-surface-raised px-3 py-2" data-testid="pr-ready-passed">
          {passed.map((row) => (
            <PassedRow key={row.id} row={row} d={d} tabKey={tabKey} />
          ))}
        </div>
      )}
    </section>
  );
}

export function ReadinessCards({ d, prRef, tabKey }: { d: PullRequestDetailView; prRef: PrRef; tabKey: string }) {
  const r = useReadiness(d);
  const { issues, passed } = useMemo(() => readinessCards(r.rows, d.pullRequest.state), [r.rows, d.pullRequest.state]);
  return <Cards issues={issues} passed={passed} d={d} prRef={prRef} tabKey={tabKey} />;
}

/** The cards a dashboard row can fill while the detail is on its way: without their buttons (seed.ts takes them off). */
export function SeededReadinessCards({ d, prRef, tabKey }: { d: PullRequestDetailView; prRef: PrRef; tabKey: string }) {
  const r = useSeedReadiness(d);
  const { issues, passed } = useMemo(() => readinessCards(r.rows, d.pullRequest.state), [r.rows, d.pullRequest.state]);
  return <Cards issues={issues} passed={passed} d={d} prRef={prRef} tabKey={tabKey} />;
}
