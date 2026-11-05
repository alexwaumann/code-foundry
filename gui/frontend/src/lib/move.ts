/**
 * Moving a thread without a project into a project or a workspace (thread.move;
 * docs/notes/move-no-project-2-gui.md): the command's args for the move picker's choices,
 * the line under its pickers, and the header crumb's "Moving to …" while it moves. Pure.
 */
import type { ThreadMoveView, ThreadView } from "@/api/threads";
import type { WorktreeChoice } from "./compose";
import { isNoProject, type ProjectLookup } from "./threadRow";
import { setupUnfinished } from "./threadSetup";

/**
 * Whether the move picker is offered for a thread: one without a project (lib/threadRow
 * isNoProject) that thread.move would take: not archived, not resident (Ember), not
 * moving already, its transcript not deleted (the daemon refuses: nothing to resume), its
 * setup finished (the daemon refuses: it has not started).
 * The crumb, the menus and the palette's thread.move.open share it.
 */
export function canMove(
  t: (Pick<ThreadView, "projectId" | "workspaceId" | "worktreePath" | "archivedAtMs" | "resident" | "pendingMove" | "transcriptMissing"> & Partial<Pick<ThreadView, "setup">>) | undefined,
  projects: ProjectLookup,
): boolean {
  if (!t || t.archivedAtMs !== null || (t.resident ?? "") !== "" || t.pendingMove !== null || t.transcriptMissing || setupUnfinished(t.setup)) return false;
  return isNoProject(t, projects);
}

/** Where the picker moves the thread: a project, or a workspace (its members are the set). */
export type MoveTarget = { kind: "project"; projectId: string } | { kind: "workspace"; workspaceId: string };

/**
 * thread.move's args for a choice, the names and meanings of thread.new's: a fresh copy is
 * `new-worktree` (with `base` when one was picked), an existing branch `new-worktree` +
 * `branch`, a project's folder (its main checkout, or the folder of a project without git)
 * `new-worktree=false`, another existing worktree `worktree`. A workspace adds `workspace`,
 * with `project` its primary (a member, or "workspace" for its folder). Every choice is sent
 * explicitly: the picker showed the default it resolved from the settings.
 */
export function moveArgs(threadId: string, target: MoveTarget, p: { worktree: WorktreeChoice; base: string; primary: string; mainPath?: string | undefined }): Record<string, string> {
  const args: Record<string, string> = { id: threadId };
  if (target.kind === "workspace") {
    args.workspace = target.workspaceId;
    if (p.primary) args.project = p.primary;
  } else {
    args.project = target.projectId;
  }
  const w = p.worktree;
  if (w.kind === "new") {
    args["new-worktree"] = "true";
    if (p.base) args.base = p.base;
  } else if (w.kind === "branch") {
    args["new-worktree"] = "true";
    args.branch = w.name;
  } else if (w.kind === "existing" && target.kind === "project" && w.path !== p.mainPath) {
    args.worktree = w.path;
  } else {
    args["new-worktree"] = "false";
  }
  return args;
}

/**
 * The line under the move picker's pills: what the choice does to the thread. A fresh copy
 * names its branch from the conversation; an existing branch is worked on where it is (a
 * worktree made when it has none); a folder keeps whatever branch it has checked out.
 */
export function moveLine(p: { worktree: WorktreeChoice; set: boolean; many: boolean; noGit: boolean; mainPath?: string | undefined }): string {
  const w = p.worktree;
  if (w.kind === "new") return "New branch, named from the conversation when it moves.";
  if (w.kind === "branch") return `Works on the existing branch ${w.name}; a worktree is made for it if none exists.`;
  if (p.noGit) return "Works in the project's folder.";
  if (w.kind === "existing" && !p.set && w.path !== p.mainPath) return `Works in the worktree at ${w.path}.`;
  if (p.many) return "Works in each project's folder, on the branch it has checked out.";
  return "Works in the project's folder, on its current branch.";
}

/** The names the crumb's moving label looks up. */
export interface MoveNames {
  project: (id: string) => string | undefined;
  workspace: (id: string) => string | undefined;
}

/**
 * Where a moving thread goes, by name: the workspace's (a workspace move names it even
 * with a primary member), else the project's; `sending` (the name the picker sent) while
 * the daemon has not said yet. Null when nothing is moving.
 */
export function movingTo(pending: Pick<ThreadMoveView, "projectId" | "workspaceId"> | null, sending: string | undefined, names: MoveNames): string | null {
  if (pending) {
    if (pending.workspaceId) return names.workspace(pending.workspaceId) ?? pending.workspaceId;
    if (pending.projectId) return names.project(pending.projectId) ?? pending.projectId;
  }
  return sending ?? null;
}

/** The crumb's text while a thread moves. */
export function movingLabel(name: string): string {
  return `Moving to ${name}…`;
}
