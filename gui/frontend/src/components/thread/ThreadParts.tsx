import { CornerDownRight, Folder, FolderGit2, House } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CommandButton } from "@/components/command/CommandButton";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Tip } from "@/components/ui/tooltip";
import { threadRowModel, type WorkspaceLookup } from "@/lib/threadRow";
import { cn } from "@/lib/utils";
import { useCreator } from "@/stores/lineage";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { Chip } from "./Chip";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/**
 * The thread's name. A click runs thread.rename exactly as the palette does (the inline
 * editor in the sidebar row), so it adds no user action of its own; where rename is not
 * available the name is plain text.
 */
function ThreadName({ id }: { id: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name || id);
  // The daemon's cut of the first prompt until the naming model's title lands: muted and italic, as in the sidebar.
  const provisional = useThreadsStore((s) => s.byId[id]?.nameProvisional ?? false);
  return (
    <CommandButton
      command="thread.rename"
      whenUnavailable="plain"
      size="xs"
      className={cn("-ml-1.5 flex h-6 min-w-0 shrink items-center rounded-md px-1.5 text-label text-foreground", provisional && "text-muted-foreground italic")}
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
  const where = useThreadsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { projectId: x?.projectId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: "" };
    }),
  );
  const m = useProjectsStore(
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

const CREATED_BY_CHIP = "flex h-[22px] max-w-60 min-w-0 shrink-[4] items-center gap-[5px] rounded-md bg-foreground/7 px-1.5 text-caption-sm font-normal whitespace-nowrap text-muted-foreground";

/**
 * "↳ from <creator>" for a thread an agent created (docs/notes/agents-3-lineage-gui.md,
 * sketch variant A): the creator's current name (its name at creation once removed,
 * docs/notes/lineage-by-id.md). A click opens the Threads surface in the side panel
 * (view.panel.threads). When the creator was removed the chip is inert and muted, with
 * "Thread removed" as its tooltip; an archived creator still exists. Nothing for the
 * user's threads.
 */
function CreatedByChip({ id }: { id: string }) {
  const creator = useCreator(id);
  if (creator === null) return null;
  const content = (
    <>
      <CornerDownRight className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        from <span className={creator.exists ? "font-medium text-foreground/80" : undefined}>{creator.name}</span>
      </span>
    </>
  );
  if (!creator.exists)
    return (
      <Tip label="Thread removed">
        <span className={`${CREATED_BY_CHIP} opacity-60`} data-testid="thread-created-by" data-removed="true">
          {content}
        </span>
      </Tip>
    );
  return (
    <CommandButton command="view.panel.threads" whenUnavailable="plain" size="xs" className={`${CREATED_BY_CHIP} hover:bg-foreground/12 hover:text-muted-foreground dark:hover:bg-foreground/12`} data-testid="thread-created-by">
      {content}
    </CommandButton>
  );
}

/** Left side of a thread's header: its name, who created it (an agent's thread), then where it runs. */
export function ThreadTitle({ id }: { id: string }) {
  return (
    <>
      <ThreadName id={id} />
      <CreatedByChip id={id} />
      <ThreadLocation id={id} />
    </>
  );
}
