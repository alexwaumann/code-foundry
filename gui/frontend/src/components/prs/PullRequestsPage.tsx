import { useEffect, useMemo, useRef } from "react";
import { Check, GitPullRequest } from "lucide-react";
import type { DashboardView, PullRequestView } from "@/api/gh";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { DASHBOARD_KEY, dashboardResource, openUrl, useFreshness } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { useResource } from "@/stores/resource";
import { useUiStore } from "@/stores/ui";
import { ActivityCharts } from "./ActivityCharts";
import { authoredRows } from "./authoredStatus";
import { prKey } from "./format";
import { InboxZero } from "./InboxZero";
import { Freshness, SectionTitle } from "./PrBits";
import { AuthoredPrRow, MergedRow, NeedsReviewRow, PrTable, ReviewedByYouRow, type Section } from "./PrRows";
import { needsReviewCount, reviewQueue } from "./reviewQueue";

/** The daemon polls every minute by default; older than a few polls plus slack is stale. */
const STALE_AFTER_MS = 5 * 60_000;

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-body", tone === "warn" ? "border-cf-warning/40 bg-cf-warning-surface text-cf-warning-text" : "text-cf-text-muted")} role="status">
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 text-body text-cf-text-muted">{children}</p>;
}

function Body({ d }: { d: DashboardView }) {
  const viewer = d.viewer?.login ?? "";
  const queue = useMemo(() => reviewQueue(d.reviewRequested, d.reviewed, viewer), [d.reviewRequested, d.reviewed, viewer]);
  const authored = useMemo(() => authoredRows(d.authored), [d.authored]);
  const merged = useMemo(() => d.recentlyMerged.map((pr) => ({ pr })), [d.recentlyMerged]);
  const items = useMemo<NavItem[]>(() => {
    const mk = (section: Section, list: readonly { pr: PullRequestView }[]) =>
      list.map(({ pr: p }) => ({
        key: prKey(section, p),
        // Enter and click open the pull request in the side panel; cmd+Enter and cmd+click on GitHub.
        activate: () => void openPullRequestInPanel({ slug: p.repoSlug, number: p.number }),
        secondary: () => void openUrl(p.url),
      }));
    // Keyboard order is page order.
    return [...mk("review", queue.needs), ...mk("reviewed", queue.reviewed), ...mk("authored", authored), ...mk("merged", merged)];
  }, [queue, authored, merged]);
  const nav = useNav(items);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <NavProvider value={nav.ctx}>
      <div
        ref={rootRef}
        tabIndex={0}
        role="listbox"
        aria-label="Pull requests"
        aria-activedescendant={nav.activeDescendant}
        className="flex flex-col gap-6 outline-none"
        data-testid="prs-list"
        data-focus-root
        onKeyDown={nav.onKeyDown}
      >
        {!d.authenticated && <Banner tone="warn">gh is not authenticated. Run `gh auth login`; the lists below are from the last successful poll.</Banner>}
        {d.dashboardsDisabled && (
          <Banner tone="info">
            Pull request dashboards are turned off (<span className="font-mono">github.dashboards_enabled</span> in Settings), so the lists are empty.
          </Banner>
        )}
        <section data-testid="prs-review">
          <SectionTitle count={queue.needs.length}>Needs your review</SectionTitle>
          {queue.needs.length > 0 ? (
            <PrTable section="review" rows={queue.needs} render={(r) => <NeedsReviewRow row={r} viewer={viewer} />} />
          ) : (
            <InboxZero authored={authored} merged={d.recentlyMerged} viewer={viewer} />
          )}
          {queue.reviewed.length > 0 && (
            <div className="mt-2.5" data-testid="prs-reviewed">
              <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-body-sm text-cf-text-muted">
                <Check className="size-3.5 shrink-0" aria-hidden />
                <span>Reviewed by you</span>
                <span className="tabular-nums">({queue.reviewed.length})</span>
                <span>· open, waiting on the author</span>
              </p>
              <PrTable section="reviewed" rows={queue.reviewed} render={(r) => <ReviewedByYouRow row={r} viewer={viewer} />} />
            </div>
          )}
        </section>
        <section data-testid="prs-authored">
          <SectionTitle count={authored.length}>Your open pull requests</SectionTitle>
          {authored.length > 0 ? <PrTable section="authored" rows={authored} render={(r) => <AuthoredPrRow row={r} />} /> : <Empty>No open pull requests of yours.</Empty>}
        </section>
        <section data-testid="prs-merged">
          <SectionTitle count={merged.length}>Merged in the last 7 days</SectionTitle>
          {merged.length > 0 ? <PrTable section="merged" rows={merged} render={(r) => <MergedRow pr={r.pr} viewer={viewer} />} /> : <Empty>Nothing merged in the last 7 days.</Empty>}
        </section>
        <ActivityCharts months={d.stats.months} />
      </div>
    </NavProvider>
  );
}

