import { useEffect, useMemo, type ReactNode } from "react";
import { ArrowLeft, CircleCheck, CircleDashed, CircleDot, CircleX, ExternalLink, FileDiff, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, SearchX, TriangleAlert } from "lucide-react";
import { isNotFoundMessage, type PullRequestDetailView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useCurrentPanelKey } from "@/stores/panel";
import { prTabKey, setInnerTab, usePrPanelStore, type PrInnerTab } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { ago, checksHeadline, commentCount, stateBadge, type Tone } from "./model";
import { PrMenu } from "./PrMenu";
import { OrderToggle, PrSummary } from "./PrSummary";
import { PrTimeline } from "./PrTimeline";
import { toneBadge, toneText } from "./tones";

const stateIcon: Record<string, typeof GitPullRequest> = { Open: GitPullRequest, Draft: GitPullRequestDraft, Merged: GitMerge, Closed: GitPullRequestClosed };
const checksIcon: Partial<Record<Tone, typeof CircleCheck>> = { success: CircleCheck, failure: CircleX, pending: CircleDot };

function StateBadge({ d }: { d: PullRequestDetailView }) {
  const b = stateBadge(d.pullRequest);
  const Icon = stateIcon[b.label] ?? GitPullRequest;
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[13px] font-medium", toneBadge[b.tone])} data-testid="pr-state" data-state={b.label.toLowerCase()}>
      <Icon className="size-3.5" aria-hidden />
      {b.label}
    </span>
  );
}

export function ChecksHeadline({ d }: { d: PullRequestDetailView }) {
  const h = checksHeadline(d.pullRequest.checks);
  const Icon = checksIcon[h.tone] ?? CircleDashed;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", toneText[h.tone])} data-testid="pr-checks-summary" data-tone={h.tone}>
      <Icon className="size-3.5" aria-hidden />
      {h.text}
    </span>
  );
}

function Header({ d, prRef, panelKey }: { d: PullRequestDetailView; prRef: PrRef; panelKey: string }) {
  const pr = d.pullRequest;
  const now = useNow(30_000);
  const comments = commentCount(d);
  return (
    <header className="flex flex-col gap-2 border-b border-pane-border px-4 pt-3 pb-3" data-testid="pr-header">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 rounded text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          title={`Open ${pr.url} on GitHub`}
          data-testid="pr-repo-link"
          onClick={() => void openUrl(pr.url)}
        >
          <span className="truncate">{prRef.slug}</span>
          <span className={cn("shrink-0 font-medium", toneText.merged)}>#{prRef.number}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="flex items-center gap-1 px-1 text-[13px] text-muted-foreground tabular-nums" title={`${String(comments)} comments`} data-testid="pr-comment-count">
            <MessageSquare className="size-3.5" aria-hidden />
            {comments}
          </span>
          <StateBadge d={d} />
          <PrMenu prRef={prRef} detail={d} panelKey={panelKey} />
        </span>
      </div>
      <h2 className="text-[15px] leading-snug font-semibold select-text" data-testid="pr-title">
        {pr.title || `#${String(prRef.number)}`}
      </h2>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <Avatar login={pr.author} size={18} />
        <span className="truncate font-medium" data-testid="pr-author">
          {pr.author || "ghost"}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="shrink-0 text-muted-foreground" title={pr.updatedAtMs === null ? undefined : new Date(pr.updatedAtMs).toLocaleString()} data-testid="pr-updated">
          updated {ago(pr.updatedAtMs, now) || "—"}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 font-mono" data-testid="pr-branches" title={`${pr.headRef} into ${pr.baseRef}`}>
          <span className="shrink-0">{pr.baseRef}</span>
          <ArrowLeft className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{pr.headRef}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums" data-testid="pr-diffstat">
          <FileDiff className="size-3.5" aria-hidden />
          {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          <span className={toneText.success}>+{pr.additions.toLocaleString()}</span>
          <span className={toneText.failure}>−{pr.deletions.toLocaleString()}</span>
        </span>
      </div>
    </header>
  );
}

const innerTabs: { id: PrInnerTab | "code"; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "timeline", label: "Timeline" },
  { id: "code", label: "Code" },
];

