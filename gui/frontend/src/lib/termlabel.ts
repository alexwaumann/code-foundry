/**
 * The terminal label contract (internal/termlabel, proto Terminal.labels) beyond the two
 * the sidebar already uses (lib/tree.ts). A shell terminal.new starts carries
 * kind=shell, repo and worktree, plus session when a thread owns it. A thread's Claude
 * terminal has session too, so `session` alone never identifies a shell.
 */
import { SESSION_LABEL, WORKTREE_LABEL } from "./tree";

export { SESSION_LABEL, WORKTREE_LABEL };
export const KIND_LABEL = "kind";
export const REPO_LABEL = "repo";
export const KIND_SHELL = "shell";

/** Whether the labels mark a shell terminal.new started. */
export function isShellLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SHELL;
}
