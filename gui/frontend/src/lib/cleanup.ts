/** The cleanup dialog's words (components/projects/CleanupWorktreesDialog) for n worktrees whose work is in base. */
export function cleanupWords(n: number, base: string): { title: string; body: string; confirm: string } {
  if (n === 0) return { title: "No merged worktrees right now", body: "Fetch and check again? Branches are kept.", confirm: "Fetch and check" };
  if (n === 1) return { title: "Remove 1 merged worktree?", body: `Its work is already in ${base}. The branch is kept.`, confirm: "Remove 1 worktree" };
  return { title: `Remove ${String(n)} merged worktrees?`, body: `Their work is already in ${base}. Branches are kept.`, confirm: `Remove ${String(n)} worktrees` };
}
