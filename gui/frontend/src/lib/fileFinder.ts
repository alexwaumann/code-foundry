/**
 * The file finder's rows (file.find, cmd+P; docs/notes/file-finder-2-gui.md). Pure: what
 * the query asks for, how a match's name and project name split into bold and plain runs
 * from the daemon's positions, and the empty query's two groups (Changed in this thread,
 * Recently opened). components/palette/FileFinder.tsx renders them.
 */
import type { FinderMatchView } from "@/api/filesystem";
import type { FileChangeView } from "@/api/worktreeDetail";
import { normalizePath, relativeTo } from "./filePath";

/** internal/fuzzy MaxWords: the daemon refuses a longer query. */
export const MAX_WORDS = 8;

/** Go's unicode.IsSpace, which the daemon splits words at (as the mock does). */
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** The query's words as the daemon counts them. */
export function queryWords(query: string): string[] {
  return query.split(SPACE).filter((w) => w !== "");
}

/** What a typed query asks for: the words to search, and a line to open at (`name:42`). */
export interface FinderQuery {
  /** The text sent to SearchFiles ("" for the empty state). */
  query: string;
  /** 1-based line from a trailing `:<line>`; absent without one. */
  line?: number;
  /** More than MAX_WORDS words: nothing is sent. */
  tooMany: boolean;
}

/**
 * Splits a trailing `:<digits>` off the typed text (`Composer.tsx:42` searches
 * `Composer.tsx` and opens at line 42; `Composer.tsx:` while typing the number searches
 * the name). The rest is trimmed. A colon inside the text stays part of the query.
 */
export function parseFinderQuery(raw: string): FinderQuery {
  const text = raw.trim();
  const m = /^(.*\S):(\d*)$/s.exec(text);
  const query = m ? (m[1] ?? "").trim() : text;
  const n = m?.[2] ? Number(m[2]) : 0;
  const line = Number.isSafeInteger(n) && n > 0 ? n : undefined;
  return { query, ...(line === undefined ? {} : { line }), tooMany: queryWords(query).length > MAX_WORDS };
}

/** A run of text, bold when the query matched it. */
export interface Run {
  text: string;
  hit: boolean;
}

/**
 * Splits text into runs at the matched code points: `positions` are code-point indices
 * (Array.from), shifted by `offset` (a base name's positions within its whole path).
 * Out-of-range positions are ignored.
 */
export function highlightRuns(text: string, positions: readonly number[], offset = 0): Run[] {
  const chars = Array.from(text);
  const hits = new Set(positions.map((p) => p - offset));
  const out: Run[] = [];
  chars.forEach((ch, i) => {
    const hit = hits.has(i);
    const last = out.at(-1);
    if (last?.hit === hit) last.text += ch;
    else out.push({ text: ch, hit });
  });
  return out;
}

/** A relative path's directory ("gui/src/lib", no trailing slash; "" at the top) and its name's runs. */
export function splitMatchPath(path: string, positions: readonly number[]): { dir: string; name: Run[] } {
  const chars = Array.from(path);
  const slash = chars.lastIndexOf("/");
  return { dir: chars.slice(0, Math.max(slash, 0)).join(""), name: highlightRuns(chars.slice(slash + 1).join(""), positions, slash + 1) };
}

/** One row: a file in one of the thread's checkouts. */
export interface FinderRow {
  /** Unique in the list: the file's absolute path (the File tab's key too). */
  key: string;
  projectId: string;
  /** Absolute path of the checkout `path` is relative to. */
  checkout: string;
  /** Relative to the checkout, "/"-separated. */
  path: string;
  name: Run[];
  /** The directory, dimmed and cut from the left by the row; "" at the top. */
  dir: string;
  /** The project's name with the project words' letters bold; null in a one-project thread. */
  project: Run[] | null;
  /** Git status letter (M A R …) when the file has changes in the thread; "" otherwise. */
  status: string;
  /** The panel already has a File tab for it. */
  open: boolean;
}

/** One checkout of the thread, as the finder searches and lists it. */
export interface FinderCheckout {
  projectId: string;
  /** Absolute path. */
  path: string;
}

/** What the rows are decorated from. */
export interface RowContext {
  /** Project names by id. */
  names: Readonly<Record<string, string>>;
  /** The thread has two or more projects: rows carry the project label. */
  multi: boolean;
  /** Absolute paths of the panel's File tabs (normalized). */
  openPaths: ReadonlySet<string>;
  /** Status letters by statusKey(checkout, path). */
  statuses: ReadonlyMap<string, string>;
}

