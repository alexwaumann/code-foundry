import type { ProjectKind, ProjectNextStep } from "@/lib/projects";
import { openActionEditor } from "@/stores/actionDialog";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import { cleanupMergedWorktrees, initGitIn, newTerminalIn, publishProject, revealProject, unregisterProject } from "@/stores/projectActions";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { startProjectRename } from "@/stores/projectRename";
import { openWorkspaceAddProject } from "@/stores/workspaceAddProject";
import { newWorkspaceTerminal, removeWorkspace, revealWorkspace } from "@/stores/workspaceActions";
import { startWorkspaceRename } from "@/stores/workspaceRename";
import type { OverflowItem } from "./OverflowMenu";

/** What a project's menu depends on (the rest is read when an item runs). */
export interface ProjectMenuFacts {
  kind: ProjectKind;
  step: ProjectNextStep;
  /** Merged worktrees to clean up; null hides the item (no git, or no remote to merge into). */
  cleanup: number | null;
}

/**
 * A project's menu, one list for its index row's context menu and its page's ⋯ (which puts
 * New action… first, `newAction`): New thread, New terminal, Open in Finder; Rename, Clean up
 * merged worktrees (git with a remote; the count at the right, disabled at 0), its setup step
 * (Publish to GitHub or Initialize git); Remove project. No icons and no trailing "…" (the app's
 * menu style). No New worktree: worktrees are made by threads and agents (project.worktree.new
 * stays for the CLI and the palette). docs/notes/projects-table-2-context-menus.md.
 */
export function projectMenu(projectId: string, { kind, step, cleanup }: ProjectMenuFacts, opts: { newAction?: boolean } = {}): OverflowItem[] {
  const main = () => mainWorktreePath(useProjectsStore.getState(), projectId);
  const items: OverflowItem[] = [];
  if (opts.newAction) items.push({ label: "New action", testId: "project-new-action", onSelect: () => { openActionEditor({ mode: "new", projectId, from: "projects" }); } }, "separator");
  items.push(
    { label: "New thread", testId: "project-menu-new-thread", onSelect: () => { composeIn(projectId); } },
    { label: "New terminal", testId: "project-menu-new-terminal", onSelect: () => void newTerminalIn(projectId, main()) },
    { label: "Open in Finder", testId: "project-menu-reveal", onSelect: () => void revealProject(projectId) },
    "separator",
    { label: "Rename", testId: "project-menu-rename", onSelect: () => { startProjectRename(projectId); } },
  );
  if (kind !== "nogit" && cleanup !== null) {
    items.push({ label: "Clean up merged worktrees", testId: "project-cleanup", badge: cleanup, disabled: cleanup === 0, onSelect: () => void cleanupMergedWorktrees(projectId) });
  }
  if (step === "publish") items.push({ label: "Publish to GitHub", testId: "project-menu-publish", onSelect: () => { publishProject(projectId); } });
  if (step === "init") items.push({ label: "Initialize git", testId: "project-menu-init-git", onSelect: () => void initGitIn(projectId) });
  items.push("separator", { label: "Remove project", destructive: true, testId: "project-unregister", onSelect: () => void unregisterProject(projectId) });
  return items;
}

/**
 * A workspace's menu, one list for its index row's context menu and its page's ⋯: New thread,
 * New terminal (in its own folder; left out when it has none, `folder`), Open in Finder; Rename,
 * Add project (its page's Add project list); Remove workspace.
 */
export function workspaceMenu(workspaceId: string, { folder }: { folder: boolean }): OverflowItem[] {
  const items: OverflowItem[] = [{ label: "New thread", testId: "workspace-menu-new-thread", onSelect: () => { composeInWorkspace(workspaceId); } }];
  if (folder) items.push({ label: "New terminal", testId: "workspace-menu-new-terminal", onSelect: () => void newWorkspaceTerminal(workspaceId) });
  items.push(
    { label: "Open in Finder", testId: "workspace-menu-reveal", onSelect: () => void revealWorkspace(workspaceId) },
    "separator",
    { label: "Rename", testId: "workspace-menu-rename", onSelect: () => { startWorkspaceRename(workspaceId); } },
    { label: "Add project", testId: "workspace-menu-add-project", onSelect: () => { openWorkspaceAddProject(workspaceId); } },
    "separator",
    { label: "Remove workspace", destructive: true, testId: "workspace-menu-remove", onSelect: () => void removeWorkspace(workspaceId) },
  );
  return items;
}
