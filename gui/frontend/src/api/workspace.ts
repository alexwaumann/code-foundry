import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { Workspace, WorkspaceEvent } from "@/gen/codefoundry/v1/workspace_pb";

/**
 * A member of a workspace: a project. A workspace has no worktrees since the reshape
 * (docs/notes/workspaces-v2-2-workspaces.md): worktreePath is always "" until the GUI
 * moves to thread checkouts (workspaces v2, PRs 3 and 4).
 */
export interface WorkspaceMemberView {
  projectId: string;
  worktreePath: string;
}

/**
 * View model for a workspace: a saved set of projects with a managed dir for the
 * instructions and skills that span them. Generated types stay inside src/api.
 */
export interface WorkspaceView {
  /** "w-" + 12 hex digits. */
  id: string;
  /** Unique display name (case-insensitively). */
  name: string;
  /** "" since the reshape: a workspace has no branch (a thread has one). */
  branch: string;
  /** Sorted by project id. */
  members: WorkspaceMemberView[];
  /** The folder a rooted workspace came from; "" for a synthetic one. */
  rootPath?: string;
  /** Where new threads start: a member project id, or "workspace" (its folder). */
  defaultPrimary?: string;
  /** <config home>/workspaces/<id>: its CLAUDE.md, AGENTS.md and .claude/skills (or links). */
  managedDir?: string;
  /** Its instructions file: CLAUDE.md, else AGENTS.md (a rooted workspace's: the root's real file); "" when neither exists. */
  instructions?: string;
  /** The skills in <managedDir>/.claude/skills, sorted. */
  skills?: readonly string[];
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
    branch: "",
    members: w.members.map((projectId) => ({ projectId, worktreePath: "" })),
    rootPath: w.rootPath,
    defaultPrimary: w.defaultPrimary,
    managedDir: w.managedDir,
    instructions: w.instructions,
    skills: [...w.skills],
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
