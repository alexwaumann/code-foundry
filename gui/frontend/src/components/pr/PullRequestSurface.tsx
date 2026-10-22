import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, CircleCheck, CircleDashed, CircleDot, CircleX, ExternalLink, FileDiff, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, History, MessageSquare, SearchX, TriangleAlert } from "lucide-react";
import { isNotFoundMessage, type PullRequestDetailView } from "@/api/gh";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useCurrentPanelKey } from "@/stores/panel";
import { prTabKey, setInnerTab, usePrPanelStore, type PrInnerTab } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { ago, checksHeadline, commentCount, stateBadge, timeline, type Tone } from "./model";
import { MergeButton } from "./MergeButton";
import { PrAskComposer } from "./PrAskComposer";
import { PrCode } from "./PrCode";
import { PrMenu } from "./PrMenu";
import { PrReviewComposer } from "./PrReviewComposer";
import { ReviewButton } from "./ReviewButton";
import { reviewVisible, type Verdict } from "./review";
import { OrderToggle, PrSummary } from "./PrSummary";
import { PrTimeline } from "./PrTimeline";
import { toneBadge, toneText } from "./tones";

const stateIcon: Record<string, typeof GitPullRequest> = { Open: GitPullRequest, Draft: GitPullRequestDraft, Merged: GitMerge, Closed: GitPullRequestClosed };
const checksIcon: Partial<Record<Tone, typeof CircleCheck>> = { success: CircleCheck, failure: CircleX, pending: CircleDot };

function StateBadge({ d }: { d: PullRequestDetailView }) {
  const b = stateBadge(d.pullRequest);
  const Icon = stateIcon[b.label] ?? GitPullRequest;
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-label", toneBadge[b.tone])} data-testid="pr-state" data-state={b.label.toLowerCase()}>
      <Icon className="size-3.5" aria-hidden />
      {b.label}
    </span>
  );
}

/**
 * "2 failing", "All checks passed". In a narrow panel only the icon and the number show
 * (the words stay for screen readers and the tooltip).
 */
export function ChecksHeadline({ d }: { d: PullRequestDetailView }) {
  const h = checksHeadline(d.pullRequest.checks);
  const Icon = checksIcon[h.tone] ?? CircleDashed;
  const m = /^(\d+) (.*)$/.exec(h.text);
  return (
    <Tip label={h.text} whenTruncated>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-body-sm whitespace-nowrap", toneText[h.tone])} data-testid="pr-checks-summary" data-tone={h.tone}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {m ? (
          <span className="min-w-0 truncate">
            {m[1]}
            <span className="@max-[340px]:sr-only"> {m[2]}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate @max-[340px]:sr-only">{h.text}</span>
        )}
      </span>
    </Tip>
  );
}

/**
 * Row one: the repo link, then the actions (review, merge, the menu) at the far right. Row two:
 * the title, with the comment count and state at the right. Then author and age, and
 * branches with the diffstat wrapping below in a narrow panel.
 */
