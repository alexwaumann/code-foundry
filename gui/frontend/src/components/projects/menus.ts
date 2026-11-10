import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import type { ProjectKind, ProjectNextStep } from "@/lib/projects";
import type { ThreadBadge } from "@/lib/thread";
import { openCheckoutDiff } from "@/stores/filePanel";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { cleanupMergedWorktrees, initGitIn, newTerminalIn, publishProject, removeWorktree, resumeWorktree, revealProject, unregisterProject } from "@/stores/projectActions";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { startProjectRename } from "@/stores/projectRename";
import { openWorkspaceAddProject } from "@/stores/workspaceAddProject";
import { newWorkspaceTerminal, removeWorkspace } from "@/stores/workspaceActions";
import { startWorkspaceRename } from "@/stores/workspaceRename";
import type { OverflowItem } from "./OverflowMenu";
import type { RowMenuEntry } from "./rowMenu";
import { openThread } from "./workspaceHooks";

/** What a project's menu depends on (the rest is read when an item runs). */
export interface ProjectMenuFacts {
  kind: ProjectKind;
  step: ProjectNextStep;
  /** Merged worktrees to clean up; null hides the item (no git, or no remote to merge into). */
  cleanup: number | null;
}

/**
 * A project's menu, one list for its index row's context menu and its page's ⋯ (`page`):
 * New thread, New terminal, Open in Finder (the row's only: the page's Details has it);
 * Rename, Clean up merged worktrees (git with a remote; the count at the right, disabled at
 * 0), its setup step (Publish to GitHub or Initialize git); Remove project. No icons and no
 * trailing "…" (the app's menu style). No New worktree: worktrees are made by threads and
 * agents (project.worktree.new stays for the CLI and the palette). No New action: Details'
 * Actions row has it. docs/notes/projects-table-2-context-menus.md,
 * docs/notes/project-page-1-title-block.md.
 */
export function projectMenu(projectId: string, { kind, step, cleanup }: ProjectMenuFacts, opts: { page?: boolean } = {}): OverflowItem[] {
  const main = () => mainWorktreePath(useProjectsStore.getState(), projectId);
  const items: OverflowItem[] = [
    { label: "New thread", testId: "project-menu-new-thread", onSelect: () => { composeIn(projectId); } },
    { label: "New terminal", testId: "project-menu-new-terminal", onSelect: () => void newTerminalIn(projectId, main()) },
  ];
  if (!opts.page) items.push({ label: "Open in Finder", testId: "project-menu-reveal", onSelect: () => void revealProject(projectId) });
  items.push("separator", { label: "Rename", testId: "project-menu-rename", onSelect: () => { startProjectRename(projectId); } });
  if (kind !== "nogit" && cleanup !== null) {
    items.push({ label: "Clean up merged worktrees", testId: "project-cleanup", badge: cleanup, disabled: cleanup === 0, onSelect: () => void cleanupMergedWorktrees(projectId) });
  }
  if (step === "publish") items.push({ label: "Publish to GitHub", testId: "project-menu-publish", onSelect: () => { publishProject(projectId); } });
  if (step === "init") items.push({ label: "Initialize git", testId: "project-menu-init-git", onSelect: () => void initGitIn(projectId) });
  items.push("separator", { label: "Remove project", destructive: true, testId: "project-unregister", onSelect: () => void unregisterProject(projectId) });
  return items;
}

/** The part of a workspace's menu drawn by WorkspaceMenuParts.tsx: the split Open in Finder item for its folder. */
export interface WorkspaceMenuPart {
  kind: "workspace-open-in";
  testId: string;
  workspaceId: string;
  /** Its Open in list has Terminal (the folder has a place for one, as New terminal). */
  terminal: boolean;
}

