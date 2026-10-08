import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { GitPullRequest } from "lucide-react";
import type { DashboardView, MonthView, PullRequestView } from "@/api/gh";
import { formatChord } from "@/keys/chord";
import { useNow } from "@/lib/clock";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import { dashboardResource, openUrl } from "@/stores/gh";
import { useResource } from "@/stores/resource";
import { useUiStore } from "@/stores/ui";
import { monthName, prKey, repoName } from "./format";
import { Age, ChecksBadge, Freshness, Kbd, PrStateIcon, ReviewBadge, SectionTitle } from "./PrBits";
import { RowList } from "./RowList";

/** Dashboards are polled every 2 minutes; older than two polls plus slack is stale. */
const STALE_AFTER_MS = 5 * 60_000;
const ROW_H = 28;

/** Page-local, kept across visits: show every repository instead of registered ones. */
const usePrPageStore = create<{ includeAll: boolean; toggle: () => void }>()((set) => ({
  includeAll: false,
  toggle: () => {
    set((s) => ({ includeAll: !s.includeAll }));
  },
}));

type Section = "authored" | "review" | "merged";

const columns: Record<Section, string> = {
  authored: "grid-cols-[minmax(7rem,12rem)_4rem_minmax(0,1fr)_8.5rem_8.5rem_3rem]",
  review: "grid-cols-[minmax(7rem,12rem)_4rem_minmax(5rem,9rem)_minmax(0,1fr)_8.5rem_3rem]",
  merged: "grid-cols-[minmax(7rem,12rem)_4rem_minmax(5rem,9rem)_minmax(0,1fr)_3rem]",
};

const headers: Record<Section, string[]> = {
  authored: ["Repository", "#", "Title", "Checks", "Review", "Age"],
  review: ["Repository", "#", "Author", "Title", "Checks", "Age"],
  merged: ["Repository", "#", "Author", "Title", "Merged"],
};

function PrRow({ section, pr, viewer }: { section: Section; pr: PullRequestView; viewer: string }) {
  const author = pr.author && pr.author.toLowerCase() === viewer.toLowerCase() ? "you" : pr.author || "ghost";
  return (
    <NavRow navKey={prKey(section, pr)} title={pr.url} className={cn("grid h-full items-center gap-3 px-2 text-sm", columns[section])}>
      <span className="truncate text-muted-foreground" title={pr.repoSlug}>
        {repoName(pr.repoSlug)}
      </span>
      <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
        <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
      </span>
      {section !== "authored" && <span className="truncate text-muted-foreground">{author}</span>}
      <span className="truncate" title={pr.title}>
        {pr.draft && <span className="mr-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground uppercase">draft</span>}
        {pr.title}
      </span>
      {section !== "merged" && <ChecksBadge checks={pr.checks} />}
      {section === "authored" && <ReviewBadge review={pr.review} />}
      <Age ms={section === "merged" ? pr.mergedAtMs : pr.updatedAtMs} className="text-right" />
    </NavRow>
  );
}

function PrTable({ section, title, rows, empty, viewer }: { section: Section; title: string; rows: PullRequestView[]; empty: string; viewer: string }) {
  return (
    <section data-testid={`prs-${section}`}>
      <SectionTitle count={rows.length}>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="rounded-md border">
          <div className={cn("grid gap-3 border-b px-2 py-1 text-[11px] tracking-wide text-muted-foreground uppercase", columns[section])}>
            {headers[section].map((h, i) => (
              <span key={h} className={cn(i === headers[section].length - 1 && "text-right")}>
                {h}
              </span>
            ))}
          </div>
          <div className="p-0.5">
            <RowList rows={rows} rowKey={(p) => prKey(section, p)} rowHeight={ROW_H} render={(p) => <PrRow section={section} pr={p} viewer={viewer} />} />
          </div>
        </div>
      )}
    </section>
  );
}

function MonthTile({ month, testId }: { month: MonthView; testId: string }) {
  const now = useNow(60_000);
  return (
    <div className="flex min-w-48 flex-col items-center gap-1 rounded-lg border px-6 py-3" data-testid={testId}>
      <span className="text-sm font-medium">{monthName(month.month, now)}</span>
      <div className="flex gap-8">
        <div className="flex flex-col items-center">
          <span className="text-2xl font-semibold tabular-nums" data-testid={`${testId}-commits`}>
            {month.commits}
          </span>
          <span className="text-xs text-muted-foreground">commits</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-2xl font-semibold tabular-nums" data-testid={`${testId}-merged`}>
            {month.merged}
          </span>
          <span className="text-xs text-muted-foreground">merged</span>
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <p className={cn("rounded-md border px-3 py-2 text-sm", tone === "warn" ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "text-muted-foreground")} role="status">
      {children}
    </p>
  );
}

