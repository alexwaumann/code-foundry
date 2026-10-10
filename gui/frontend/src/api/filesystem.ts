import { Code, ConnectError } from "@connectrpc/connect";
import { FilesystemService, type ListDirectoriesResponse } from "@/gen/codefoundry/v1/filesystem_pb";
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