function Header({ d, prRef, panelKey, onAsk, onReview }: { d: PullRequestDetailView; prRef: PrRef; panelKey: string; onAsk: () => void; onReview: (v: Verdict) => void }) {
  const pr = d.pullRequest;
  const now = useNow(30_000);
  const comments = commentCount(d);
  return (
    <header className="flex min-w-0 flex-col gap-2 border-b border-cf-divider px-4 pt-2 pb-3 @max-[340px]:px-3" data-testid="pr-header">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 rounded-sm text-caption outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
          data-testid="pr-repo-link"
          onClick={() => void openUrl(pr.url)}
        >
          <span className="truncate">{prRef.slug}</span>
          <span className={cn("shrink-0 font-medium", toneText.merged)}>#{prRef.number}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1" data-testid="pr-actions">
          <ReviewButton prRef={prRef} detail={d} onChoose={onReview} />
          <MergeButton prRef={prRef} detail={d} />
          <PrMenu prRef={prRef} detail={d} panelKey={panelKey} onAsk={onAsk} />
        </span>
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1 text-heading break-words select-text" data-testid="pr-title">
          {pr.title || `#${String(prRef.number)}`}
        </h2>
        <span className="flex shrink-0 items-center gap-1.5 pt-px">
          <Tip label={`${String(comments)} comments`}>
            <span className="flex items-center gap-1 px-1 text-caption tabular-nums" data-testid="pr-comment-count">
              <MessageSquare className="size-3.5" aria-hidden />
              {comments}
            </span>
          </Tip>
          <StateBadge d={d} />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-body-sm">
        <Avatar login={pr.author} size={18} />
        <span className="min-w-0 truncate font-medium" data-testid="pr-author">
          {pr.author || "ghost"}
        </span>
        <span className="text-cf-text-muted">·</span>
        <Tip label={pr.updatedAtMs === null ? null : new Date(pr.updatedAtMs).toLocaleString()}>
          <span className="shrink-0 text-cf-text-muted" data-testid="pr-updated">
            updated {ago(pr.updatedAtMs, now) || "—"}
          </span>
        </Tip>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption">
        <Tip label={`${pr.headRef} into ${pr.baseRef}`} whenTruncated align="start">
          <span className="flex max-w-full min-w-0 items-center gap-1.5 font-mono" data-testid="pr-branches">
            <span className="min-w-0 shrink truncate">{pr.baseRef}</span>
            <ArrowLeft className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{pr.headRef}</span>
          </span>
        </Tip>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums" data-testid="pr-diffstat">
          <FileDiff className="size-3.5" aria-hidden />
          {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          <span className={toneText.success}>+{pr.additions.toLocaleString()}</span>
          <span className={toneText.failure}>−{pr.deletions.toLocaleString()}</span>
        </span>
      </div>
    </header>
  );
}

const innerTabs: { id: PrInnerTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "timeline", label: "Timeline" },
  { id: "code", label: "Code" },
];

/**
 * Summary | Timeline | Code, then the checks headline (Summary) or the timeline's counts
 * and order (Timeline); nothing for Code, whose strip has its own. Container queries on the surface give way in steps, so nothing
 * is pushed out of the bar or overlaps: below 480px the order toggle keeps only its icon
 * (the default 420px panel), below 400px the counts go, and below 340px the headline
 * keeps its icon and number. Measured in WebKit: tabs 208px, counts 119px, toggle 96px.
 */