/**
 * A workspace's menu, one list for its index row's context menu and its page's ⋯: New thread,
 * New terminal (in its own folder; left out when it has none, `folder`), Open in Finder (a split
 * item whose › opens the apps for its folder, as a checkout's); Rename, Add project (its page's
 * Add project list); Remove workspace. docs/notes/workspace-page-polish.md.
 */
export function workspaceMenu(workspaceId: string, { folder }: { folder: boolean }): RowMenuEntry<WorkspaceMenuPart>[] {
  const items: RowMenuEntry<WorkspaceMenuPart>[] = [{ label: "New thread", testId: "workspace-menu-new-thread", onSelect: () => { composeInWorkspace(workspaceId); } }];
  if (folder) items.push({ label: "New terminal", testId: "workspace-menu-new-terminal", onSelect: () => void newWorkspaceTerminal(workspaceId) });
  items.push(
    { kind: "workspace-open-in", testId: "workspace-menu-reveal", workspaceId, terminal: folder },
    "separator",
    { label: "Rename", testId: "workspace-menu-rename", onSelect: () => { startWorkspaceRename(workspaceId); } },
    { label: "Add project", testId: "workspace-menu-add-project", onSelect: () => { openWorkspaceAddProject(workspaceId); } },
    "separator",
    { label: "Remove workspace", destructive: true, testId: "workspace-menu-remove", onSelect: () => void removeWorkspace(workspaceId) },
  );
  return items;
}

/** A thread on a checkout, as its menu lists it. */
export interface CheckoutMenuThread {
  id: string;
  /** Its label (lib/prompt.ts threadLabel: the id when it has no name yet). */
  name: string;
  badge: ThreadBadge;
}

/** What a checkout's menu depends on, read when it opens. */
export interface CheckoutMenuFacts {
  projectId: string;
  path: string;
  /** Its branch; "" when HEAD is detached (no Copy branch name). */
  branch: string;
  isMain: boolean;
  /** Its open (not archived) threads. */
  threads: readonly CheckoutMenuThread[];
  /** Uncommitted files or commits ahead of its base (lib/projects.ts checkoutHasChanges). */
  changed: boolean;
  pr: { slug: string; number: number } | null;
  /** The project has actions. */
  actions: boolean;
}

/** The parts of a checkout's menu drawn by CheckoutMenuParts.tsx: two submenus and the split Open in Finder item. */
export type CheckoutMenuPart =
  | { kind: "threads"; testId: string; threads: readonly CheckoutMenuThread[] }
  | { kind: "open-in"; testId: string; projectId: string; path: string }
  | { kind: "actions"; testId: string; projectId: string; path: string };

/** Copies `text`, saying so in a toast (a menu item has no other place to). */
export async function copyWithToast(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    toast.success(`${what} copied`, { description: text });
  } catch {
    toast.error("Copy failed");
  }
}

/**
 * A checkout's right-click menu on its project's page (docs/notes/project-page-2-checkouts.md):
 * Open thread (a submenu of its threads; `Open “<name>”` for exactly one; nothing with none),
 * New thread here, New terminal here; Show changes (with something to show) and Open pull
 * request #N (with one); Open in Finder (a split item whose › opens the apps), Copy path, Copy
 * branch name (on a branch), Run action (a submenu, when the project has actions); Remove
 * worktree (not on main). Text only, like every Projects page menu.
 */
