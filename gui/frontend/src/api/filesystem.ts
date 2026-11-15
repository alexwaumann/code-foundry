import { Code, ConnectError } from "@connectrpc/connect";
import {
  FilesystemService,
  SkillScope,
  type ListDirectoriesResponse,
  type SearchFilesResponse,
  type Skill,
  type SuggestIncludeIgnoredResponse,
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
  projectId: string;
  /** Absolute path of the SKILL.md or command file. */
  path: string;
}

/** A checkout to read skills from: the project's main worktree unless path is set. */
export interface SkillSourceView {
  projectId: string;
  /** Absolute path of a worktree of the project. */
  path?: string;
}

/** One file or directory the composer offers after "@" (FilesystemService.SearchFiles). */
export interface FileMatchView {
  /** Relative to the checkout, "/"-separated, no trailing "/". */
  path: string;
  isDir: boolean;
  /** Git ignores it; an include pattern (the setting's or the project's) lists it anyway. Absent: false. */
  ignored?: boolean;
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
    projectId: s.projectId,
    path: s.path,
  };
}

export function toFileSearchView(res: SearchFilesResponse): FileSearchView {
  return { matches: res.matches.map((m) => ({ path: m.path, isDir: m.isDir, ignored: m.ignored })), truncated: res.truncated };
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
    const res = await c.listSkills({ sources: sources.map((s) => ({ projectId: s.projectId, path: s.path ?? "" })), includeUser }, { signal });
    return res.skills.map(toSkillView);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** What to search: a project's checkout (main worktree unless path is set) and the typed query. */
export interface FileSearchRequest {
  projectId: string;
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
    const res = await c.searchFiles({ projectId: req.projectId, path: req.path ?? "", query: req.query, limit: req.limit ?? 0 }, { signal });
    return toFileSearchView(res);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

// ---- file finder ----------------------------------------------------------------------------

/** A checkout the file finder searches (FileSource): a project's worktree, by absolute path. */
export interface FinderSourceView {
  projectId: string;
  path: string;
}

/** One file the finder offers (FileMatch from a several-source search). */
export interface FinderMatchView {
  projectId: string;
  /** The checkout `path` is relative to (the source's path as sent). */
  checkout: string;
  /** Relative to the checkout, "/"-separated. */
  path: string;
  /** Code-point indices (Array.from) of `path` the query matched, ascending. */
  pathPositions: number[];
  /** Code-point indices of the project's name that project words matched; empty when none did. */
  projectPositions: number[];
  /** Git ignores it; an include pattern lists it anyway. Absent: false. */
  ignored?: boolean;
}

/** What a finder search found. */
export interface FinderFoundView {
  /** Best match first. */
  matches: FinderMatchView[];
  /** Some checkout's included ignored files were cut at 20,000: the rest were not searched. */
  includedCapped: boolean;
}

/**
 * Searches several checkouts for files (FilesystemService.SearchFiles with sources and
 * files_only): one list ranked across them, best first. The daemon refuses a query of more
 * than 8 words (lib/fileFinder MAX_WORDS): callers do not send one.
 */
export async function findFiles(
  req: { sources: readonly FinderSourceView[]; query: string; limit?: number },
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<FinderFoundView> {
  const c = await conn.client(FilesystemService);
  try {
    const res = await c.searchFiles({ sources: req.sources.map((s) => ({ projectId: s.projectId, path: s.path })), query: req.query, limit: req.limit ?? 0, filesOnly: true }, { signal });
    return {
      matches: res.matches.map((m) => ({ projectId: m.projectId, checkout: m.checkout, path: m.path, pathPositions: [...m.pathPositions], projectPositions: [...m.projectPositions], ignored: m.ignored })),
      includedCapped: res.includedCapped,
    };
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

// ---- include patterns -----------------------------------------------------------------------

/** One git-ignored entry of a project the include field suggests (IgnoredSuggestion). */
export interface IgnoredSuggestionView {
  /** Relative to the main worktree, "/"-separated, no trailing "/". */
  path: string;
  /** A folder git ignores whole. */
  isDir: boolean;
  /** The folder's files (0 for a file); with fileCountCapped, at least this many. */
  fileCount: number;
  fileCountCapped: boolean;
  /** The effective patterns already include all of it. */
  included: boolean;
  /** Code-point indices of path the typed text matched. */
  pathPositions: number[];
}

export interface IncludeSuggestionsView {
  /** Best first. */
  suggestions: IgnoredSuggestionView[];
  /** How many files the typed text includes as a pattern on its own (0 when empty or invalid); capped: at least. */
  textFiles: number;
  textFilesCapped: boolean;
  /** Why the typed text is not a valid pattern; "" when it is (or is empty). */
  textError: string;
}

export function toIncludeSuggestionsView(res: SuggestIncludeIgnoredResponse): IncludeSuggestionsView {
  return {
    suggestions: res.suggestions.map((s) => ({ path: s.path, isDir: s.isDir, fileCount: s.fileCount, fileCountCapped: s.fileCountCapped, included: s.included, pathPositions: [...s.pathPositions] })),
    textFiles: res.textFiles,
    textFilesCapped: res.textFilesCapped,
    textError: res.textError,
  };
}

/**
 * The include field's suggestions for a project (FilesystemService.SuggestIncludeIgnored):
 * its ignored entries ranked by the typed text, and the text's own file count or error.
 * FailedPrecondition for a project without git; a daemon older than the RPC fails with
 * OutdatedDaemonError.
 */
export async function suggestIncludeIgnored(req: { projectId: string; text: string; limit?: number }, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<IncludeSuggestionsView> {
  const c = await conn.client(FilesystemService);
  try {
    return toIncludeSuggestionsView(await c.suggestIncludeIgnored({ projectId: req.projectId, text: req.text, limit: req.limit ?? 0 }, { signal }));
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