function Body({ d, includeAll }: { d: DashboardView; includeAll: boolean }) {
  const viewer = d.viewer?.login ?? "";
  const items = useMemo<NavItem[]>(() => {
    const mk = (section: Section, list: PullRequestView[]) => list.map((p) => ({ key: prKey(section, p), activate: () => void openUrl(p.url) }));
    return [...mk("authored", d.authored), ...mk("review", d.reviewRequested), ...mk("merged", d.recentlyMerged)];
  }, [d]);
  const nav = useNav(items);
  const toggle = usePrPageStore((s) => s.toggle);
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
        onKeyDown={(e) => {
          if (e.key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            toggle();
            e.preventDefault();
            return;
          }
          nav.onKeyDown(e);
        }}
      >
        {!d.authenticated && <Banner tone="warn">gh is not authenticated. Run `gh auth login`; the lists below are from the last successful poll.</Banner>}
        {!includeAll && d.trackedSlugs.length === 0 && (
          <Banner tone="info">
            No registered repository has a GitHub remote, so the lists are empty. Press <Kbd>A</Kbd> to show pull requests from every repository.
          </Banner>
        )}
        <div className="flex flex-wrap gap-4">
          <MonthTile month={d.stats.thisMonth} testId="tile-this-month" />
          <MonthTile month={d.stats.lastMonth} testId="tile-last-month" />
        </div>
        <PrTable section="authored" title="Open PRs · authored by you" rows={d.authored} empty="No open PRs authored by you." viewer={viewer} />
        <PrTable section="review" title="PRs awaiting your review" rows={d.reviewRequested} empty="Nothing awaiting your review." viewer={viewer} />
        <PrTable section="merged" title="Merged PRs · last 7 days" rows={d.recentlyMerged} empty="Nothing merged in the last 7 days." viewer={viewer} />
      </div>
    </NavProvider>
  );
}

/** The global Pull Requests page: the viewer's GitHub dashboards across registered repos. */
export function PullRequestsPage() {
  const includeAll = usePrPageStore((s) => s.includeAll);
  const toggle = usePrPageStore((s) => s.toggle);
  const entry = useResource(dashboardResource, includeAll ? "all" : "tracked");
  const d = entry?.data ?? null;
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Pull Requests" data-testid="prs-page">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-5">
        <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-semibold">Pull Requests</h1>
        <button
          type="button"
          onClick={toggle}
          className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          title="Toggle with A"
          data-testid="prs-scope"
        >
          {includeAll ? "all repositories" : "registered repositories"}
        </button>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {d?.viewer && (
            <span className="font-mono" data-testid="prs-viewer">
              @{d.viewer.login}
            </span>
          )}
          {d && <span aria-hidden>·</span>}
          {d && <Freshness fetchedAtMs={d.fetchedAtMs} lastError={d.lastError || entry?.error || ""} staleAfterMs={STALE_AFTER_MS} testId="prs-updated" />}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {d ? (
          <div className="mx-auto max-w-6xl">
            <Body d={d} includeAll={includeAll} />
          </div>
        ) : entry?.error ? (
          <Banner tone="warn">Cannot load pull requests: {entry.error}</Banner>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </div>
    </section>
  );
}

/** Sidebar entry above the repository tree. */
export function PullRequestsNav() {
  const active = useUiStore((s) => s.selection.kind === "view" && s.selection.name === "pullrequests");
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "view.pullrequests")?.keybindings[0] ?? "");
  return (
    <button
      type="button"
      className={cn(
        "mx-1.5 mt-1.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px]",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
      data-testid="nav-pullrequests"
      aria-current={active ? "page" : undefined}
      title={chord ? `Pull Requests (${formatChord(chord)})` : "Pull Requests"}
      onClick={() => {
        useUiStore.getState().select({ kind: "view", name: "pullrequests" });
      }}
    >
      <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">Pull Requests</span>
      {chord && <span className="ml-auto text-[11px] text-muted-foreground">{formatChord(chord)}</span>}
    </button>
  );
}
