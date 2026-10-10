import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Copy, ExternalLink, GitBranch, GitPullRequestArrow } from "lucide-react";
import { ChecksBadge } from "@/components/prs/PrBits";
import { RowAction } from "@/components/projects/WorktreeState";
import { RowList } from "@/components/prs/RowList";
import { ago, stateBadge } from "@/components/pr/model";
import { toneBadge } from "@/components/pr/tones";
import { useNow } from "@/lib/clock";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { SESSION_LABEL } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { copyPullRequestLink, openPullRequestInPanel } from "@/stores/prPanel";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { linkedCount, newestFirst, spansRepos, urlHost } from "@/surfaces/linkedprsTarget";

/** Two lines: number, title, state and checks; then branch, repository and when it was linked. */
export const LINKED_PR_ROW_HEIGHT = 48;

const SEP = "\u0000";

/** A linked pull request as a row shows it (from the thread's linkedPullRequests). */
export interface LinkRow {
  slug: string;
  number: number;
  url: string;
  linkedAt: number | null;
}

/**
 * The thread this panel belongs to: the selected session, or the thread of the selected
 * terminal; "" otherwise. (A panel always shows the current selection's panel, so the
 * selection is the panel's owner.)
 */
function useThreadId(): string {
  const sel = useUiStore((s) => s.selection);
  const termThread = useTerminalsStore((s) => (sel.kind === "terminal" ? (s.byId[sel.id]?.labels[SESSION_LABEL] ?? "") : ""));
  return sel.kind === "session" ? sel.id : termThread;
}

/** The thread's links, newest first. Re-renders only when the list changes. */
function useLinkRows(threadId: string): LinkRow[] {
  const encoded = useSessionsStore(
    useShallow((s) => (s.byId[threadId]?.linkedPullRequests ?? []).map((l) => [l.url, l.slug, String(l.number), l.linkedAt === null ? "" : String(l.linkedAt)].join(SEP))),
  );
  return useMemo(
    () =>
      newestFirst(encoded).map((e) => {
        const [url = "", slug = "", number = "0", at = ""] = e.split(SEP);
        return { url, slug, number: Number(number), linkedAt: at === "" ? null : Number(at) };
      }),
    [encoded],
  );
}

function Header({ threadId }: { threadId: string }) {
  const name = useSessionsStore((s) => s.byId[threadId]?.name || threadId);
  const count = useSessionsStore((s) => s.byId[threadId]?.linkedPullRequests.length ?? 0);
  return (
    <header className="flex min-w-0 items-center gap-1.5 border-b border-pane-border px-4 py-2.5 text-sm font-semibold @max-[340px]:px-3" data-testid="linkedprs-header">
      <GitPullRequestArrow className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <span className="min-w-0 truncate" data-testid="linkedprs-thread">
        {name}
      </span>
      <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums" data-testid="linkedprs-count">
        {linkedCount(count)}
      </span>
    </header>
  );
}

/** Open, Draft, Merged or Closed, as a small chip (the PR surface header's tones). */
function StateChip({ state, draft }: { state: Parameters<typeof stateBadge>[0]["state"]; draft: boolean }) {
  const b = stateBadge({ state, draft });
  return (
    <span className={cn("shrink-0 rounded-sm border px-1 text-[10px] leading-4 font-medium", toneBadge[b.tone])} data-testid="linkedpr-state" data-state={b.label.toLowerCase()}>
      {b.label}
    </span>
  );
}

function LinkedAge({ ms }: { ms: number | null }) {
  const now = useNow(30_000);
  if (ms === null) return null;
  return (
    <span className="shrink-0 tabular-nums" title={`Linked ${new Date(ms).toLocaleString()}`} data-testid="linkedpr-age">
      linked {ago(ms, now)}
    </span>
  );
}

/**
 * One linked pull request. Title, state, checks and branch come from the pull request's
 * cached detail (pullRequestDetailResource, the PR surface's own resource: watching it
 * keeps it re-read while shown, and the tab opened from here starts warm). Until it
 * loads, the number and the URL's host stand in, with a skeleton for the title.
 */