/** A status key: the checkout and the relative path. */
export function statusKey(checkout: string, path: string): string {
  return `${checkout}\u0000${path}`;
}

/** The absolute path of a checkout's relative path, as a File tab names it. */
export function absolutePath(checkout: string, path: string): string {
  return normalizePath(`${checkout}/${path}`);
}

function row(ctx: RowContext, f: { projectId: string; checkout: string; path: string; pathPositions?: readonly number[]; projectPositions?: readonly number[] }, status?: string): FinderRow {
  const { dir, name } = splitMatchPath(f.path, f.pathPositions ?? []);
  const projectName = ctx.names[f.projectId] ?? f.projectId;
  return {
    key: absolutePath(f.checkout, f.path),
    projectId: f.projectId,
    checkout: f.checkout,
    path: f.path,
    name,
    dir,
    project: ctx.multi ? highlightRuns(projectName, f.projectPositions ?? []) : null,
    status: status ?? ctx.statuses.get(statusKey(f.checkout, f.path)) ?? "",
    open: ctx.openPaths.has(absolutePath(f.checkout, f.path)),
  };
}

/**
 * A typed query's rows: the daemon's order, one flat list across the projects. A file
 * found twice (a checkout nested in another) is listed once, where it ranked first.
 */
export function searchRows(matches: readonly FinderMatchView[], ctx: RowContext): FinderRow[] {
  const seen = new Set<string>();
  return matches.flatMap((m) => {
    const r = row(ctx, m);
    if (seen.has(r.key)) return [];
    seen.add(r.key);
    return [r];
  });
}

/** One checkout's changes (the Changes tab's worktree detail). */
export interface CheckoutChanges extends FinderCheckout {
  files: readonly Pick<FileChangeView, "path" | "status">[];
}

/** A file a panel showed in a File tab (stores/recentFiles.ts), most recent first. */
export interface RecentFileRef {
  /** Absolute path, as the File tab names it. */
  path: string;
}

/** A list's group: the empty query's two (a group without rows is left out), or a query's results (no heading). */
export interface FinderGroup {
  key: "changed" | "recent" | "results";
  heading: string;
  rows: FinderRow[];
}

/** How many recently opened files the empty state lists. */
export const RECENT_SHOWN = 8;

/**
 * The status letters of the checkouts' changes (deleted files included: a search may
 * still find one the index lists), keyed by statusKey.
 */
export function changeStatuses(changes: readonly CheckoutChanges[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of changes) for (const f of c.files) out.set(statusKey(c.path, f.path), f.status);
  return out;
}

/**
 * The empty query's groups. "Changed in this thread": the files changed in the thread's
 * checkouts (uncommitted and against the merge base, as the Changes tab lists them), in
 * checkout order, deleted ones left out (nothing to open). "Recently opened": the panel's
 * File tabs, most recent first, those inside one of the thread's checkouts (the most
 * specific one, so a nested checkout wins) and not listed under Changed, at most
 * RECENT_SHOWN.
 */
export function emptyGroups(changes: readonly CheckoutChanges[], recent: readonly RecentFileRef[], checkouts: readonly FinderCheckout[], ctx: RowContext): FinderGroup[] {
  const changed: FinderRow[] = [];
  const listed = new Set<string>();
  for (const c of changes) {
    for (const f of c.files) {
      if (f.status === "D") continue;
      const abs = absolutePath(c.path, f.path);
      if (listed.has(abs)) continue;
      listed.add(abs);
      changed.push(row(ctx, { projectId: c.projectId, checkout: c.path, path: f.path }, f.status));
    }
  }
  const byDepth = [...checkouts].sort((a, b) => b.path.length - a.path.length);
  const recentRows: FinderRow[] = [];
  for (const r of recent) {
    if (recentRows.length >= RECENT_SHOWN) break;
    const abs = normalizePath(r.path);
    if (listed.has(abs)) continue;
    for (const c of byDepth) {
      const rel = relativeTo(abs, c.path);
      if (rel === null) continue;
      listed.add(abs);
      recentRows.push(row(ctx, { projectId: c.projectId, checkout: c.path, path: rel }));
      break;
    }
  }
  const groups: FinderGroup[] = [];
  if (changed.length > 0) groups.push({ key: "changed", heading: "Changed in this thread", rows: changed });
  if (recentRows.length > 0) groups.push({ key: "recent", heading: "Recently opened", rows: recentRows });
  return groups;
}
