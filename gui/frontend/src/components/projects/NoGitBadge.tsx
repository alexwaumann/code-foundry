import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shown where a branch would be for a project without git (sidebar rows, the Projects
 * page, the composer, the overview title): its synthetic checkout has no branch, head or
 * status, and nothing may render those as if they were real. Its tooltip says what that
 * means; `tip={false}` inside a trigger with a tooltip of its own (a sidebar row).
 */
export function NoGitBadge({ className, tip = true }: { className?: string; tip?: boolean }) {
  const badge = (
    <span className={cn("inline-flex shrink-0 items-center rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground", className)} data-testid="no-git-badge">
      No git
    </span>
  );
  return tip ? <Tip label="Not a git repository: threads and terminals run in the folder itself">{badge}</Tip> : badge;
}
