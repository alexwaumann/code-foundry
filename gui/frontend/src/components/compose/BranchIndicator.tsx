import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { checkoutBranch } from "@/lib/compose";

/**
 * Which branch an existing worktree (or the current checkout) is on, read-only, in the
 * slot the base-ref picker uses for a new worktree. Shaped like a picker pill without the
 * chevron; not a button and not a compose stop, so Tab skips it.
 */
export function BranchIndicator({ worktree }: { worktree: { branch: string; head: string; detached: boolean; isMain: boolean } }) {
  const { text, label } = checkoutBranch(worktree);
  const Icon = worktree.branch && !worktree.detached ? GitBranch : GitCommitHorizontal;
  return (
    <div
      role="note"
      aria-label={label}
      title={label}
      data-testid="composer-checkout-branch"
      className="inline-flex h-6 max-w-64 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md bg-muted/50 px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground select-none [&_svg]:size-3 [&_svg]:shrink-0"
    >
      <Icon aria-hidden />
      <span className="truncate">{text}</span>
    </div>
  );
}
