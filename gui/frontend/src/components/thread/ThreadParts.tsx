import { Folder, FolderGit2, House } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CommandButton } from "@/components/command/CommandButton";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { threadRowModel, type WorkspaceLookup } from "@/lib/threadRow";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/threads";
import { Chip } from "./Chip";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/**
 * The thread's name. A click runs session.rename exactly as the palette does (the inline
 * editor in the sidebar row), so it adds no user action of its own; where rename is not
 * available the name is plain text.
 */
function ThreadName({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name || id);
  return (
    <CommandButton
      command="thread.rename"
      whenUnavailable="plain"
      size="xs"
      className="-ml-1.5 flex h-6 min-w-0 shrink items-center rounded-md px-1.5 text-label text-foreground"
      data-testid="thread-title"
    >
      <span className="truncate">{name}</span>
    </CommandButton>
  );
}

/**
 * Where the thread runs: project @ branch (mono), and a "worktree" chip off the main
 * checkout; a project without git shows a plain folder and the No git badge instead; a
 * thread without a project the House icon and "No project", nothing else. The
 * same threadRowModel the sidebar row reads, so the two never disagree. A click opens the
 * Worktree surface in the side panel (view.panel.worktree); where that is not available it
 * is plain text.
 */
function ThreadLocation({ id }: { id: string }) {
  const where = useSessionsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: "" };
    }),
  );
  const m = useReposStore(
    useShallow((st) => {
      const r = threadRowModel(where, st, NO_WORKSPACES);
      return { project: r.project, branch: r.branch, noGit: r.noGit, noProject: r.noProject, worktree: r.worktree };
    }),
  );
  const Icon = m.noProject ? House : m.noGit ? Folder : FolderGit2;
  return (
    <CommandButton
      command="view.panel.worktree"
      whenUnavailable="plain"
      size="xs"
      className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-caption whitespace-nowrap text-muted-foreground"
      data-testid="thread-location"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate" data-testid="thread-project" data-no-project={m.noProject || undefined}>
        {m.project}
      </span>
      {m.noProject ? null : m.noGit ? (
        <NoGitBadge />
      ) : (
        <>
          <span className="shrink-0 opacity-60">@</span>
          <span className="truncate text-code" data-testid="thread-branch">
            {m.branch}
          </span>
          {m.worktree && <Chip data-testid="thread-worktree-chip">worktree</Chip>}
        </>
      )}
    </CommandButton>
  );
}

/** Left side of a thread's header: its name, then where it runs. */
export function SessionTitle({ id }: { id: string }) {
  return (
    <>
      <ThreadName id={id} />
      <ThreadLocation id={id} />
    </>
  );
}
