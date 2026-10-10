import { Code, ConnectError } from "@connectrpc/connect";
import { RepoService, RepositoryVisibility, type GitHubRepository } from "@/gen/codefoundry/v1/repo_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";
import { toRepoView, type RepoView } from "./repo";

/**
 * The Add Project dialog's Local folder tab (RepoService.Register) and GitHub tab
 * (RepoService.SearchGitHub, LookupGitHub and Clone).
 */

/** A project just added: what the dialog needs to say so and open it. */
export interface AddedProjectView {
  id: string;
  name: string;
}

/**
 * Adds a folder under home as a project (RepoService.Register): a git repository adds
 * that repository, any other folder a project without git. The daemon expands "~" and
 * refuses paths outside home; errors are the daemon's ConnectError.
 */
export async function registerRepo(path: string, conn: DaemonConnection = daemon): Promise<AddedProjectView> {
  const c = await conn.client(RepoService);
  const res = await c.register({ path });
  if (!res.repo) throw new Error("the daemon did not say which project it added");
  return { id: res.repo.id, name: res.repo.name || res.repo.id };
}

export type RepoVisibility = "public" | "private" | "internal" | "";

/** A github.com repository as the dialog lists it. */
export interface GitHubRepoView {
  owner: string;
  name: string;
  /** "owner/name" as GitHub spells it. */
  slug: string;
  description: string;
  visibility: RepoVisibility;
  archived: boolean;
  fork: boolean;
  url: string;
  /** Where Clone puts it (<config home>/projects/<owner>/<name>). */
  clonePath: string;
  /** Something is there already; Clone refuses. */
  clonePathExists: boolean;
}

const visibilities: Record<RepositoryVisibility, RepoVisibility> = {
  [RepositoryVisibility.UNSPECIFIED]: "",
  [RepositoryVisibility.PUBLIC]: "public",
  [RepositoryVisibility.PRIVATE]: "private",
  [RepositoryVisibility.INTERNAL]: "internal",
};

export function toGitHubRepoView(r: GitHubRepository): GitHubRepoView {
  return {
    owner: r.owner,
    name: r.name,
    slug: `${r.owner}/${r.name}`,
    description: r.description,
    visibility: visibilities[r.visibility],
    archived: r.isArchived,
    fork: r.isFork,
    url: r.url,
    clonePath: r.clonePath,
    clonePathExists: r.clonePathExists,
  };
}

/** Searches github.com (first 20, best match first). */
export async function searchGitHub(query: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<GitHubRepoView[]> {
  const c = await conn.client(RepoService);
  try {
    const res = await c.searchGitHub({ query }, { signal });
    return res.repositories.map(toGitHubRepoView);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** One github.com repository; null when it does not exist or the viewer cannot see it. */
export async function lookupGitHub(owner: string, name: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<GitHubRepoView | null> {
  const c = await conn.client(RepoService);
  try {
    const res = await c.lookupGitHub({ owner, name }, { signal });
    return res.repository ? toGitHubRepoView(res.repository) : null;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return null;
    throw orOutdatedDaemon(err);
  }
}

/** One line of a clone's output. A transient line is replaced by the next one. */
export interface CloneProgressView {
  line: string;
  transient: boolean;
}

/**
 * Clones owner/name into the projects directory and registers it, calling onProgress
 * for every output line; resolves with the new project. Aborting the signal cancels the
 * clone (the daemon removes what it wrote).
 */
export async function cloneRepo(
  owner: string,
  name: string,
  onProgress: (p: CloneProgressView) => void,
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<RepoView> {
  const c = await conn.client(RepoService);
  try {
    let repo: RepoView | null = null;
    for await (const ev of c.clone({ owner, name }, { signal })) {
      if (ev.event.case === "progress") onProgress({ line: ev.event.value.line, transient: ev.event.value.transient });
      else if (ev.event.case === "repo") repo = toRepoView(ev.event.value);
    }
    if (!repo) throw new Error("the clone ended without a project");
    return repo;
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/** Appends a progress line to a transcript: a transient last line is replaced. */
export function appendProgress(lines: readonly CloneProgressView[], p: CloneProgressView, max = 200): CloneProgressView[] {
  const last = lines.at(-1);
  const next = last?.transient ? [...lines.slice(0, -1), p] : [...lines, p];
  return next.length > max ? next.slice(next.length - max) : next;
}
