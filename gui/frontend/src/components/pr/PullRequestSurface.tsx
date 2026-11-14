import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ellipsis, GitCommitHorizontal, History, SearchX, TriangleAlert } from "lucide-react";
import { isNotFoundMessage, type PullRequestDetailView } from "@/api/gh";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey, useViewerLogin } from "@/stores/gh";
import { useCurrentTarget } from "@/shell/host";
import { pullRequestDiffResource, warmPullRequestDiff } from "@/stores/prDiff";
import { setInnerTab, usePrPanelStore, type PrInnerTab } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Banner } from "./Banner";
import { ago, timeline } from "./model";
import { PrAskComposer } from "./PrAskComposer";
import { PrCode } from "./PrCode";
import { PrHeader } from "./PrHeader";
import { PrMenu } from "./PrMenu";
import { OrderToggle, PrOverview } from "./PrOverview";
import { PrReviewComposer } from "./PrReviewComposer";
import { PrTimeline } from "./PrTimeline";
import { ReadinessBox, SeededReadinessBox } from "./ReadinessBox";
import { detailFresh } from "./readiness";
import { reviewVisible, type Verdict } from "./review";
import { seedDetail } from "./seed";
import { useSeedRow } from "./useSeedRow";

const innerTabs: { id: PrInnerTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "code", label: "Code" },
];

/**
 * Overview | Activity | Code, then the activity's counts and order (Activity); nothing for
 * Overview (the readiness box has the checks) or Code, whose strip has its own. Container
 * queries on the surface give way in steps, so nothing is pushed out of the bar or
 * overlaps: below 480px the order toggle keeps only its icon (the default 420px panel),
 * below 400px the counts go. Measured in WebKit: tabs 208px, counts 119px, toggle 96px.
 * No detail yet (d null): only the tabs, which work.
 */
function InnerTabBar({ d, tabKey, inner }: { d: PullRequestDetailView | null; tabKey: string; inner: PrInnerTab }) {
  const entries = useMemo(() => (d && inner === "activity" ? timeline(d).length : 0), [d, inner]);
  return (
    <div className="sticky top-0 z-10 mt-3 flex h-11 min-w-0 items-center gap-2 border-b border-cf-divider bg-cf-surface px-4 @max-[340px]:gap-1.5 @max-[340px]:px-3" data-testid="pr-inner-bar">
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
        {d?.refreshing && !d.fetchFailed && <Updating />}
        {d && inner === "activity" && (
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

/** How long a refresh behind the copy shown stays silent: the usual one lands well before this. */
export const UPDATING_AFTER_MS = 2_000;

/** A copy that is taking its time to refresh (the fetch queues behind a running poll): quiet text, and nothing at all on a normal open. */
function Updating() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setLate(true);
    }, UPDATING_AFTER_MS);
    return () => {
      clearTimeout(t);
    };
  }, []);
  if (!late) return null;
  return (
    <span className="min-w-0 truncate text-caption text-cf-text-muted" role="status" data-testid="pr-updating">
      Updating…
    </span>
  );
}

