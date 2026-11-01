/**
 * The thread info card's reads besides the commands (daemonFakes): pull request details,
 * action picks, editor apps and placement checks, answered from `card`. Imports no store
 * and no mocked module, so vi.mock factories may import it; src/test/threadInfoWorld.ts
 * fills it.
 *
 *   vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/cardFakes")).cardGhFakes }));
 */
import type { ActionPickView, ActionView } from "@/api/actions";
import type { EditorAppView } from "@/api/gitops";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { PlacementView } from "@/api/placement";

/** What the card's reads answer, besides daemonFakes' worktree details. */
export const card = {
  prDetails: new Map<string, PullRequestView>(),
  /** projectId → the action LastRun picks for the thread. */
  picks: new Map<string, ActionView>(),
  editors: [] as EditorAppView[],
  /** projectId → the daemon's refusal of a new worktree-mode thread there. */
  refusals: new Map<string, string>(),
};

export const cardGhFakes = {
  getPullRequestDetail: (slug: string, number: number): Promise<PullRequestDetailView> => {
    const pr = card.prDetails.get(`${slug.toLowerCase()}#${String(number)}`);
    return pr ? Promise.resolve({ pullRequest: pr } as PullRequestDetailView) : Promise.reject(new Error("no such pull request"));
  },
};

export const cardActionFakes = {
  getActionPick: (projectId: string): Promise<ActionPickView | null> => {
    const action = card.picks.get(projectId);
    return Promise.resolve(action ? { source: "thread", action, last: null } : null);
  },
};

export const cardGitopsFakes = {
  listEditorApps: (): Promise<EditorAppView[]> => Promise.resolve(card.editors),
};

export const cardPlacementFakes = {
  checkPlacement: (req: { projectIds: string[]; branch: string }): Promise<PlacementView> =>
    Promise.resolve({
      branch: req.branch,
      branchNamedAtCreate: false,
      members: req.projectIds.map((projectId) => {
        const message = card.refusals.get(projectId);
        return { projectId, projectName: projectId, outcome: message ? "refused" : "share", path: "", branch: req.branch, message: message ?? "" };
      }),
    }),
};
