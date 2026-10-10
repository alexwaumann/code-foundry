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

/** The viewer's account first, then their organizations. */
export async function listPublishOwners(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<PublishOwnerView[]> {
  const c = await conn.client(RepoService);
  try {
    const res = await c.listPublishOwners({}, { signal });
    return res.owners.map(toPublishOwnerView);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
