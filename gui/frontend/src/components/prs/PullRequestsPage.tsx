import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitPullRequest } from "lucide-react";
import type { DashboardView, PullRequestView } from "@/api/gh";
import { Skeleton } from "@/components/ui/skeleton";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { DASHBOARD_KEY, dashboardResource, openUrl, pullRequestKey, useFreshness, useProjectsFreshness } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { armPrefetch, disarmPrefetch } from "@/stores/prPrefetch";
import { useResource } from "@/stores/resource";
import { ActivityCharts } from "./ActivityCharts";
import { prKey } from "./format";
import { capKey, cards, dashboardLoad, liveFilter, mergedSubtitle, olderFreshness, pageModel, sectionRows, SECTIONS, type PageModel, type Section } from "./pageModel";
import { SectionTitle } from "@/components/table/TableParts";
import { Freshness } from "./PrBits";
import { AuthoredPrRow, MergedRow, NeedsReviewRow, OtherPrRow, PrTable, ReviewedByYouRow } from "./PrRows";
import { SummaryCards } from "./SummaryCards";
import { useServesFocusRequests } from "@/shell/paneContext";

/** The daemon polls every minute by default; older than a few polls plus slack is stale. */
const STALE_AFTER_MS = 5 * 60_000;

function Banner({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-body", tone === "warn" ? "border-cf-warning/40 bg-cf-warning-surface text-cf-warning-text" : "text-cf-text-muted")} role="status">
      {children}
    </p>
  );
}

/** A section's rows in page order, for the keyboard. */
function sectionPrs(m: PageModel, s: Section): readonly { pr: PullRequestView }[] {
  switch (s) {
    case "review":
      return m.needs;
    case "reviewed":
      return m.reviewed;
    case "authored":
      return m.authored;
    case "else":
      return m.others;
    case "merged":
      return m.merged;
  }
}

