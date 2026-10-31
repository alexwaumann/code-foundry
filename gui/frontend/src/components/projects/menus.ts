import { Broom, CloudUpload, GitBranchPlus, Play, Unlink } from "lucide-react";
import type { ProjectKind, ProjectNextStep } from "@/lib/projects";
import { openActionEditor } from "@/stores/actionDialog";
import { cleanupMergedWorktrees, initGitIn, publishProject, unregisterProject } from "@/stores/projectActions";
import type { OverflowItem } from "./OverflowMenu";

/**
 * A project's overflow (the index row's and the project page header's): New action…,
 * Clean up merged worktrees (git with a remote, `cleanup` the count; disabled at 0), its
 * setup step, then Remove project. No New worktree: worktrees are made by threads and
 * agents (project.worktree.new stays for the CLI and the palette).
 */
export function projectMenu(projectId: string, kind: ProjectKind, step: ProjectNextStep, cleanup: number | null): OverflowItem[] {
  const items: OverflowItem[] = [{ label: "New action…", icon: Play, testId: "project-new-action", onSelect: () => { openActionEditor({ mode: "new", projectId, from: "projects" }); } }];
  if (kind !== "nogit" && cleanup !== null) {
    items.push({ label: "Clean up merged worktrees", icon: Broom, testId: "project-cleanup", badge: cleanup, disabled: cleanup === 0, onSelect: () => void cleanupMergedWorktrees(projectId) });
  }
  if (step === "publish") items.push({ label: "Publish to GitHub…", icon: CloudUpload, testId: "project-menu-publish", onSelect: () => { publishProject(projectId); } });
  if (step === "init") items.push({ label: "Initialize git", icon: GitBranchPlus, testId: "project-menu-init-git", onSelect: () => void initGitIn(projectId) });
  items.push("separator", { label: "Remove project", icon: Unlink, destructive: true, testId: "project-unregister", onSelect: () => void unregisterProject(projectId) });
  return items;
}
