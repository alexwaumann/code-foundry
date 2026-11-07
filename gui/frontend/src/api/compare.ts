import { create } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { DiffSourceKind, DiffSourceSchema, ProjectService, type CompareWorktreeResponse, type DiffSource, type FileVersion, type GetWorktreeCompareFileResponse, type ListCompareCommitsResponse, type ResolvedDiffSource } from "@/gen/codefoundry/v1/project_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * One side of a comparison: the merge base with the checkout's base ref (what the branch
 * changed), the files on disk, the index, or the commit a ref names.
 */
export type CompareSource = { kind: "merge-base" } | { kind: "working" } | { kind: "staged" } | { kind: "ref"; ref: string };

/** A side as the daemon resolved it. */
export interface ResolvedSourceView {
  source: CompareSource;
  /** "origin/main", "HEAD", the ref as given, "Working tree", "Staged". */
  label: string;
  sha: string;
}

/** One file of a comparison, base to head. */
export interface CompareFileView {
  path: string;
  /** A rename's or copy's source; "" otherwise. */
  oldPath: string;
  /** A git letter (A M D R C T), U unmerged, ? untracked. */
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  submodule: boolean;
}

/** ProjectService.CompareWorktree as the Diff tab shows it. */
export interface CompareView {
  /** Sorted by path, at most 10000. */
  files: CompareFileView[];
  /** More differ than `files` lists; the totals count them all. */
  truncated: boolean;
  totalFiles: number;
  totalAdded: number;
  totalDeleted: number;
  base: ResolvedSourceView;
  head: ResolvedSourceView;
  /** "origin/main"; "" without a base. */
  baseRef: string;
  /** Why a side cannot be compared (a ref deleted since); the list is then empty. */
  error: string;
  /** Files left out of the list and the totals: their names are not UTF-8. */
  skippedNames: number;
}

/** One side of a file. */
export interface CompareSideView {
  /** On this side at all (absent: an added file's old side, a deleted file's new side). */
  present: boolean;
  /** The decoded contents (UTF-8, invalid bytes as U+FFFD); "" for a binary or absent side. */
  text: string;
  /** Larger than 1 MiB: text holds its first MiB. */
  truncated: boolean;
  binary: boolean;
  submodule: boolean;
}

/** ProjectService.GetWorktreeCompareFile as the Diff tab shows it. */
export interface CompareFileSidesView {
  old: CompareSideView;
  new: CompareSideView;
  /** A, D, M, R, or "" (the sides are equal, or neither exists). */
  status: string;
  error: string;
}

/** One commit of a comparison (ProjectService.ListCompareCommits). */
export interface CompareCommitView {
  sha: string;
  shortSha: string;
  /** The first parent, which a merge compares against; "" for a root commit. */
  parent: string;
  subject: string;
  /** The message under the subject; "" without one. */
  body: string;
  authoredAtMs: number | null;
}

/** ProjectService.ListCompareCommits as the Diff tab shows it. */
export interface CompareLogView {
  /** Newest first, at most 500. */
  commits: CompareCommitView[];
  /** All of them, listed or not. */
  total: number;
  /** Why a side cannot be compared; the list is then empty. */
  error: string;
}

export interface CompareTarget {
  projectId: string;
  /** The checkout's path. */
  worktree: string;
  base: CompareSource;
  head: CompareSource;
}

const KIND_OUT: Readonly<Record<CompareSource["kind"], DiffSourceKind>> = {
  "merge-base": DiffSourceKind.MERGE_BASE,
  working: DiffSourceKind.WORKING_TREE,
  staged: DiffSourceKind.STAGED,
  ref: DiffSourceKind.REF,
};

function toSource(s: CompareSource): DiffSource {
  return create(DiffSourceSchema, { kind: KIND_OUT[s.kind], ref: s.kind === "ref" ? s.ref : "" });
}

function toResolved(r: ResolvedDiffSource | undefined, asked: CompareSource): ResolvedSourceView {
  return { source: asked, label: r?.label ?? "", sha: r?.sha ?? "" };
}

const utf8 = new TextDecoder("utf-8");

function toSide(v: FileVersion | undefined): CompareSideView {
  if (!v) return { present: false, text: "", truncated: false, binary: false, submodule: false };
  return { present: v.present, text: v.present && !v.binary ? utf8.decode(v.contents) : "", truncated: v.truncated, binary: v.binary, submodule: v.submodule };
}

export function toCompareView(r: CompareWorktreeResponse, base: CompareSource, head: CompareSource): CompareView {
  return {
    files: r.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, added: f.added, deleted: f.deleted, binary: f.binary, submodule: f.submodule })),
    truncated: r.truncated,
    totalFiles: r.totalFiles,
    totalAdded: r.totalAdded,
    totalDeleted: r.totalDeleted,
    base: toResolved(r.base, base),
    head: toResolved(r.head, head),
    baseRef: r.baseRef,
    error: r.error,
    skippedNames: r.skippedNames,
  };
}

export function toSidesView(r: GetWorktreeCompareFileResponse): CompareFileSidesView {
  return { old: toSide(r.old), new: toSide(r.new), status: r.status, error: r.error };
}

export async function compareWorktree(t: CompareTarget, paths: readonly string[], conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<CompareView> {
  const c = await conn.client(ProjectService);
  try {
    const res = await c.compareWorktree({ projectId: t.projectId, path: t.worktree, base: toSource(t.base), head: toSource(t.head), paths: [...paths] }, { signal });
    return toCompareView(res, t.base, t.head);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

export function toCompareLog(r: ListCompareCommitsResponse): CompareLogView {
  return {
    commits: r.commits.map((c) => ({ sha: c.sha, shortSha: c.shortSha, parent: c.parent, subject: c.subject, body: c.body, authoredAtMs: c.authoredAt ? timestampMs(c.authoredAt) : null })),
    total: r.total,
    error: r.error,
  };
}

export async function listCompareCommits(t: CompareTarget, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<CompareLogView> {
  const c = await conn.client(ProjectService);
  try {
    return toCompareLog(await c.listCompareCommits({ projectId: t.projectId, path: t.worktree, base: toSource(t.base), head: toSource(t.head) }, { signal }));
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

export async function getCompareFile(t: CompareTarget, file: string, oldPath: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<CompareFileSidesView> {
  const c = await conn.client(ProjectService);
  try {
    const res = await c.getWorktreeCompareFile({ projectId: t.projectId, path: t.worktree, base: toSource(t.base), head: toSource(t.head), file, oldPath }, { signal });
    return toSidesView(res);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
