/**
 * The Diff surface's tab (docs/notes/diff-viewer-2.md): two sources of one checkout and the
 * file being looked at. One tab per checkout: the id comes from the project and worktree
 * alone, so opening the checkout again finds its tab and openTab (stores/panel.ts) hands it
 * the new params. Pure.
 */
import type { CompareSource } from "@/api/compare";
import { tabId, type Tab } from "@/stores/panel";

export const DIFF_KIND = "diff";
export const DIFF_TITLE = "Diff";

/** What a tab compares when nothing was asked for: what the branch changed, on disk. */
export const DEFAULT_BASE: CompareSource = { kind: "merge-base" };
export const DEFAULT_HEAD: CompareSource = { kind: "working" };
/** What is committed on the branch: the old `branch` scope. */
export const COMMITTED_HEAD: CompareSource = { kind: "ref", ref: "HEAD" };

export interface DiffTarget {
  project: string;
  /** The checkout's path. */
  worktree: string;
  base: CompareSource;
  head: CompareSource;
  /** The file shown, relative to the checkout; "" until the tab has shown one, when it takes the first and keeps it. */
  file: string;
  /** A rename's source of that file; "" otherwise. */
  oldPath: string;
  /** The thread's own checkout: its title needs no project name to tell it from the others. */
  own: boolean;
  /** What the file list is filtered by. */
  filter?: string;
  /** The user folded (true) or unfolded (false) the list on top; absent leaves it to the height. */
  fold?: boolean;
}

/** A source as a tab param: "working", "staged", "merge-base", "ref:<ref>". */
export function sourceParam(s: CompareSource): string {
  return s.kind === "ref" ? `ref:${s.ref}` : s.kind;
}

/** A tab param as a source; anything else is `fallback`. */
export function sourceOfParam(v: string | undefined, fallback: CompareSource): CompareSource {
  if (v === "working" || v === "staged" || v === "merge-base") return { kind: v };
  if (v?.startsWith("ref:") && v.length > 4) return { kind: "ref", ref: v.slice(4) };
  return fallback;
}

export function sameSource(a: CompareSource, b: CompareSource): boolean {
  return sourceParam(a) === sourceParam(b);
}

/** A checkout's Diff tab: params { project, worktree, base?, head?, path?, oldPath?, own?, filter?, fold? }, defaults left out. */
export function diffTab(t: DiffTarget, title: string = DIFF_TITLE): Tab {
  const key = { project: t.project, worktree: t.worktree };
  const params: Record<string, string> = { ...key };
  if (!sameSource(t.base, DEFAULT_BASE)) params.base = sourceParam(t.base);
  if (!sameSource(t.head, DEFAULT_HEAD)) params.head = sourceParam(t.head);
  if (t.file) params.path = t.file;
  if (t.file && t.oldPath && t.oldPath !== t.file) params.oldPath = t.oldPath;
  if (t.own) params.own = "1";
  if (t.filter) params.filter = t.filter;
  if (t.fold !== undefined) params.fold = t.fold ? "1" : "0";
  return { id: tabId(DIFF_KIND, key), kind: DIFF_KIND, title, params };
}

/** What a Diff tab names; null when its params are not one. */
export function diffOfTab(tab: Pick<Tab, "params">): DiffTarget | null {
  const { project = "", worktree = "", path = "", oldPath = "" } = tab.params;
  if (!project || !worktree) return null;
  return {
    project,
    worktree,
    base: sourceOfParam(tab.params.base, DEFAULT_BASE),
    head: sourceOfParam(tab.params.head, DEFAULT_HEAD),
    file: path,
    oldPath: path ? oldPath : "",
    own: tab.params.own === "1",
    ...(tab.params.filter ? { filter: tab.params.filter } : {}),
    ...(tab.params.fold === undefined ? {} : { fold: tab.params.fold === "1" }),
  };
}
