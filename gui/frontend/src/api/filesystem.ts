import { Code, ConnectError } from "@connectrpc/connect";
import {
  FilesystemService,
  SkillScope,
  type ListDirectoriesResponse,
  type SearchFilesResponse,
  type Skill,
} from "@/gen/codefoundry/v1/filesystem_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/** One directory a typed path can complete to (FilesystemService.ListDirectories). */
export interface DirectoryEntryView {
  /** Absolute path, "~" expanded. */
  path: string;
  name: string;
  /** The directory has a .git entry (a repository or a worktree). */
  isGit: boolean;
  /** Already a project (or one of its worktrees). */
  registered: boolean;
}

export interface DirectoryListingView {
  entries: DirectoryEntryView[];
  /** The longest extension of the prefix every entry shares, in the prefix's spelling. */
  completion: string;
  /** More directories matched than were returned. */
  truncated: boolean;
}

export function toDirectoryListingView(res: ListDirectoriesResponse): DirectoryListingView {
  return {
    entries: res.entries.map((e) => ({ path: e.path, name: e.name, isGit: e.isGit, registered: e.registered })),
    completion: res.completion,
    truncated: res.truncated,
  };
}

/** A prefix the daemon refuses (outside home, relative, ~user): the message is for the user. */
export class PathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRejectedError";
  }
}

/**
 * Completes a typed path prefix to directories under home. A refused prefix fails with
 * PathRejectedError; a daemon older than the RPC with OutdatedDaemonError.
 */
export async function listDirectories(prefix: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<DirectoryListingView> {
  const c = await conn.client(FilesystemService);
  try {
    return toDirectoryListingView(await c.listDirectories({ prefix }, { signal }));
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.InvalidArgument) throw new PathRejectedError(err.rawMessage.replace(/^invalid argument: /, ""));
    throw orOutdatedDaemon(err);
  }
}

// ---- composer completion ------------------------------------------------------------------

/** One skill or slash command the composer offers after "/" (FilesystemService.ListSkills). */
export interface SkillView {
  /** What follows "/". */
  name: string;
  /** May be empty. */
  description: string;
  /** "user": ~/.claude; "project": a checkout's .claude. */
  scope: "user" | "project";
  /** The project, for project scope; "" for user scope. */
  repoId: string;
  /** Absolute path of the SKILL.md or command file. */
  path: string;
}

/** A checkout to read skills from: the project's main worktree unless path is set. */
export interface SkillSourceView {
  repoId: string;
  /** Absolute path of a worktree of the project. */
  path?: string;
}

/** One file or directory the composer offers after "@" (FilesystemService.SearchFiles). */
export interface FileMatchView {
  /** Relative to the checkout, "/"-separated, no trailing "/". */
  path: string;
  isDir: boolean;
}

export interface FileSearchView {
  /** Best match first. */
  matches: FileMatchView[];
  /** More entries matched than were returned. */
  truncated: boolean;
}

export function toSkillView(s: Skill): SkillView {
  return {
    name: s.name,
    description: s.description,
    scope: s.scope === SkillScope.USER ? "user" : "project",
    repoId: s.repoId,
    path: s.path,
  };
}

export function toFileSearchView(res: SearchFilesResponse): FileSearchView {
  return { matches: res.matches.map((m) => ({ path: m.path, isDir: m.isDir })), truncated: res.truncated };
}

/**
 * Lists the skills of each source checkout (in order), then the user's when includeUser.
 * A daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function listSkills(
  sources: readonly SkillSourceView[],
  includeUser: boolean,
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<SkillView[]> {
  const c = await conn.client(FilesystemService);
  try {
    const res = await c.listSkills({ sources: sources.map((s) => ({ repoId: s.repoId, path: s.path ?? "" })), includeUser }, { signal });
    return res.skills.map(toSkillView);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** What to search: a project's checkout (main worktree unless path is set) and the typed query. */
export interface FileSearchRequest {
  repoId: string;
  /** Absolute path of a worktree of the project. */
  path?: string;
  query: string;
  /** Default 50, at most 200. */
  limit?: number;
}

/**
 * Fuzzy-matches a query against a checkout's files and directories. A daemon older than
 * the RPC fails with OutdatedDaemonError.
 */
export async function searchFiles(req: FileSearchRequest, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FileSearchView> {
  const c = await conn.client(FilesystemService);
  try {
    const res = await c.searchFiles({ repoId: req.repoId, path: req.path ?? "", query: req.query, limit: req.limit ?? 0 }, { signal });
    return toFileSearchView(res);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