function LinkedPrRow({ link, showRepo }: { link: LinkRow; showRepo: boolean }) {
  const key = pullRequestKey(link.slug, link.number);
  useEffect(() => pullRequestDetailResource.watch(key), [key]);
  const pr = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest ?? null);
  const failed = pullRequestDetailResource.store((s) => (s.entries[key]?.data ? null : (s.entries[key]?.error ?? null)));
  const ref = { slug: link.slug, number: link.number };
  return (
    <NavRow
      navKey={link.url}
      activateOnClick
      onCmdClick={() => void openUrl(link.url)}
      className="group/link flex h-full flex-col justify-center gap-0.5 px-2"
      title={`${link.url}\nClick or Enter: open · ⌘-click: open on GitHub`}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm" data-testid="linkedpr" data-url={link.url} data-loaded={pr ? "true" : "false"}>
        <span className="shrink-0 font-medium text-muted-foreground tabular-nums" data-testid="linkedpr-number">
          #{link.number}
        </span>
        {pr ? (
          <span className="min-w-0 flex-1 truncate" title={pr.title} data-testid="linkedpr-title">
            {pr.title}
          </span>
        ) : failed ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={failed} data-testid="linkedpr-unavailable">
            {urlHost(link.url)} · details unavailable
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5" aria-busy="true" data-testid="linkedpr-loading">
            <span className="shrink-0 text-xs text-muted-foreground">{urlHost(link.url)}</span>
            <span className="h-3 max-w-40 flex-1 animate-pulse rounded bg-muted" />
          </span>
        )}
        {pr && <StateChip state={pr.state} draft={pr.draft} />}
        {pr?.state === "open" && <ChecksBadge checks={pr.checks} compact />}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {pr?.headRef && (
          <span className="flex min-w-0 items-center gap-1" data-testid="linkedpr-branch">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono">{pr.headRef}</span>
          </span>
        )}
        {showRepo && (
          <span className="min-w-0 shrink truncate" data-testid="linkedpr-repo">
            {pr?.headRef && <span aria-hidden>· </span>}
            {link.slug}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
          <LinkedAge ms={link.linkedAt} />
          <span className="-my-1 hidden items-center group-hover/link:flex group-aria-selected/link:flex">
            <RowAction label="Open on GitHub" testId="linkedpr-open-github" onClick={() => void openUrl(link.url)}>
              <ExternalLink />
            </RowAction>
            <RowAction label="Copy link" testId="linkedpr-copy" onClick={() => void copyPullRequestLink(ref, link.url)}>
              <Copy />
            </RowAction>
          </span>
        </span>
      </span>
    </NavRow>
  );
}

/**
 * Opens a linked pull request as a tab of this panel (click or Enter). The list unmounts
 * when the tab switches, so focus that was in it moves to the panel first: cmd+w and the
 * panel's letters keep working.
 */
function openLink(list: HTMLElement | null, link: LinkRow): void {
  if (list?.contains(document.activeElement)) list.closest<HTMLElement>('[data-region="panel"]')?.focus({ preventScroll: true });
  openPullRequestInPanel({ slug: link.slug, number: link.number });
}

/**
 * The side panel's Linked PRs surface: the selected thread's linked pull requests (the
 * thread's pr-link records), newest first, as a keyboard listbox (j/k or arrows, Enter
 * opens, cmd+Enter opens on GitHub). A row opens its pull request as a tab of this panel.
 */
export function LinkedPRsSurface() {
  const threadId = useThreadId();
  const known = useSessionsStore((s) => threadId !== "" && s.byId[threadId] !== undefined);
  const rows = useLinkRows(threadId);
  const showRepo = useSessionsStore((s) => spansRepos(s.byId[threadId]?.linkedPullRequests ?? []));
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<NavItem[]>(
    () =>
      rows.map((link) => ({
        key: link.url,
        activate: () => {
          openLink(listRef.current, link);
        },
        secondary: () => void openUrl(link.url),
      })),
    [rows],
  );
  const nav = useNav(items);

  return (
    // @container: the header and rows adapt to the panel's width (down to 280px).
    <div className="@container flex min-w-0 flex-col" data-testid="linkedprs-surface" data-thread={threadId || undefined}>
      {!known ? (
        <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="linkedprs-missing">
          Select a thread to see the pull requests it linked.
        </p>
      ) : (
        <>
          <Header threadId={threadId} />
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="linkedprs-empty">
              No linked PRs yet. Pull requests this thread creates or mentions show up here.
            </p>
          ) : (
            <NavProvider value={nav.ctx}>
              <div
                ref={listRef}
                tabIndex={0}
                role="listbox"
                aria-label="Linked pull requests"
                aria-activedescendant={nav.activeDescendant}
                className="px-2 py-2 outline-none"
                data-testid="linkedprs-list"
                onKeyDown={nav.onKeyDown}
              >
                <RowList
                  rows={rows}
                  rowKey={(l) => l.url}
                  rowHeight={LINKED_PR_ROW_HEIGHT}
                  testId="linkedprs-rows"
                  render={(l) => <LinkedPrRow link={l} showRepo={showRepo} />}
                />
              </div>
            </NavProvider>
          )}
        </>
      )}
    </div>
  );
}
