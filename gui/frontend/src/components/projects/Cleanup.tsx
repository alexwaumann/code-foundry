import { GitMerge } from "lucide-react";
import { cleanableTitle } from "@/lib/projects";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useCleanable } from "./useCleanable";

/** The emerald "in main" tag of a worktree the cleanup would remove (nothing otherwise). */
export function CleanableTag({ repoId, path }: { repoId: string; path: string }) {
  const cleanable = useCleanable(repoId, path);
  const baseRef = useReposStore((s) => findWorktree(s, repoId, path)?.status.baseRef ?? "");
  if (!cleanable) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-[3px] rounded-sm bg-success/15 px-1 text-[10px] leading-4 font-medium text-success"
      title={cleanableTitle(baseRef)}
      data-testid="worktree-cleanable"
    >
      <GitMerge className="size-2.5" aria-hidden />
      in main
    </span>
  );
}
