import type { FileChangeView } from "@/api/worktreeDetail";

/**
 * One row of the worktree panel's Changes list: a changed path, flat (no folders), its
 * directory part apart from its name so the row can truncate the directory and keep the
 * name.
 */
export interface FileRow {
  /** Unique within the list: "f:<path>". */
  key: string;
  /** "gui/frontend/src/" (with its trailing slash); "" at the top level. */
  dir: string;
  /** The basename. */
  name: string;
  path: string;
  /** Git status letter (A M D R C T U) or "?" for untracked. */
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** Unmerged (status U): listed first, with a conflict tag. */
  conflict: boolean;
  /** A rename's or copy's source path; "" otherwise. */
  oldPath: string;
  /** Changed in the working tree or index (the Diff tab then opens on the working tree, else the branch). */
  uncommitted: boolean;
}

/** Splits "a/b/c.ts" into ["a/b/", "c.ts"]. Untracked directories arrive as their files. */
export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** The Changes rows: conflicted files first, then the daemon's order. */
export function buildFileRows(files: readonly FileChangeView[]): FileRow[] {
  const rows = files.map((f): FileRow => {
    const [dir, name] = splitPath(f.path);
    return { key: `f:${f.path}`, dir, name, path: f.path, status: f.status, added: f.added, deleted: f.deleted, binary: f.binary, conflict: f.status === "U", oldPath: f.oldPath, uncommitted: f.uncommitted };
  });
  // Array.prototype.sort is stable: the rest keep their order.
  return rows.sort((a, b) => Number(b.conflict) - Number(a.conflict));
}

/** Totals for the Changes header: "29 files · +24525 −0". */
export function fileTotals(files: readonly FileChangeView[]): { count: number; added: number; deleted: number } {
  return files.reduce((t, f) => ({ count: t.count + 1, added: t.added + f.added, deleted: t.deleted + f.deleted }), { count: 0, added: 0, deleted: 0 });
}

/** A git status letter's colour (the Changes rows, the Diff tab's meta). */
export const statusColor: Readonly<Record<string, string>> = {
  A: "text-success",
  M: "text-warning",
  D: "text-destructive",
  R: "text-info",
  C: "text-info",
  T: "text-info",
  U: "text-destructive",
  "?": "text-muted-foreground",
};
