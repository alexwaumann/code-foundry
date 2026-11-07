import type { CompareFileView, CompareSource, CompareView } from "@/api/compare";
import { REFRESH_DEBOUNCE_MS } from "@/components/files/useTabRead";

/** The most a live update waits: the list stays live on any repository. */
const LIST_PACE_MAX = 3000;

/** One row of the file list: a changed path, its directory apart from its name so the row can cut the directory and keep the name. */
export interface FileRow {
  /** Unique within the list: "f:<path>". */
  key: string;
  /** "gui/frontend/src/" (with its trailing slash); "" at the top level. */
  dir: string;
  /** The basename. */
  name: string;
  path: string;
  /** A git letter (A M D R C T U), or "?" for untracked. */
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  submodule: boolean;
  /** Unmerged (status U): listed first, with a conflict tag. */
  conflict: boolean;
  /** A rename's or copy's source; "" otherwise. */
  oldPath: string;
}

/** Splits "a/b/c.ts" into ["a/b/", "c.ts"]. An embedded repository, the one directory listed, keeps its slash: "a/lib/" is ["a/", "lib/"]. */
export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/", path.length - 2);
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** The list's rows: conflicted files first, then the daemon's order. */
export function buildFileRows(files: readonly CompareFileView[]): FileRow[] {
  const rows = files.map((f): FileRow => {
    const [dir, name] = splitPath(f.path);
    return { key: `f:${f.path}`, dir, name, path: f.path, status: f.status, added: f.added, deleted: f.deleted, binary: f.binary, submodule: f.submodule, conflict: f.status === "U", oldPath: f.oldPath };
  });
  // Array.prototype.sort is stable: the rest keep their order.
  return rows.sort((a, b) => Number(b.conflict) - Number(a.conflict));
}

/** Totals over a file list: "29 files · +24525 −0". */
export function fileTotals(files: readonly { added: number; deleted: number }[]): { count: number; added: number; deleted: number } {
  const t = { count: 0, added: 0, deleted: 0 };
  for (const f of files) {
    t.count += 1;
    t.added += f.added;
    t.deleted += f.deleted;
  }
  return t;
}

/** The rows whose path (or a rename's source) holds `query`, case aside; all of them without one. */
export function filterRows(rows: readonly FileRow[], query: string): readonly FileRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.path.toLowerCase().includes(q) || r.oldPath.toLowerCase().includes(q));
}

/** A row for a file that is not in the list, which `status ""` says. */
function unlistedRow(path: string, oldPath: string): FileRow {
  const [dir, name] = splitPath(path);
  return { key: `f:${path}`, dir, name, path, status: "", added: 0, deleted: 0, binary: false, submodule: false, conflict: false, oldPath };
}

/**
 * The row to show: the tab's file, whether or not it is still listed, as the file being read
 * stays until the reader moves; the first only while the tab has none.
 */
export function pickRow(rows: readonly FileRow[], file: string, oldPath = ""): FileRow | null {
  if (!file) return rows[0] ?? null;
  return rows.find((r) => r.path === file) ?? unlistedRow(file, oldPath);
}

/** What a side is called before the comparison has answered, or when it could not: never another side's failure. */
export function sourceLabel(s: CompareSource, mergeBase: string): string {
  if (s.kind === "ref") return s.ref;
  if (s.kind === "working") return "Working tree";
  return s.kind === "staged" ? "Staged" : mergeBase;
}

/** Heights the list on top is fitted to: the compare bar, the list's totals, its filter, the file's header. */
const BAR_H = 44;
const TOTALS_H = 36;
const FILTER_H = 32;
const FILE_HEADER_H = 48;
/** The list on top leaves the code at least this: about nine lines. */
export const CODE_MIN = 180;
/** The list on top shows at most this many rows, then scrolls inside itself. */
export const TOP_ROWS = 5;
/** Fewer rows than this are not worth the code's room: the list folds instead. */
const TOP_ROWS_MIN = 2;

/**
 * How the list on top shares a panel `height` tall with the code: as many rows as leave it
 * CODE_MIN, and folded when that is too few to be a list. Folded by hand or not, an open list
 * has the minimum, so opening one always shows it.
 */
export function topListFit(height: number, rowHeight: number, files: number, filter: boolean): { rows: number; fold: boolean } {
  const spare = height - BAR_H - TOTALS_H - FILE_HEADER_H - CODE_MIN - (filter ? FILTER_H : 0);
  const rows = Math.min(TOP_ROWS, Math.floor(spare / rowHeight));
  return { rows: Math.max(rows, TOP_ROWS_MIN), fold: rows < Math.min(files, TOP_ROWS_MIN) };
}

/** The row `by` steps from `from` in `rows`, stopping at the ends; null when there is nowhere to go. */
export function stepRow(rows: readonly FileRow[], from: FileRow | null, by: 1 | -1): FileRow | null {
  const i = from ? rows.findIndex((r) => r.key === from.key) : -1;
  const next = rows[i < 0 ? 0 : i + by];
  return next && next.key !== from?.key ? next : null;
}

/**
 * How long a live update waits for more, after a list read took `tookMs`: twice that, in steps
 * so a read's small changes re-render nothing. A read costs what git costs, a large repository's
 * half a second, so it may not take more than about a third of the time however much is going on.
 */
export function listPace(tookMs: number): number {
  return Math.min(LIST_PACE_MAX, Math.max(REFRESH_DEBOUNCE_MS, Math.ceil((tookMs * 2) / REFRESH_DEBOUNCE_MS) * REFRESH_DEBOUNCE_MS));
}

/** A git status letter's colour. */
export const statusColor: Readonly<Record<string, string>> = {
  A: "text-cf-diff-addition",
  M: "text-cf-diff-modified",
  D: "text-cf-diff-deletion",
  R: "text-cf-info-text",
  C: "text-cf-info-text",
  T: "text-cf-info-text",
  U: "text-cf-error-text",
  "?": "text-cf-text-muted",
};

/**
 * A remote-tracking ref without its remote: "origin/main" → "main" when "origin" is one
 * of the project's remotes; anything else (a local base, "main") as it is.
 */
export function shortRef(ref: string, remotes: readonly string[]): string {
  const slash = ref.indexOf("/");
  if (slash > 0 && remotes.includes(ref.slice(0, slash))) return ref.slice(slash + 1);
  return ref;
}

/** What the tab's strip calls it: "feat/sidebar vs main", and with another project's name first, so a thread's checkouts stay apart. */
export function diffTitle(view: Pick<CompareView, "base" | "head">, o: { branch: string; remotes: readonly string[]; project: string; own: boolean }): string {
  const head = view.head.source.kind === "working" && o.branch ? o.branch : shortRef(view.head.label, o.remotes);
  const short = shortRef(view.base.label, o.remotes);
  // On the default branch the two would read the same: "main vs origin/main".
  const title = `${head} vs ${short === head ? view.base.label : short}`;
  return o.own ? title : `${o.project} · ${title}`;
}
