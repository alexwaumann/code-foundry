import type { CompareFileView, CompareView } from "@/api/compare";

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

/** Splits "a/b/c.ts" into ["a/b/", "c.ts"]. Untracked directories arrive as their files. */
export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/");
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

/** The row to show: the tab's file while it is listed, else the first. */
export function pickRow(rows: readonly FileRow[], file: string): FileRow | null {
  return rows.find((r) => r.path === file) ?? rows[0] ?? null;
}

/** The row `by` steps from `from` in `rows`, stopping at the ends; null when there is nowhere to go. */
export function stepRow(rows: readonly FileRow[], from: FileRow | null, by: 1 | -1): FileRow | null {
  const i = from ? rows.findIndex((r) => r.key === from.key) : -1;
  const next = rows[i < 0 ? 0 : i + by];
  return next && next.key !== from?.key ? next : null;
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
  const title = `${head} vs ${shortRef(view.base.label, o.remotes)}`;
  return o.own ? title : `${o.project} · ${title}`;
}
