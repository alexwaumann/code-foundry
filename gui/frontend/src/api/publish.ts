import { PublishOwnerKind, RepoService, RepositoryVisibility, type PublishOwner } from "@/gen/codefoundry/v1/repo_pb";
import type { PublishOwnerView, Visibility } from "@/lib/publish";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * RepoService.ListPublishOwners for the publish picker (the Add Project dialog's New tab
 * and the publish dialog). Creating and publishing go through repo.create and
 * repo.github.publish (stores/publish.ts).
 */

const visibilities: Partial<Record<RepositoryVisibility, Visibility>> = {
  [RepositoryVisibility.PUBLIC]: "public",
  [RepositoryVisibility.INTERNAL]: "internal",
  [RepositoryVisibility.PRIVATE]: "private",
};

export function toPublishOwnerView(o: PublishOwner): PublishOwnerView {
  return {
    login: o.login,
    kind: o.kind === PublishOwnerKind.ORGANIZATION ? "org" : "user",
    allowed: o.allowed.flatMap((v) => {
      const vis = visibilities[v];
      return vis ? [vis] : [];
    }),
    known: o.known,
  };
}

export interface PublishOwnersResult {
  /** The viewer's account first, then their organizations. */
  owners: PublishOwnerView[];
  /** The list is older than the daemon's TTL (only with allowStale): ask again for a fresh one. */
  stale: boolean;
}

/**
 * The accounts the viewer can publish to. With allowStale the daemon answers its last
 * fetched list at once however old it is (stale says when it is old); otherwise a list
 * older than its TTL is fetched again first.
 */
export async function listPublishOwners(opts: { allowStale?: boolean } = {}, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<PublishOwnersResult> {
  const c = await conn.client(RepoService);
  try {
    const res = await c.listPublishOwners({ allowStale: opts.allowStale ?? false }, { signal });
    return { owners: res.owners.map(toPublishOwnerView), stale: res.stale };
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
