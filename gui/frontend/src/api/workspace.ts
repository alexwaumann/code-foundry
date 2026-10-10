import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { Workspace, WorkspaceEvent } from "@/gen/codefoundry/v1/workspace_pb";

/** A member of a workspace: a repository and its worktree on the workspace branch. */
export interface WorkspaceMemberView {
  repoId: string;
  worktreePath: string;
}

/**
 * View model for a workspace: one branch checked out as a worktree in several
 * repositories (docs/notes/workspaces-1-store.md). Generated types stay inside src/api.
 */
export interface WorkspaceView {
  /** "w-" + 12 hex digits. */
  id: string;
  /** Unique display name. */
  name: string;
  /** The branch every member worktree was created on. */
  branch: string;
  /** In the order they were added. */
  members: WorkspaceMemberView[];
  createdAtMs: number | null;
}

export type WorkspaceEventView =
  | { kind: "snapshot"; workspaces: WorkspaceView[] }
  | { kind: "updated"; workspace: WorkspaceView }
  | { kind: "removed"; id: string };

export function toWorkspaceView(w: Workspace): WorkspaceView {
  return {
    id: w.id,
    name: w.name,
    branch: w.branch,
    members: w.members.map((m) => ({ repoId: m.repoId, worktreePath: m.worktreePath })),
    createdAtMs: w.createdAt ? timestampMs(w.createdAt) : null,
  };
}

export function toWorkspaceEventView(ev: WorkspaceEvent): WorkspaceEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", workspaces: e.value.workspaces.map(toWorkspaceView) };
    case "updated":
      return { kind: "updated", workspace: toWorkspaceView(e.value) };
    case "removedId":
      return { kind: "removed", id: e.value };
    default:
      return null;
  }
}
