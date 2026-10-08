import type { GitStatusView } from "@/api/repo";
import type { FileChangeView } from "@/api/worktreeDetail";

/** One row of the Files tree: a directory (aggregated) or a changed path. */
export interface FileRow {
  kind: "dir" | "file";
  /** Unique within the list: "d:<dir path>" or "f:<file path>". */
  key: string;
  depth: number;
  /** Display name: the basename, or a compressed directory chain ("internal/store/gh"). */
  name: string;
  /** Full path ("dir/" paths end in a slash). */
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** Git status letter for files; the distinct letters inside for directories ("AM"). */
  status: string;
  uncommitted: boolean;
  /** Directories: files beneath and whether shown expanded. */
  count: number;
  expanded: boolean;
  file?: FileChangeView;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: FileChangeView[];
}

/** Directories start expanded when the list is short; long lists start collapsed. */
export const EXPAND_ALL_UNDER = 40;

function newDir(name: string, path: string): Dir {
  return { name, path, dirs: new Map(), files: [] };
}

function insert(root: Dir, f: FileChangeView): void {
  // An untracked directory entry ("scratch/") is a leaf, not a folder to open.
  const parts = f.path.replace(/\/$/, "").split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) {
    const path = d.path ? `${d.path}/${p}` : p;
    let next = d.dirs.get(p);
    if (!next) {
      next = newDir(p, path);
      d.dirs.set(p, next);
    }
    d = next;
  }
  d.files.push(f);
}

/** Merges single-child directory chains: a/b/c with nothing else in a or b is one row. */
function compress(d: Dir): Dir {
  let cur = d;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const only = [...cur.dirs.values()][0];
    if (!only) break;
    cur = { ...only, name: `${cur.name}/${only.name}` };
  }
  return { ...cur, dirs: new Map([...cur.dirs].map(([k, v]) => [k, compress(v)])) };
}

function totals(d: Dir): { added: number; deleted: number; count: number; binary: boolean; letters: Set<string>; uncommitted: boolean } {
  const t = { added: 0, deleted: 0, count: 0, binary: false, letters: new Set<string>(), uncommitted: false };
  for (const f of d.files) {
    t.added += f.added;
    t.deleted += f.deleted;
    t.count++;
    t.binary ||= f.binary;
    t.uncommitted ||= f.uncommitted;
    t.letters.add(f.status);
  }
  for (const sub of d.dirs.values()) {
    const s = totals(sub);
    t.added += s.added;
    t.deleted += s.deleted;
    t.count += s.count;
    t.binary ||= s.binary;
    t.uncommitted ||= s.uncommitted;
    for (const l of s.letters) t.letters.add(l);
  }
  return t;
}

const letterOrder = "UMARCTD?";

/**
 * Flattens changed files into tree rows: directories first (sorted), then files, each
 * directory with aggregated +/- and file count. `overrides` holds explicit
 * expand/collapse choices by directory path; otherwise directories are expanded when
 * there are fewer than EXPAND_ALL_UNDER files.
 */
export function buildFileRows(files: readonly FileChangeView[], overrides: Readonly<Record<string, boolean>>): FileRow[] {
  const root = newDir("", "");
  for (const f of files) insert(root, f);
  // The root is never folded; each top-level directory chain is.
  const start: Dir = { ...root, dirs: new Map([...root.dirs].map(([k, v]) => [k, compress(v)])) };
  const defaultOpen = files.length < EXPAND_ALL_UNDER;
  const rows: FileRow[] = [];
  const walk = (d: Dir, depth: number) => {
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const t = totals(sub);
      const expanded = overrides[sub.path] ?? defaultOpen;
      rows.push({
        kind: "dir",
        key: `d:${sub.path}`,
        depth,
        name: sub.name,
        path: sub.path,
        added: t.added,
        deleted: t.deleted,
        binary: t.binary,
        status: [...t.letters].sort((a, b) => letterOrder.indexOf(a) - letterOrder.indexOf(b)).join(""),
        uncommitted: t.uncommitted,
        count: t.count,
        expanded,
      });
      if (expanded) walk(sub, depth + 1);
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const base = f.path.replace(/\/$/, "").split("/").pop() ?? f.path;
      rows.push({
        kind: "file",
        key: `f:${f.path}`,
        depth,
        name: f.isDir ? `${base}/` : base,
        path: f.path,
        added: f.added,
        deleted: f.deleted,
        binary: f.binary,
        status: f.status,
        uncommitted: f.uncommitted,
        count: 1,
        expanded: false,
        file: f,
      });
    }
  };
  walk(start, 0);
  return rows;
}

/** Totals for the Files header: "29 files, +24525 −0". */
export function fileTotals(files: readonly FileChangeView[]): { count: number; added: number; deleted: number } {
  return files.reduce((t, f) => ({ count: t.count + 1, added: t.added + f.added, deleted: t.deleted + f.deleted }), { count: 0, added: 0, deleted: 0 });
}

/** "2 staged · 4 modified · 1 new", omitting zero counts; "clean" when nothing changed. */
export function describeChanges(st: Pick<GitStatusView, "staged" | "modified" | "untracked" | "dirty">): string {
  const parts = [
    st.staged > 0 && `${String(st.staged)} staged`,
    st.modified > 0 && `${String(st.modified)} modified`,
    st.untracked > 0 && `${String(st.untracked)} new`,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return st.dirty ? "dirty" : "clean";
}
