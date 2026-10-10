/**
 * The Linked PRs surface's targets: which thread a selection resolves to, whether it has
 * linked pull requests (availability), the tab, and the list's order and labels. Pure:
 * callers feed it the stores' current state.
 */
import type { LinkedPullRequestView } from "@/api/session";
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import type { ReposData } from "@/stores/repos";
import type { SessionsData } from "@/stores/sessions";
import type { TerminalsData } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";

export const LINKED_PRS_KIND = "linkedprs";
export const LINKED_PRS_TITLE = "Linked PRs";

export interface SelectionStores {
  repos: ReposData;
  sessions: SessionsData;
  terminals: TerminalsData;
}

/**
 * The selection's thread: a session, or a thread's terminal (deriveContext's
 * activeSessionId, which is what view.panel.linked-prs's availability sees), when the
 * sessions store knows it. Null for a plain terminal, a worktree, a page or a composer.
 */
export function selectionThread(sel: Selection, s: SelectionStores): string | null {
  if (sel.kind !== "session" && sel.kind !== "terminal") return null;
  const id = deriveContext(sel, s.terminals, s.repos, s.sessions).activeSessionId;
  return id && s.sessions.byId[id] ? id : null;
}

/** The selection's thread when it has at least one linked pull request (the surface is enabled); else null. */
export function selectionLinkedThread(sel: Selection, s: SelectionStores): string | null {
  const id = selectionThread(sel, s);
  return id !== null && (s.sessions.byId[id]?.linkedPullRequests.length ?? 0) > 0 ? id : null;
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function linkedPrsTab(): Tab {
  return makeTab(LINKED_PRS_KIND, LINKED_PRS_TITLE);
}

/** The list's order: newest linked first, i.e. the stored first-seen order reversed. */
export function newestFirst<T>(links: readonly T[]): T[] {
  return [...links].reverse();
}

/** Whether the links span more than one repository (rows then name theirs). */
export function spansRepos(links: readonly Pick<LinkedPullRequestView, "slug">[]): boolean {
  const first = links[0]?.slug.toLowerCase();
  return links.some((l) => l.slug.toLowerCase() !== first);
}

/** The URL's host ("github.com"), or the URL itself when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** "1 linked PR", "3 linked PRs". */
export function linkedCount(n: number): string {
  return `${String(n)} linked ${n === 1 ? "PR" : "PRs"}`;
}

/** The sidebar badge: "1 PR", "3 PRs". */
export function prBadge(n: number): string {
  return `${String(n)} ${n === 1 ? "PR" : "PRs"}`;
}
