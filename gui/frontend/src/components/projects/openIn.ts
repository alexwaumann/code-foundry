import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { newTerminalIn } from "@/stores/projectActions";
import { newWorkspaceTerminal, openWorkspaceInEditor, revealWorkspace } from "@/stores/workspaceActions";

/**
 * What an Open in list opens (OpenInFinder.tsx OpenInList, the split Open in Finder items):
 * the folder in Finder, in an installed editor app (by bundle id), and a new terminal there
 * (null: the folder has no place for one, and the list leaves Terminal out).
 */
export interface OpenInTarget {
  reveal: () => void;
  openWith: (bundleId: string) => void;
  terminal: (() => void) | null;
}

/** A checkout's: worktree.reveal, worktree.open.editor, a new terminal in it (a terminal tab). */
export function checkoutOpenIn(projectId: string, path: string): OpenInTarget {
  const ctx = () => worktreeContext(projectId, path);
  return {
    reveal: () => void runCommand("worktree.reveal", { worktree: path }, ctx()),
    openWith: (app) => void runCommand("worktree.open.editor", { worktree: path, app }, ctx()),
    terminal: () => void newTerminalIn(projectId, path),
  };
}

/**
 * A workspace's folder (its root, else the folder the app keeps): workspace.reveal,
 * workspace.open.editor, and its New terminal while it has a place for one (`terminal`:
 * workspaceHooks.ts useWorkspaceTerminal).
 */
export function workspaceOpenIn(workspaceId: string, terminal: boolean): OpenInTarget {
  return {
    reveal: () => void revealWorkspace(workspaceId),
    openWith: (app) => void openWorkspaceInEditor(workspaceId, app),
    terminal: terminal ? () => void newWorkspaceTerminal(workspaceId) : null,
  };
}