function Body({ d }: { d: DashboardView }) {
  const viewer = d.viewer?.login ?? "";
  const m = useMemo(() => pageModel(d), [d]);
  const [picked, setPicked] = useState<Section | null>(null);
  // A filtered section that emptied after a poll clears the filter (for good, not until it fills again).
  const filter = liveFilter(m, picked);
  if (picked !== null && filter === null) setPicked(null);
  const shown = useMemo(() => SECTIONS.filter((s) => sectionRows(m, s) > 0 && (filter === null || filter === s)), [m, filter]);
  const items = useMemo<NavItem[]>(
    () =>
      // Keyboard order is page order, over the sections shown; a capped section's footer after its rows.
      shown.flatMap((s): NavItem[] => {
        const rows = sectionPrs(m, s).map(({ pr: p }) => ({
          key: prKey(s, p),
          // Enter and click open the pull request in a tab; cmd+Enter and cmd+click on GitHub.
          activate: () => void openPullRequestInPanel({ slug: p.repoSlug, number: p.number }),
          secondary: () => void openUrl(p.url),
        }));
        const cap = s === "else" ? m.othersCap : s === "merged" ? m.mergedCap : null;
        if (!cap) return rows;
        const open = () => void openUrl(cap.searchUrl);
        return [...rows, { key: capKey(s), activate: open, secondary: open }];
      }),
    [m, shown],
  );
  const nav = useNav(items);
  // The keyboard's cursor warms its row as the pointer does (stores/prPrefetch.ts).
  const cursorPr = useMemo(() => {
    for (const s of shown) {
      const row = sectionPrs(m, s).find(({ pr }) => prKey(s, pr) === nav.cursorKey);
      if (row) return pullRequestKey(row.pr.repoSlug, row.pr.number);
    }
    return null;
  }, [m, shown, nav.cursorKey]);
  useEffect(() => {
    if (cursorPr === null) return;
    armPrefetch(cursorPr);
    return () => {
      disarmPrefetch(cursorPr);
    };
  }, [cursorPr]);
  const rootRef = useRef<HTMLDivElement>(null);
  // On mount the page takes the keyboard, unless it opens in a shell pane without the focus.
  const takesFocus = useServesFocusRequests();
  useEffect(() => {
    if (takesFocus) rootRef.current?.focus({ preventScroll: true });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);
  const has = (s: Section) => shown.includes(s);
  return (
    <NavProvider value={nav.ctx}>
      {/* Escape anywhere on the page (the list, a card) shows every section again, unless something
          open on it (a tooltip, a menu) already took the key. */}
      <div
        className="flex flex-col gap-6"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented || filter === null || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          setPicked(null);
          rootRef.current?.focus({ preventScroll: true });
        }}
      >
        {!d.authenticated && <Banner tone="warn">gh is not authenticated. Run <span className="font-mono">gh auth login</span>; the lists below are from the last successful poll.</Banner>}
        {d.dashboardsDisabled && (
          <Banner tone="info">
            Pull request dashboards are turned off (<span className="font-mono">github.dashboards_enabled</span> in Settings), so the lists are empty.
          </Banner>
        )}
        <ActivityCharts months={d.stats.months} />
        <SummaryCards
          cards={cards(m)}
          filter={filter}
          rows={(s) => sectionRows(m, s)}
          onToggle={(s) => {
            setPicked(filter === s ? null : s);
            // Keep the keyboard on the list (a click may have focused the card).
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
        {/* The listbox holds the sections only: their rows and cap footers are its options. */}
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
          {has("review") && (
            <section data-testid="prs-review">
              <SectionTitle count={m.counts.review}>Needs your review</SectionTitle>
              <PrTable section="review" rows={m.needs} render={(r) => <NeedsReviewRow row={r} viewer={viewer} />} />
            </section>
          )}
          {has("reviewed") && (
            <section data-testid="prs-reviewed">
              <SectionTitle count={m.counts.reviewed} captionTestId="prs-section-caption" caption="open, waiting on the author">
                Reviewed by you
              </SectionTitle>
              <PrTable section="reviewed" rows={m.reviewed} render={(r) => <ReviewedByYouRow row={r} viewer={viewer} />} />
            </section>
          )}
          {has("authored") && (
            <section data-testid="prs-authored">
              <SectionTitle count={m.counts.authored}>Your open pull requests</SectionTitle>
              <PrTable section="authored" rows={m.authored} render={(r) => <AuthoredPrRow row={r} />} />
            </section>
          )}
          {has("else") && (
            <section data-testid="prs-else">
              <SectionTitle count={m.counts.else} captionTestId="prs-section-caption" caption="not yours, not waiting on you · updated in the last month">
                Everything else open in your projects
              </SectionTitle>
              <PrTable section="else" rows={m.others} cap={m.othersCap} render={(r) => <OtherPrRow row={r} viewer={viewer} />} />
            </section>
          )}
          {has("merged") && (
            <section data-testid="prs-merged">
              <SectionTitle count={m.counts.merged} captionTestId="prs-section-caption" caption={mergedSubtitle(m.mergedInvolved, m.mergedMore, true)}>
                Merged in the last 7 days
              </SectionTitle>
              <PrTable section="merged" rows={m.merged} cap={m.mergedCap} render={(r) => <MergedRow row={r} viewer={viewer} />} />
            </section>
          )}
          {shown.length === 0 && (
            <p className="px-0.5 text-body text-cf-text-muted" data-testid="prs-empty">
              No open pull requests, and nothing merged this week.
            </p>
          )}
        </div>
      </div>
    </NavProvider>
  );
}

/** Before the first answer: the page's own shape (two charts, five cards, a table's rows), so nothing jumps when it comes. */
function PageLoading() {
  return (
    <div className="flex flex-col gap-6" data-testid="prs-loading" aria-busy="true" aria-label="Loading pull requests">
      <div className="@container">
        <div className="grid grid-cols-2 gap-4 @max-[760px]:grid-cols-1">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      </div>
      <div className="@container">
        <div className="grid grid-cols-5 gap-3 @max-[640px]:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-48" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * The global Pull Requests page (docs/notes/prs-page-2-gui.md): activity charts, five
 * summary cards that filter the page, then the viewer's review queue and own pull requests
 * in every repository, the rest open in the tracked ones, and this week's merges.
 */
export function PullRequestsPage() {
  const entry = useResource(dashboardResource, DASHBOARD_KEY);
  const d = entry?.data ?? null;
  const dashFresh = useFreshness(d?.fetchedAtMs ?? null, d?.lastError || entry?.error || "", true);
  const projectsFresh = useProjectsFreshness(d?.projectsFetchedAtMs ?? null, d?.projectsLastError ?? "");
  // The page shows two fetches: the older time, and either's error.
  const fresh = olderFreshness(dashFresh, projectsFresh);
  const load = d ? dashboardLoad(d, dashFresh, entry?.loading ?? false) : null;
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
          {d?.viewer && load === "ready" && <span aria-hidden>·</span>}
          {load === "ready" && <Freshness fetchedAtMs={fresh.fetchedAtMs} lastError={fresh.lastError} staleAfterMs={STALE_AFTER_MS} testId="prs-updated" />}
        </span>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {load === "ready" && d ? (
          <div className="mx-auto max-w-6xl">
            <Body d={d} />
          </div>
        ) : load === "failed" || entry?.error ? (
          <Banner tone="warn">Cannot load pull requests: {entry?.error || dashFresh.lastError}</Banner>
        ) : (
          <div className="mx-auto max-w-6xl">
            <PageLoading />
          </div>
        )}
      </div>
    </section>
  );
}
