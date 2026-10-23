/**
 * Where a File tab's missing path most likely is (docs/notes/model-paths.md). A model
 * sometimes writes a path relative to a folder it worked in (`src/a.ts` for
 * `gui/frontend/src/a.ts`) or cut short, and its chip resolves it against the thread's
 * checkout, where nothing is. When that read is not found, the tab asks the checkout's
 * file search (the composer's "@" completion) for the path's file name once, and opens the
 * one file whose checkout-relative path ends with the typed one. Pure.
 *
 * A thread's cwd is always a checkout's root (a project's worktree, a workspace member's,
 * or home for a thread without a project, which has no search), so walking up from the cwd
 * would find nothing the first read did not.
 */
import { fileName } from "./filePath";

/** A file search match: relative to the checkout, "/"-separated, no trailing "/". */
export interface SearchMatch {
  path: string;
}

/**
 * What to search the checkout for when `rel` (the missing path relative to it) is not
 * found: its file name. Null when there is nothing to look for: an empty path, or one
 * that leaves the checkout.
 */
export function fallbackQuery(rel: string): string | null {
  const r = rel.replace(/\/+$/, "");
  if (r === "" || r === "." || r.startsWith("/") || r.split("/").includes("..")) return null;
  return fileName(r) || null;
}

/**
 * The one match whose path ends with `rel` at a segment boundary ("a.ts" in "x/a.ts", not
 * in "xa.ts"), as a checkout-relative path; null when none or several do, or when the
 * search was cut short while still listing files of that name (the one it cut may be a
 * second). The search ranks an exact file name first (internal/fuzzy), so every file of
 * that name comes before any other match.
 */
export function uniqueSuffixMatch(rel: string, matches: readonly SearchMatch[], truncated: boolean): string | null {
  const r = rel.replace(/\/+$/, "");
  const name = fileName(r).toLowerCase();
  if (!name) return null;
  const last = matches[matches.length - 1];
  if (truncated && last && fileName(last.path).toLowerCase() === name) return null;
  const hits = matches.filter((m) => m.path !== r && m.path.endsWith(`/${r}`));
  return hits.length === 1 && hits[0] ? hits[0].path : null;
}
