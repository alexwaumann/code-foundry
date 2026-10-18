/**
 * The File and Diff surfaces' tabs (docs/notes/file-viewer-3-tabs.md). One tab per file:
 * a tab's id comes from the params that name the file, not from the rest (the line to show,
 * the diff's scope), so opening the same file again finds its tab and openTab
 * (stores/panel.ts) hands it the new params. Pure.
 */
import { tabId, type Tab } from "@/stores/panel";
import type { DiffScopeView } from "@/api/fileDiff";
import { fileName, resolvePath } from "@/lib/filePath";

export const FILE_KIND = "files";
export const DIFF_KIND = "diff";

/** A file to show: absolute, "~/…", or relative to `base`. */
export interface FileTarget {
  /** The project it belongs to; "" for a thread without one. */
  project: string;
  /** Absolute directory a relative path is read against: the thread's checkout, or home. */
  base: string;
  path: string;
  /** 1-based line to scroll to and mark; absent for none. */
  line?: number;
}

/**
 * A File tab: params { project, base, path, line? } with the path made absolute against
 * base when it can be, keyed by that path alone, titled with the file's name.
 */
export function fileTab(t: FileTarget): Tab {
  const path = resolvePath(t.base, t.path);
  const params: Record<string, string> = { project: t.project, base: t.base, path };
  if (t.line !== undefined && t.line > 0) params.line = String(Math.floor(t.line));
  return { id: tabId(FILE_KIND, { path }), kind: FILE_KIND, title: fileName(path) || path, params };
}

/** The file a File tab names; null when its params are not one. */
export function fileOfTab(tab: Pick<Tab, "params">): FileTarget | null {
  const path = tab.params.path ?? "";
  if (!path) return null;
  const line = Number(tab.params.line ?? "");
  return { project: tab.params.project ?? "", base: tab.params.base ?? "", path, ...(Number.isInteger(line) && line > 0 ? { line } : {}) };
}

/** One changed file of a worktree to diff. */
export interface DiffTarget {
  project: string;
  /** The worktree's path. */
  worktree: string;
  /** Worktree-relative path of the new side. */
  path: string;
  /** Worktree-relative path of a rename's or copy's source; "" otherwise. */
  oldPath: string;
  scope: DiffScopeView;
}

/** A Diff tab: params { project, worktree, path, oldPath?, scope }, keyed by project, worktree and path. */
export function diffTab(t: DiffTarget): Tab {
  const key = { project: t.project, worktree: t.worktree, path: t.path };
  const params: Record<string, string> = { ...key, scope: t.scope };
  if (t.oldPath && t.oldPath !== t.path) params.oldPath = t.oldPath;
  return { id: tabId(DIFF_KIND, key), kind: DIFF_KIND, title: fileName(t.path) || t.path, params };
}

/** The file a Diff tab names; null when its params are not one. */
export function diffOfTab(tab: Pick<Tab, "params">): DiffTarget | null {
  const { project = "", worktree = "", path = "" } = tab.params;
  if (!project || !worktree || !path) return null;
  return { project, worktree, path, oldPath: tab.params.oldPath ?? "", scope: tab.params.scope === "branch" ? "branch" : "working" };
}
