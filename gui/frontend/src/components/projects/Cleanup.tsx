import { GitMerge } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cleanableTitle } from "@/lib/projects";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useCleanable } from "./useCleanable";

/** The emerald "in main" tag of a worktree the cleanup would remove (nothing otherwise). */
export function CleanableTag({ projectId, path }: { projectId: string; path: string }) {
  const cleanable = useCleanable(projectId, path);
  const baseRef = useProjectsStore((s) => findWorktree(s, projectId, path)?.status.baseRef ?? "");
  if (!cleanable) return null;
  return (
    <Tip label={cleanableTitle(baseRef)}>
      <span className="flex shrink-0 items-center gap-[3px] rounded-sm bg-cf-success-surface px-1 text-caption-sm font-medium text-cf-success-text" data-testid="worktree-cleanable">
        <GitMerge className="size-2.5" aria-hidden />
        in main
      </span>
    </Tip>
  );
}