export function checkoutMenu(f: CheckoutMenuFacts): RowMenuEntry<CheckoutMenuPart>[] {
  const { projectId, path } = f;
  const items: RowMenuEntry<CheckoutMenuPart>[] = [];
  const only = f.threads.length === 1 ? f.threads[0] : undefined;
  if (only) items.push({ label: `Open “${only.name}”`, testId: "checkout-menu-open-thread", onSelect: () => { openThread(only.id); } });
  else if (f.threads.length > 1) items.push({ kind: "threads", testId: "checkout-menu-threads", threads: f.threads });
  items.push(
    { label: "New thread here", testId: "checkout-menu-new-thread", onSelect: () => { composeIn(projectId, path); } },
    { label: "New terminal here", testId: "checkout-menu-new-terminal", onSelect: () => void newTerminalIn(projectId, path) },
  );
  const look: OverflowItem[] = [];
  if (f.changed) look.push({ label: "Show changes", testId: "checkout-menu-changes", onSelect: () => { openCheckoutDiff("current", projectId, path); } });
  const pr = f.pr;
  if (pr) look.push({ label: `Open pull request #${String(pr.number)}`, testId: "checkout-menu-pr", onSelect: () => { openPullRequestInPanel(pr); } });
  if (look.length > 0) items.push("separator", ...look);
  items.push(
    "separator",
    { kind: "open-in", testId: "checkout-menu-open-in", projectId, path },
    { label: "Copy path", testId: "checkout-menu-copy-path", onSelect: () => void copyWithToast(path, "Path") },
  );
  const branch = f.branch;
  if (branch) items.push({ label: "Copy branch name", testId: "checkout-menu-copy-branch", onSelect: () => void copyWithToast(branch, "Branch name") });
  if (f.actions) items.push({ kind: "actions", testId: "checkout-menu-actions", projectId, path });
  if (!f.isMain) items.push("separator", { label: "Remove worktree", destructive: true, testId: "checkout-menu-remove", onSelect: () => void removeWorktree(projectId, path) });
  return items;
}

/** What a leftover worktree's menu depends on, read when it opens. */
export interface LeftoverMenuFacts {
  projectId: string;
  path: string;
  /** Its branch; "" when HEAD is detached (no Copy branch name). */
  branch: string;
  /** It still holds work (lib/leftovers.ts holdsWork): Show changes. */
  work: boolean;
  /** The last thread archived on it (its label), for Resume; null when none was. */
  archived: { id: string; name: string } | null;
}

/** The part of a leftover's menu drawn by CheckoutMenuParts.tsx: the split Open in Finder item. */
export type LeftoverMenuPart = Extract<CheckoutMenuPart, { kind: "open-in" }>;

/**
 * A leftover worktree's right-click menu on its project's page, in "Worktrees without threads"
 * (docs/notes/project-page-3-leftovers.md): Resume “<name>” (its last archived thread, when one
 * was), New thread here, New terminal here; Show changes (while it holds work); Open in Finder
 * (the checkouts' split item), Copy path, Copy branch name (on a branch); Remove worktree.
 */
export function leftoverMenu(f: LeftoverMenuFacts): RowMenuEntry<LeftoverMenuPart>[] {
  const { projectId, path } = f;
  const items: RowMenuEntry<LeftoverMenuPart>[] = [];
  const archived = f.archived;
  if (archived) items.push({ label: `Resume “${archived.name}”`, testId: "leftover-menu-resume", onSelect: () => void resumeWorktree(projectId, path, archived.id) });
  items.push(
    { label: "New thread here", testId: "leftover-menu-new-thread", onSelect: () => { composeIn(projectId, path); } },
    { label: "New terminal here", testId: "leftover-menu-new-terminal", onSelect: () => void newTerminalIn(projectId, path) },
  );
  if (f.work) items.push("separator", { label: "Show changes", testId: "leftover-menu-changes", onSelect: () => { openCheckoutDiff("current", projectId, path); } });
  items.push(
    "separator",
    { kind: "open-in", testId: "leftover-menu-open-in", projectId, path },
    { label: "Copy path", testId: "leftover-menu-copy-path", onSelect: () => void copyWithToast(path, "Path") },
  );
  const branch = f.branch;
  if (branch) items.push({ label: "Copy branch name", testId: "leftover-menu-copy-branch", onSelect: () => void copyWithToast(branch, "Branch name") });
  items.push("separator", { label: "Remove worktree", destructive: true, testId: "leftover-menu-remove", onSelect: () => void removeWorktree(projectId, path) });
  return items;
}
