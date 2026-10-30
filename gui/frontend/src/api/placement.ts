/**
 * ThreadService.CheckPlacement: where a new thread with these projects, branch and mode
 * would go, per project, before it is made (docs/notes/thread-info-facts.md). The
 * composer's Work in picker and the thread card's Run in menu read it. Generated types
 * stay here.
 */
import { PlacementOutcome, type CheckPlacementResponse, type MemberPlacement } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** new: a worktree would be made; share: an existing checkout; folder: a plain folder; refused: the create would fail (message). */
export type PlacementOutcomeView = "new" | "share" | "folder" | "refused" | "unknown";

export interface MemberPlacementView {
  projectId: string;
  projectName: string;
  outcome: PlacementOutcomeView;
  /** new: the worktree's path ("" while the branch is named at create); share: the checkout; folder: the folder. */
  path: string;
  /** The checkout's branch (HEAD); "" when detached or not known. */
  branch: string;
  /** refused: the create's error. */
  message: string;
}

export interface PlacementView {
  /** The branch a worktree-mode create would use; "" in checkout mode or when named at create. */
  branch: string;
  branchNamedAtCreate: boolean;
  /** One per project, in project id order. */
  members: MemberPlacementView[];
}

const outcomes: Record<PlacementOutcome, PlacementOutcomeView> = {
  [PlacementOutcome.UNSPECIFIED]: "unknown",
  [PlacementOutcome.NEW]: "new",
  [PlacementOutcome.SHARE]: "share",
  [PlacementOutcome.FOLDER]: "folder",
  [PlacementOutcome.REFUSED]: "refused",
};

export function toMemberPlacementView(m: MemberPlacement): MemberPlacementView {
  return { projectId: m.projectId, projectName: m.projectName, outcome: outcomes[m.outcome], path: m.path, branch: m.branch, message: m.message };
}

export function toPlacementView(r: CheckPlacementResponse): PlacementView {
  return { branch: r.branch, branchNamedAtCreate: r.branchNamedAtCreate, members: r.members.map(toMemberPlacementView) };
}

/** ThreadService.CheckPlacement (a read: nothing is made). */
export async function checkPlacement(
  req: { projectIds: string[]; branch: string; checkoutMode: boolean },
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<PlacementView> {
  const c = await conn.client(ThreadService);
  return toPlacementView(await c.checkPlacement(req, { signal }));
}