function InnerTabBar({ d, tabKey, inner }: { d: PullRequestDetailView; tabKey: string; inner: PrInnerTab }) {
  return (
    <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-pane-border bg-pane px-4">
      <div role="tablist" aria-label="Pull request views" className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 dark:bg-muted/40">
        {innerTabs.map((t) => {
          const active = t.id === inner;
          const disabled = t.id === "code";
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              title={disabled ? "The diff view comes in a later step" : undefined}
              data-testid={`pr-tab-${t.id}`}
              className={cn(
                "h-6 rounded-md px-2.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40",
                active ? "bg-pane text-foreground shadow-xs dark:bg-accent" : "text-muted-foreground enabled:hover:text-foreground",
              )}
              onClick={() => {
                if (t.id !== "code") setInnerTab(tabKey, t.id);
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {inner === "summary" ? (
          <ChecksHeadline d={d} />
        ) : (
          <>
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums" title="Comments and reviews">
              <MessageSquare className="size-3" aria-hidden />
              {d.comments.length}
            </span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums" title="Commits">
              <GitCommitHorizontal className="size-3.5" aria-hidden />
              {d.commitCount}
            </span>
            <OrderToggle tabKey={tabKey} which="timelineOrder" />
          </>
        )}
      </div>
    </div>
  );
}

function Banner({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/30 dark:text-amber-200" role="status" data-testid={testId}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Skeleton() {
  const bar = "animate-pulse rounded bg-muted";
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="pr-loading" aria-busy="true" aria-label="Loading pull request">
      <div className={cn(bar, "h-3.5 w-1/2")} />
      <div className={cn(bar, "h-5 w-5/6")} />
      <div className={cn(bar, "h-3.5 w-1/3")} />
      <div className={cn(bar, "h-3 w-2/3")} />
      <div className={cn(bar, "mt-4 h-7 w-48")} />
      <div className={cn(bar, "h-3 w-full")} />
      <div className={cn(bar, "h-3 w-11/12")} />
      <div className={cn(bar, "h-3 w-4/5")} />
    </div>
  );
}

function Centered({ icon: Icon, title, children, testId }: { icon: typeof SearchX; title: string; children?: ReactNode; testId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm" data-testid={testId}>
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-80 text-xs break-words text-muted-foreground">{children}</div>}
    </div>
  );
}

/**
 * The Pull request surface: one tab of the side panel showing a pull request's detail
 * (GhService.GetPullRequestDetail through pullRequestDetailResource), modeled on T3
 * Code's panel. Inner view state lives in stores/prPanel.ts per panel tab.
 */
export function PullRequestSurface({ tabId, slug, number }: { tabId: string; slug: string; number: number }) {
  const panelKey = useCurrentPanelKey() ?? "";
  const tabKey = prTabKey(panelKey, tabId);
  const prRef = useMemo<PrRef>(() => ({ slug, number }), [slug, number]);
  const key = pullRequestKey(slug, number);
  useEffect(() => pullRequestDetailResource.watch(key), [key]);
  const d = pullRequestDetailResource.store((s) => s.entries[key]?.data ?? null);
  const error = pullRequestDetailResource.store((s) => s.entries[key]?.error ?? null);
  const inner = usePrPanelStore((s) => s.byTab[tabKey]?.inner ?? "summary");
  const now = useNow(30_000);

  if (!d) {
    if (isNotFoundMessage(error)) {
      return (
        <Centered icon={SearchX} title="Pull request not found" testId="pr-not-found">
          {slug}#{number} does not exist, or this GitHub account cannot see it.
        </Centered>
      );
    }
    if (error) {
      return (
        <Centered icon={TriangleAlert} title="Cannot load this pull request" testId="pr-error">
          {error}
        </Centered>
      );
    }
    return <Skeleton />;
  }
  return (
    <div className="flex flex-col" data-testid="pr-surface" data-pr={`${slug}#${String(number)}`}>
      <Header d={d} prRef={prRef} panelKey={panelKey} />
      {d.lastError && !d.checksTruncated && (
        <Banner testId="pr-stale">
          Showing the copy from {ago(d.fetchedAtMs, now) || "earlier"}: the last fetch from GitHub failed ({d.lastError}).
        </Banner>
      )}
      {error && <Banner testId="pr-refresh-error">Could not refresh: {error}</Banner>}
      <InnerTabBar d={d} tabKey={tabKey} inner={inner} />
      {inner === "timeline" ? <PrTimeline d={d} tabKey={tabKey} /> : <PrSummary d={d} prRef={prRef} tabKey={tabKey} />}
    </div>
  );
}
