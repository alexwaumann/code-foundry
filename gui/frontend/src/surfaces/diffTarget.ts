/**
 * The Diff surface's tab (docs/notes/diff-viewer-2.md): two sources of one checkout and the
 * file being looked at. One tab per checkout: the id comes from the project and worktree
 * alone, so opening the checkout again finds its tab and openTab (shell/host.ts) hands it
 * the new params. That tab is the user's. Whatever a thread frames (a title, a note, a
 * narrowed list, hidden controls) goes in a tab with the thread in its id, and with the title
 * when it gave one, so a thread never takes over the user's tab: the same title updates the
 * same tab, as the next untitled call does the thread's untitled one. Pure.
 */
import type { CompareSource } from "@/api/compare";
import { tabId, type Tab } from "@/shell/host";

export const DIFF_KIND = "diff";
export const DIFF_TITLE = "Diff";
/** What a thread's tab with no title of its own says before the comparison's name: it is not the user's. */
export const FROM_THREAD = "From thread";

/** What a tab compares when nothing was asked for: what the branch changed, on disk. */
export const DEFAULT_BASE: CompareSource = { kind: "merge-base" };
export const DEFAULT_HEAD: CompareSource = { kind: "working" };
/** What is committed on the branch: the old `branch` scope. */
export const COMMITTED_HEAD: CompareSource = { kind: "ref", ref: "HEAD" };

/** git's empty tree: what a root commit is compared against. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** One commit shown from the Commits list, and what All changes goes back to. */
export interface DiffCommit {
  sha: string;
  base: CompareSource;
  head: CompareSource;
  file: string;
  oldPath: string;
}

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
  /** The list is narrowed to these files and directories (relative to the checkout); empty for every file. */
  paths?: readonly string[];
  /** The thread that framed this tab, which makes it a tab of its own; absent on the checkout's own. */
  thread?: string;
  /** A thread's name for the tab (plain text); absent for the tab's own "<head> vs <base>". */
  heading?: string;
  /** A thread's line about it (plain text). */
  note?: string;
  /** What a thread took away, which the user can bring back. */
  hide?: readonly DiffPart[];
  /** The two sides are one commit and its parent, from the Commits list. */
  commit?: DiffCommit;
  /** The Commits section is open. */
  commitsOpen?: boolean;
}

/** The parts of the tab a thread can hide (view.panel.diff --hide). */
export type DiffPart = "compare" | "files";

const PARTS: readonly string[] = ["compare", "files"] satisfies DiffPart[];

const isPart = (v: string): v is DiffPart => PARTS.includes(v);

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

/** A checkout's Diff tab: params { project, worktree, thread?, base?, head?, path?, oldPath?, own?, filter?, fold?, paths?, title?, note?, hide?, commit?, backBase?, backHead?, backPath?, backOldPath?, commits? }, defaults left out. */
export function diffTab(t: DiffTarget, title: string = t.heading || (t.thread ? FROM_THREAD : DIFF_TITLE)): Tab {
  const key = { project: t.project, worktree: t.worktree, ...(t.thread ? { thread: t.thread } : {}), ...(t.heading ? { title: t.heading } : {}) };
  const params: Record<string, string> = { ...key };
  if (!sameSource(t.base, DEFAULT_BASE)) params.base = sourceParam(t.base);
  if (!sameSource(t.head, DEFAULT_HEAD)) params.head = sourceParam(t.head);
  if (t.file) params.path = t.file;
  if (t.file && t.oldPath && t.oldPath !== t.file) params.oldPath = t.oldPath;
  if (t.own) params.own = "1";
  if (t.filter) params.filter = t.filter;
  if (t.fold !== undefined) params.fold = t.fold ? "1" : "0";
  if (t.paths?.length) params.paths = t.paths.join("\n");
  if (t.note) params.note = t.note;
  if (t.hide?.length) params.hide = t.hide.join(",");
  if (t.commit) {
    params.commit = t.commit.sha;
    params.backBase = sourceParam(t.commit.base);
    params.backHead = sourceParam(t.commit.head);
    if (t.commit.file) params.backPath = t.commit.file;
    if (t.commit.oldPath) params.backOldPath = t.commit.oldPath;
  }
  if (t.commitsOpen) params.commits = "1";
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
    paths: tab.params.paths ? tab.params.paths.split("\n") : [],
    thread: tab.params.thread ?? "",
    heading: tab.params.title ?? "",
    note: tab.params.note ?? "",
    hide: (tab.params.hide ?? "").split(",").filter(isPart),
    ...(tab.params.commit
      ? {
          commit: {
            sha: tab.params.commit,
            base: sourceOfParam(tab.params.backBase, DEFAULT_BASE),
            head: sourceOfParam(tab.params.backHead, DEFAULT_HEAD),
            file: tab.params.backPath ?? "",
            oldPath: tab.params.backOldPath ?? "",
          },
        }
      : {}),
    ...(tab.params.commits === "1" ? { commitsOpen: true } : {}),
  };
}
