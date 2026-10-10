import { ArrowDown, ArrowUp, CircleDot, Folder, GitBranch } from "lucide-react";
import { ChecksBadge, PrStateIcon } from "@/components/prs/PrBits";
import { NoGitBadge } from "./NoGitBadge";
import { tildify } from "@/lib/path";
import { worktreeBranch } from "@/lib/threadRow";
import { cn } from "@/lib/utils";
import { branchKey, branchPullRequestsResource } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useResource } from "@/stores/resource";

/**
 * The viewer's pull request on the worktree's branch (GhService.GetBranchPullRequests,
 * cached and kept polled by the daemon while shown): state, number and checks. Nothing
 * for a repository without a GitHub remote, a detached head, or the default branch.
 */
function BranchPullRequest({ repoId, branch }: { repoId: string; branch: string }) {
  const slug = useReposStore((s) => s.byId[repoId]?.githubSlug.toLowerCase() ?? "");
  const isDefault = useReposStore((s) => s.byId[repoId]?.defaultBranch === branch);
  const entry = useResource(branchPullRequestsResource, slug && branch && !isDefault ? branchKey(slug, branch) : null);
  const pr = entry?.data?.pullRequests[0];
  if (!pr) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="flex shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
      title={`#${String(pr.number)} ${pr.title}`}
      data-testid="worktree-pr"
      onClick={(e) => {
        e.stopPropagation();
        openPullRequestInPanel({ slug: pr.repoSlug || slug, number: pr.number });
      }}
    >
      <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
      {pr.state === "open" && <ChecksBadge checks={pr.checks} compact />}
    </button>
  );
}

/**
 * One worktree's git state on a line: branch, path, changed files, ahead/behind its
 * upstream, and its pull request. Shared by the Projects page's project worktrees and the
 * workspace member list.
 */
export function WorktreeState({ repoId, path, showPath = true }: { repoId: string; path: string; showPath?: boolean }) {
  const branch = useReposStore((s) => worktreeBranch(s, repoId, path));
  const realBranch = useReposStore((s) => findWorktree(s, repoId, path)?.branch ?? "");
  const isMain = useReposStore((s) => findWorktree(s, repoId, path)?.isMain ?? false);
  const missing = useReposStore((s) => findWorktree(s, repoId, path) === undefined);
  const dirty = useReposStore((s) => findWorktree(s, repoId, path)?.status.dirty ?? false);
  const changes = useReposStore((s) => {
    const st = findWorktree(s, repoId, path)?.status;
    return st ? st.staged + st.modified + st.untracked : 0;
  });
  const ahead = useReposStore((s) => findWorktree(s, repoId, path)?.status.ahead ?? 0);
  const behind = useReposStore((s) => findWorktree(s, repoId, path)?.status.behind ?? 0);
  const noGit = useReposStore((s) => s.byId[repoId]?.git === false);
  if (noGit) {
    // The folder itself: no branch, status or pull request to show.
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <NoGitBadge />
        {showPath && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
            {tildify(path)}
          </span>
        )}
        {missing && <span className="ml-auto shrink-0 pl-1 text-[11px] text-amber-300">missing</span>}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <GitBranch className={cn("size-3.5 shrink-0", isMain ? "text-muted-foreground" : "text-violet-400/90")} aria-hidden />
      <span className="max-w-[45%] shrink-0 truncate font-mono text-[13px]" data-testid="worktree-branch">
        {branch}
      </span>
      {showPath && (
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
          {tildify(path)}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-[11px] text-muted-foreground tabular-nums">
        {missing && <span className="text-amber-300">missing</span>}
        {dirty && (
          <span className="flex items-center gap-0.5 text-amber-400" title={`${String(changes)} changed`} data-testid="worktree-dirty">
            <CircleDot className="size-3" aria-label="dirty" />
            {changes > 0 && changes}
          </span>
        )}
        {ahead > 0 && (
          <span className="flex items-center" title={`${String(ahead)} ahead`} data-testid="worktree-ahead">
            <ArrowUp className="size-3" />
            {ahead}
          </span>
        )}
        {behind > 0 && (
          <span className="flex items-center" title={`${String(behind)} behind`} data-testid="worktree-behind">
            <ArrowDown className="size-3" />
            {behind}
          </span>
        )}
        {realBranch && <BranchPullRequest repoId={repoId} branch={realBranch} />}
      </span>
    </span>
  );
}

/** A small icon button for a row action (mouse; the keyboard reaches the same commands through the palette). */
export function RowAction({ label, onClick, children, destructive, testId }: { label: string; onClick: () => void; children: React.ReactNode; destructive?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5",
        destructive && "hover:text-destructive",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
