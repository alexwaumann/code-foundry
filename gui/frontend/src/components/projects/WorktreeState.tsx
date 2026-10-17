import { ArrowDown, ArrowUp, CircleDot, Folder, GitBranch, MessageSquare } from "lucide-react";
import { ChecksBadge, PrStateIcon } from "@/components/prs/PrBits";
import { Tip } from "@/components/ui/tooltip";
import { CleanableTag } from "./Cleanup";
import { NoGitBadge } from "./NoGitBadge";
import { tildify } from "@/lib/path";
import { worktreeThreadCount } from "@/lib/projects";
import { worktreeBranch } from "@/lib/threadRow";
import { cn } from "@/lib/utils";
import { branchKey, branchPullRequestsResource } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";
import { useThreadsStore } from "@/stores/threads";

/**
 * The viewer's pull request on the worktree's branch (GhService.GetBranchPullRequests,
 * cached and kept polled by the daemon while shown): state, number and checks. Nothing
 * for a repository without a GitHub remote, a detached head, or the default branch.
 */
function BranchPullRequest({ projectId, branch }: { projectId: string; branch: string }) {
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const isDefault = useProjectsStore((s) => s.byId[projectId]?.defaultBranch === branch);
  const entry = useResource(branchPullRequestsResource, slug && branch && !isDefault ? branchKey(slug, branch) : null);
  const pr = entry?.data?.pullRequests[0];
  if (!pr) return null;
  return (
    <Tip label={`#${String(pr.number)} ${pr.title}`}>
      <button
        type="button"
        tabIndex={-1}
        className="flex shrink-0 items-center gap-1 rounded-sm px-1 text-caption tabular-nums hover:bg-accent hover:text-foreground"
        data-testid="worktree-pr"
        onClick={(e) => {
          e.stopPropagation();
          openPullRequestInPanel({ slug: pr.repoSlug || slug, number: pr.number });
        }}
      >
        <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
        {pr.state === "open" && <ChecksBadge checks={pr.checks} compact />}
      </button>
    </Tip>
  );
}

/** How many threads are on the worktree (hidden at 0); subscribes to the count only. */
function WorktreeThreads({ path }: { path: string }) {
  const n = useThreadsStore((s) => worktreeThreadCount(s, path));
  if (n === 0) return null;
  return (
    <Tip label={`${String(n)} ${n === 1 ? "thread" : "threads"} on this worktree`}>
      <span className="flex items-center gap-0.5" data-testid="worktree-threads">
        <MessageSquare className="size-3" aria-hidden />
        {n}
      </span>
    </Tip>
  );
}

/**
 * One worktree's git state on a line: branch, then at the right its thread count,
 * changed files, ahead/behind its upstream, "in main" when the cleanup would remove it,
 * and its pull request. Shared by the Projects
 * page's project worktrees and the workspace member list. The path is the row's tooltip;
 * `showPath` also prints it after the branch. A folder without git shows its path always
 * (it has no branch to name it).
 */
export function WorktreeState({ projectId, path, showPath = false }: { projectId: string; path: string; showPath?: boolean }) {
  const branch = useProjectsStore((s) => worktreeBranch(s, projectId, path));
  const realBranch = useProjectsStore((s) => findWorktree(s, projectId, path)?.branch ?? "");
  const isMain = useProjectsStore((s) => findWorktree(s, projectId, path)?.isMain ?? false);
  const missing = useProjectsStore((s) => findWorktree(s, projectId, path) === undefined);
  const dirty = useProjectsStore((s) => findWorktree(s, projectId, path)?.status.dirty ?? false);
  const changes = useProjectsStore((s) => {
    const st = findWorktree(s, projectId, path)?.status;
    return st ? st.staged + st.modified + st.untracked : 0;
  });
  const ahead = useProjectsStore((s) => findWorktree(s, projectId, path)?.status.ahead ?? 0);
  const behind = useProjectsStore((s) => findWorktree(s, projectId, path)?.status.behind ?? 0);
  const noGit = useProjectsStore((s) => s.byId[projectId]?.git === false);
  if (noGit) {
    // The folder itself: no branch, status or pull request to show.
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <NoGitBadge />
        <span className="min-w-0 truncate text-caption" data-testid="worktree-path">
          {tildify(path)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-caption-sm tabular-nums">
          {missing && <span className="text-warning">missing</span>}
          <WorktreeThreads path={path} />
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <GitBranch className={cn("size-3.5 shrink-0", isMain ? "text-muted-foreground" : "text-highlight/90")} aria-hidden />
      <span className="max-w-[45%] shrink-0 truncate text-code" data-testid="worktree-branch">
        {branch}
      </span>
      {showPath && (
        <span className="min-w-0 truncate text-caption" data-testid="worktree-path">
          {tildify(path)}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1 text-caption-sm tabular-nums">
        {missing && <span className="text-warning">missing</span>}
        <WorktreeThreads path={path} />
        {dirty && (
          <Tip label={`${String(changes)} changed`}>
            <span className="flex items-center gap-0.5 text-warning" data-testid="worktree-dirty">
              <CircleDot className="size-3" aria-label="dirty" />
              {changes > 0 && changes}
            </span>
          </Tip>
        )}
        {ahead > 0 && (
          <Tip label={`${String(ahead)} ahead`}>
            <span className="flex items-center" data-testid="worktree-ahead">
              <ArrowUp className="size-3" />
              {ahead}
            </span>
          </Tip>
        )}
        {behind > 0 && (
          <Tip label={`${String(behind)} behind`}>
            <span className="flex items-center" data-testid="worktree-behind">
              <ArrowDown className="size-3" />
              {behind}
            </span>
          </Tip>
        )}
        <CleanableTag projectId={projectId} path={path} />
        {realBranch && <BranchPullRequest projectId={projectId} branch={realBranch} />}
      </span>
    </span>
  );
}

/** A small icon button for a row action, named by its tooltip (mouse; the keyboard reaches the same commands through the palette). */
export function RowAction({
  label,
  onClick,
  children,
  destructive,
  disabled,
  testId,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const button = (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:hover:bg-transparent [&_svg]:size-3.5",
        destructive && "hover:text-destructive",
        className,
      )}
      onDoubleClick={(e) => {
        // Quick repeated clicks must not open the row's panel tab.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
  // A disabled button gets no pointer events: its tooltip hangs on a span around it.
  return <Tip label={label}>{disabled ? <span className="flex shrink-0">{button}</span> : button}</Tip>;
}