/** "Showing the copy from 5m ago": its own 30 s clock, so the surface root does not re-render with it. */
function StaleBanner({ fetchedAtMs, lastError }: { fetchedAtMs: number | null; lastError: string }) {
  const now = useNow(30_000);
  return (
    <Banner testId="pr-stale" className="mt-3">
      Showing the copy from {ago(fetchedAtMs, now) || "earlier"}: the last fetch from GitHub failed ({lastError}).
    </Banner>
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

/** Under a seeded header and box: bars for what only the detail has. */
function SeedBody() {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="pr-seed-body" aria-busy="true" aria-label="Loading pull request">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-3 h-3 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

/** Where the ⋯ menu will be, so nothing shifts when it comes: every item in it needs the detail. */
function MenuPending() {
  return (
    <span className="flex size-7 items-center justify-center text-cf-text-muted opacity-40" data-testid="pr-menu-pending" aria-hidden>
      <Ellipsis className="size-4" />
    </span>
  );
}

/**
 * Reads the diff of the pull request on screen ahead of the Code tab, once its detail has
 * landed and is current (a copy being refreshed may name a head about to go). Nothing for a
 * diff already read for this head, or one that failed: the tab tries that one itself.
 */
function useDiffWarm(key: string, d: PullRequestDetailView | null): void {
  const head = d && detailFresh(d) ? d.pullRequest.headSha : "";
  const settled = pullRequestDiffResource.store((s) => {
    const e = s.entries[key];
    return e?.error != null || (e?.data != null && e.data.headSha === head);
  });
  useEffect(() => (head === "" || settled ? undefined : warmPullRequestDiff(key)), [key, head, settled]);
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
 * The Pull request surface: one tab showing a pull request's detail
 * (GhService.GetPullRequestDetail through pullRequestDetailResource), modeled on T3
 * Code's panel. Inner view state lives in stores/prPanel.ts per tab. While the detail
 * is on its way the row the GUI already holds paints the header and what it can of the box
 * (seed.ts), and no action shows; with no row, the skeleton.
 */
export function PullRequestSurface({ tabId, slug, number }: { tabId: string; slug: string; number: number }) {
  const panelKey = useCurrentTarget() ?? "";
  // Inner view state is the tab's own (stores/prPanel.ts), linked to a thread or not.
  const tabKey = tabId;
  const prRef = useMemo<PrRef>(() => ({ slug, number }), [slug, number]);
  const key = pullRequestKey(slug, number);
  useEffect(() => pullRequestDetailResource.watch(key), [key]);
  const d = pullRequestDetailResource.store((s) => s.entries[key]?.data ?? null);
  const error = pullRequestDetailResource.store((s) => s.entries[key]?.error ?? null);
  const inner = usePrPanelStore((s) => s.byTab[tabKey]?.inner ?? "overview");
  const viewer = useViewerLogin();
  const seedRow = useSeedRow(key, d === null);
  const seed = useMemo(() => (seedRow ? seedDetail(seedRow) : null), [seedRow]);
  useDiffWarm(key, d);
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
  // The pull request stopped taking reviews here (merged, closed, write access and the request gone):
  // Review ▾ is gone, and so is its composer (adjusted during render, not in an effect).
  if (composer !== null && composer !== "ask" && d && !reviewVisible(d, viewer)) setComposer(null);

  const shown = d ?? seed;
  if (!shown || (!d && isNotFoundMessage(error))) {
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
    <div className={cn("@container flex min-w-0 flex-col", inner === "code" && "min-h-0 flex-1")} data-testid="pr-surface" data-pr={`${slug}#${String(number)}`} data-seeded={d ? undefined : ""}>
      <PrHeader
        d={shown}
        prRef={prRef}
        menu={
          d ? (
            <PrMenu
              prRef={prRef}
              detail={d}
              panelKey={panelKey}
              onAsk={() => {
                openComposer("ask");
              }}
            />
          ) : (
            <MenuPending />
          )
        }
      />
      {/* Ask's composer under the header, where its ⋯ menu is. */}
      {composer === "ask" && <PrAskComposer key="ask" prRef={prRef} focusRequest={composerFocus} onClose={closeComposer} />}
      {d?.fetchFailed && <StaleBanner fetchedAtMs={d.fetchedAtMs} lastError={d.lastError} />}
      {error && <Banner testId={d ? "pr-refresh-error" : "pr-seed-error"} className="mt-3">{d ? "Could not refresh" : "Could not load the rest of this pull request"}: {error}</Banner>}
      {d ? (
        <ReadinessBox d={d} prRef={prRef} panelKey={panelKey} tabKey={tabKey} onReview={openComposer} compact={inner === "code"} />
      ) : (
        <SeededReadinessBox d={shown} prRef={prRef} panelKey={panelKey} tabKey={tabKey} compact={inner === "code"} failed={error !== null} />
      )}
      {/* The review composer under the box, below Review ▾: nothing above the menu's button
          moves when it opens (a menu still fading out would slide under the pointer, and
          WebKit's synthetic mouse move would hand focus to one of its items). One instance
          across verdicts: switching keeps the text. */}
      {composer !== null && composer !== "ask" && <PrReviewComposer key="review" prRef={prRef} verdict={composer} focusRequest={composerFocus} onClose={closeComposer} />}
      <InnerTabBar d={d} tabKey={tabKey} inner={inner} />
      {!d ? (
        !error && <SeedBody />
      ) : inner === "activity" ? (
        <PrTimeline d={d} tabKey={tabKey} />
      ) : inner === "code" ? (
        <PrCode prRef={prRef} tabKey={tabKey} url={d.pullRequest.url} />
      ) : (
        <PrOverview d={d} prRef={prRef} tabKey={tabKey} />
      )}
    </div>
  );
}