function InnerTabBar({ d, tabKey, inner }: { d: PullRequestDetailView; tabKey: string; inner: PrInnerTab }) {
  const entries = useMemo(() => (inner === "timeline" ? timeline(d).length : 0), [d, inner]);
  return (
    <div className="sticky top-0 z-10 flex h-11 min-w-0 items-center gap-2 border-b border-cf-divider bg-cf-surface px-4 @max-[340px]:gap-1.5 @max-[340px]:px-3" data-testid="pr-inner-bar">
      <div role="tablist" aria-label="Pull request views" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-cf-surface-sunken/60 p-0.5 dark:bg-cf-surface-sunken/40">
        {innerTabs.map((t) => {
          const active = t.id === inner;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`pr-tab-${t.id}`}
              className={cn(
                "h-6 rounded-md px-2.5 text-body-sm outline-none focus-visible:ring-1 focus-visible:ring-cf-focus @max-[340px]:px-2",
                active ? "bg-cf-surface text-cf-text shadow-xs dark:bg-cf-control-hover" : "text-cf-text-muted hover:text-cf-text",
              )}
              onClick={() => {
                setInnerTab(tabKey, t.id);
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden" data-testid="pr-inner-bar-end">
        {inner === "summary" ? (
          <ChecksHeadline d={d} />
        ) : inner === "code" ? null : (
          <>
            <span className="flex shrink-0 items-center gap-2 text-caption whitespace-nowrap tabular-nums @max-[400px]:hidden" data-testid="pr-timeline-counts">
              {/* Timeline entries, not comments: the header's comment count includes thread replies the timeline leaves out. */}
              <span className="flex items-center gap-1">
                <History className="size-3" aria-hidden />
                {entries} {entries === 1 ? "entry" : "entries"}
              </span>
              <span>·</span>
              <Tip label={`${String(d.commitCount)} commits`}>
                <span className="flex items-center gap-1">
                  <GitCommitHorizontal className="size-3.5" aria-hidden />
                  {d.commitCount}
                </span>
              </Tip>
            </span>
            <OrderToggle tabKey={tabKey} which="timelineOrder" compact />
          </>
        )}
      </div>
    </div>
  );
}

/** "Showing the copy from 5m ago": its own 30 s clock, so the surface root does not re-render with it. */
function StaleBanner({ fetchedAtMs, lastError }: { fetchedAtMs: number | null; lastError: string }) {
  const now = useNow(30_000);
  return (
    <Banner testId="pr-stale">
      Showing the copy from {ago(fetchedAtMs, now) || "earlier"}: the last fetch from GitHub failed ({lastError}).
    </Banner>
  );
}

function Banner({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-cf-warning/30 bg-cf-warning-surface px-3 py-2 text-caption text-cf-warning-text" role="status" data-testid={testId}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** The detail's first load: bars where the header, the tabs and the body will be. */
function Loading() {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="pr-loading" aria-busy="true" aria-label="Loading pull request">
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="mt-4 h-7 w-48" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

function Centered({ icon: Icon, title, children, testId }: { icon: typeof SearchX; title: string; children?: ReactNode; testId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-body" data-testid={testId}>
      <Icon className="size-5 text-cf-text-muted" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-80 text-caption break-words">{children}</div>}
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
  // The composer under the header: Ask a question, or a review with its verdict (one at a time).
  const [composer, setComposer] = useState<"ask" | Verdict | null>(null);
  // Bumped each time Ask or a verdict is chosen: the composer (re)takes focus.
  const [composerFocus, setComposerFocus] = useState(0);
  const openComposer = (which: "ask" | Verdict) => {
    setComposer(which);
    setComposerFocus((n) => n + 1);
  };
  const closeComposer = () => {
    setComposer(null);
  };
  // The pull request stopped taking reviews here (merged, closed, write access lost):
  // Review ▾ is gone, and so is its composer (adjusted during render, not in an effect).
  if (composer !== null && composer !== "ask" && d && !reviewVisible(d)) setComposer(null);

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
    return <Loading />;
  }
  return (
    // @container: the header, tab bar and summary rows adapt to the panel's width.
    // The Code tab fills the panel: its diff scrolls itself (a virtualized CodeView) under the header.
    <div className={cn("@container flex min-w-0 flex-col", inner === "code" && "min-h-0 flex-1")} data-testid="pr-surface" data-pr={`${slug}#${String(number)}`}>
      <Header
        d={d}
        prRef={prRef}
        panelKey={panelKey}
        onAsk={() => {
          openComposer("ask");
        }}
        onReview={openComposer}
      />
      {composer === "ask" ? (
        <PrAskComposer key="ask" prRef={prRef} focusRequest={composerFocus} onClose={closeComposer} />
      ) : composer !== null ? (
        // One instance across verdicts: switching keeps the text.
        <PrReviewComposer key="review" prRef={prRef} verdict={composer} focusRequest={composerFocus} onClose={closeComposer} />
      ) : null}
      {d.lastError && !d.checksTruncated && <StaleBanner fetchedAtMs={d.fetchedAtMs} lastError={d.lastError} />}
      {error && <Banner testId="pr-refresh-error">Could not refresh: {error}</Banner>}
      <InnerTabBar d={d} tabKey={tabKey} inner={inner} />
      {inner === "timeline" ? (
        <PrTimeline d={d} tabKey={tabKey} />
      ) : inner === "code" ? (
        <PrCode prRef={prRef} tabKey={tabKey} url={d.pullRequest.url} />
      ) : (
        <PrSummary d={d} prRef={prRef} tabKey={tabKey} />
      )}
    </div>
  );
}
