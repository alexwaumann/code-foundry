import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shown where a branch would be for a project without git (the composer, the move picker):
 * its synthetic checkout has no branch, head or status, and nothing may render those as if
 * they were real. Its tooltip says what that means.
 */
export function NoGitBadge({ className }: { className?: string }) {
  return (
    <Tip label="Not a git repository: threads and terminals run in the folder itself">
      <span className={cn("inline-flex shrink-0 items-center rounded-sm bg-cf-surface-sunken px-1 text-caption-sm font-medium", className)} data-testid="no-git-badge">
        No git
      </span>
    </Tip>
  );
}
