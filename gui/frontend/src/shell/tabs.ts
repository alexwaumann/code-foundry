/**
 * A surface's tab as surfaces name it (the host seam's `Tab`, shell/host.ts): its kind, title and
 * params, and an id made from the kind and params, so opening the same thing twice finds it. Pure,
 * with no store imports, so the seam's halves and the surfaces share it without a cycle. The ids
 * are the ones the classic side panel gave its tabs (a File tab's is its path alone), which the
 * shell keeps for a surface's own bookkeeping (shell/kinds.ts seamTab).
 */
import type { Selection } from "@/stores/ui";

/** What a tab shows: a SurfaceSpec kind from surfaces/registry.ts. A plain string, so adding a surface edits nothing here. */
export type SurfaceKind = string;

export interface Tab {
  /** Deterministic from kind + params (tabId), so opening the same thing twice finds it; a layout tab's own id once it is open. */
  id: string;
  kind: SurfaceKind;
  title: string;
  params: Readonly<Record<string, string>>;
}

/** Stable tab id: the kind plus its params sorted by name, e.g. `pullrequest?number=12`. */
export function tabId(kind: SurfaceKind, params: Readonly<Record<string, string>> = {}): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? "")}`)
    .join("&");
  return query ? `${kind}?${query}` : kind;
}

/** A seam id's kind and params (tabId's inverse); null for an id tabId does not make (a layout id parses as a kind with no params). */
export function parseTabId(id: string): { kind: SurfaceKind; params: Record<string, string> } | null {
  const q = id.indexOf("?");
  const kind = q < 0 ? id : id.slice(0, q);
  if (kind === "") return null;
  const params: Record<string, string> = {};
  if (q >= 0) {
    for (const pair of id.slice(q + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      try {
        params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  return { kind, params };
}

/**
 * A pull request tab's id: lower case, as GitHub slugs are case-insensitive, so `Octo/Hello`
 * and `octo/hello` are one tab. The tab's slug param keeps the spelling it was opened with.
 */
export function pullRequestTabId(slug: string, number: string): string {
  return tabId("pullrequest", { number, slug: slug.toLowerCase() });
}

/** A tab with its id derived from kind + params. */
export function makeTab(kind: SurfaceKind, title: string, params: Readonly<Record<string, string>> = {}): Tab {
  return { id: tabId(kind, params), kind, title, params };
}

/**
 * The target of a selection's tabs (shell/host.ts TabTarget); null for `none`. A thread's is
 * `thread:<id>` (its linked tabs); a page's and the composer's name the unlinked tabs of the
 * current space.
 */
export function selectionTarget(sel: Selection): string | null {
  switch (sel.kind) {
    case "none":
      return null;
    case "thread":
      return `thread:${sel.id}`;
    case "view":
      return sel.projectId ? `view:${sel.name}:project:${sel.projectId}` : sel.workspaceId ? `view:${sel.name}:workspace:${sel.workspaceId}` : `view:${sel.name}`;
    case "compose":
      return sel.workspaceId ? `compose:ws:${sel.workspaceId}` : sel.noProject ? "compose:home:" : `compose:${sel.projectId}`;
  }
}