/** The global Pull Requests page: the viewer's review inbox and own pull requests in every repository. */
export function PullRequestsPage() {
  const entry = useResource(dashboardResource, DASHBOARD_KEY);
  const d = entry?.data ?? null;
  const fresh = useFreshness(d?.fetchedAtMs ?? null, d?.lastError || entry?.error || "", true);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Pull Requests" data-testid="prs-page">
      <PaneHeader className="gap-3 px-5">
        <GitPullRequest className="size-4 text-cf-text-muted" aria-hidden />
        <h1 className="text-heading">Pull Requests</h1>
        <span className="ml-auto flex items-center gap-2 text-caption">
          {d?.viewer && (
            <span className="font-mono" data-testid="prs-viewer">
              @{d.viewer.login}
            </span>
          )}
          {d && <span aria-hidden>·</span>}
          {d && <Freshness fetchedAtMs={fresh.fetchedAtMs} lastError={fresh.lastError} staleAfterMs={STALE_AFTER_MS} testId="prs-updated" />}
        </span>
        <PanelToggle className="-mr-2" />
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {d ? (
          <div className="mx-auto max-w-6xl">
            <Body d={d} />
          </div>
        ) : entry?.error ? (
          <Banner tone="warn">Cannot load pull requests: {entry.error}</Banner>
        ) : (
          <p className="text-body text-cf-text-muted">Loading…</p>
        )}
      </div>
    </section>
  );
}

/**
 * How many pull requests need the viewer's review, from the dashboard the sidebar watches
 * (useSidebarDashboard); 0 until it loads. A number, so the row re-renders only when it changes.
 */
function useNeedsReviewCount(): number {
  return dashboardResource.store((s) => {
    const d = s.entries[DASHBOARD_KEY]?.data;
    return d ? needsReviewCount(d.reviewRequested, d.reviewed, d.viewer?.login ?? "") : 0;
  });
}

/** The sidebar's Pull Requests entry, with an amber count of the pull requests that need the viewer's review. */
export function PullRequestsNav() {
  const active = useUiStore((s) => s.selection.kind === "view" && s.selection.name === "pullrequests");
  const count = useNeedsReviewCount();
  return (
    <button
      type="button"
      className={cn(
        "mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-body-sm",
        active ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground" : "text-cf-sidebar-foreground hover:bg-cf-sidebar-row-hover",
      )}
      data-testid="nav-pullrequests"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useUiStore.getState().select({ kind: "view", name: "pullrequests" });
      }}
    >
      <GitPullRequest className="size-4 shrink-0 text-cf-icon-muted" aria-hidden />
      <span className="truncate">Pull Requests</span>
      {count > 0 && (
        // The pill hides the words, so the tooltip says them.
        <Tip label={count === 1 ? "1 pull request needs your review" : `${String(count)} pull requests need your review`}>
          <span
            className="ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-cf-warning-surface px-1.5 text-caption-sm font-semibold tabular-nums text-cf-warning-text"
            data-testid="nav-pullrequests-count"
          >
            {count}
          </span>
        </Tip>
      )}
    </button>
  );
}
