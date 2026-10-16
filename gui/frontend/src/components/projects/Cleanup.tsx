import { GitMerge } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { cleanableTitle } from "@/lib/projects";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useCleanable } from "./useCleanable";

/** The emerald "in main" tag of a worktree the cleanup would remove (nothing otherwise). */
export function CleanableTag({ repoId, path }: { repoId: string; path: string }) {
  const cleanable = useCleanable(repoId, path);
  const baseRef = useReposStore((s) => findWorktree(s, repoId, path)?.status.baseRef ?? "");
  if (!cleanable) return null;
  return (
    <Tip label={cleanableTitle(baseRef)}>
      <span className="flex shrink-0 items-center gap-[3px] rounded-sm bg-success/15 px-1 text-caption-sm font-medium text-success" data-testid="worktree-cleanable">
        <GitMerge className="size-2.5" aria-hidden />
        in main
      </span>
    </Tip>
  );
}
