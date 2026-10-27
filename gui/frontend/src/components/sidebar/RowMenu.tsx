import { Archive, ArchiveRestore, ArrowRightLeft, EyeOff, FolderGit2, GitBranchPlus, GitFork, Layers, Pencil, Pin, PinOff, SquareTerminal, Trash2 } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useNoProjectThread } from "@/components/thread/useNoProject";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { SnoozeRowItems } from "@/components/snooze/SnoozeMenu";
import { beginRename } from "@/keys/bindings";
import { WORKSPACE_FOLDER } from "@/lib/projectSet";
import { canNewLike, canRunElsewhere, worktreeBranch } from "@/lib/threadRow";
import { newThreadTerminal } from "@/stores/bottomActions";
import { composeLike } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { archiveThread, forkThread, pinThread, removeThread, runThreadIn, setThreadSidebar } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { showWorktreeInThread } from "@/stores/worktreePanel";

function MemberItem({ threadId, projectId, path, current, queued }: { threadId: string; projectId: string; path: string; current: boolean; queued: boolean }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => (path ? worktreeBranch(s, projectId, path) : ""));
  return (
    <ContextMenuItem
      disabled={current}
      data-member={projectId}
      onSelect={() => {
        void runThreadIn(threadId, projectId);
      }}
    >
      <FolderGit2 className="text-cf-info-text/90" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {branch && <span className="truncate font-mono text-caption">{branch}</span>}
      </span>
      {(current || queued) && <span className="ml-auto pl-3 text-caption">{current ? "runs here" : "queued"}</span>}
    </ContextMenuItem>
  );
}

/**
 * "Run in…" for a thread with somewhere else to run (canRunElsewhere): its workspace folder
 * and its projects' checkouts, the current one disabled. Picking one invokes
 * thread.run-in; the row shows the queued move until it happens.
 */
function RunInMenu({ threadId }: { threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const pending = useThreadsStore((s) => s.byId[threadId]?.pendingWorktreePath ?? "");
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const wsName = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? workspaceId) : ""));
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const sorted = [...projectIds].sort();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="menu-run-in">
        <ArrowRightLeft />
        Run in…
      </ContextMenuSubTrigger>
      <ContextMenuSubContent data-testid="menu-run-in-members">
        {workspaceId && (
          <ContextMenuItem
            disabled={primary === ""}
            data-member="workspace"
            onSelect={() => {
              void runThreadIn(threadId, "workspace");
            }}
          >
            <Layers className="text-cf-highlight-text" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{WORKSPACE_FOLDER}</span>
              <span className="truncate text-caption">{wsName}</span>
            </span>
            {primary === "" && <span className="ml-auto pl-3 text-caption">runs here</span>}
          </ContextMenuItem>
        )}
        {workspaceId && sorted.length > 0 && <ContextMenuLabel>Projects</ContextMenuLabel>}
        {sorted.map((projectId) => {
          const path = paths[projectId] ?? "";
          return <MemberItem key={projectId} threadId={threadId} projectId={projectId} path={path} current={projectId === primary} queued={path !== "" && path === pending && path !== cwd} />;
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * The context menu of a thread row. Every item is a registry command (or the inline rename
 * that commits one). A thread without a project has no worktree to show.
 */
export function RowMenu({ id }: { id: string }) {
  const noProject = useNoProjectThread(id);
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  const archived = useThreadsStore((s) => (s.byId[id]?.archivedAtMs ?? null) !== null);
  const snoozed = useThreadsStore((s) => (s.byId[id]?.snoozedUntilMs ?? null) !== null);
  // The palette's and the daemon's rules (lib/threadRow): somewhere else to run; a project or workspace to copy.
  const runIn = useThreadsStore((s) => canRunElsewhere(s.byId[id]));
  const newLike = useThreadsStore((s) => canNewLike(s.byId[id]));
  // Another thread created it: a row in the sidebar is shown, so it can be handed back.
  const created = useThreadsStore((s) => (s.byId[id]?.createdBy ?? "") !== "");
  const transcriptMissing = useThreadsStore((s) => s.byId[id]?.transcriptMissing === true);
  return (
    <ContextMenuContent
      data-testid="row-menu"
      data-thread={id}
      onCloseAutoFocus={(e) => {
        // Rename puts an input in the row, and New thread on this branch focuses the
        // composer's prompt: closing must not move focus back to the list.
        const ui = useUiStore.getState();
        if (ui.renamingThreadId === id || (ui.selection.kind === "compose" && ui.selection.likeThreadId === id)) e.preventDefault();
      }}
    >
      <ContextMenuItem
        onSelect={() => {
          beginRename(id);
        }}
      >
        <Pencil />
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="menu-pin"
        onSelect={() => {
          void pinThread(id, !pinned);
        }}
      >
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <SnoozeRowItems id={id} snoozed={snoozed} />
      <ContextMenuItem
        data-testid="menu-archive"
        onSelect={() => {
          void archiveThread(id, !archived);
        }}
      >
        {archived ? <ArchiveRestore /> : <Archive />}
        {archived ? "Unarchive" : "Archive"}
      </ContextMenuItem>
      {created && (
        <ContextMenuItem
          data-testid="menu-sidebar-hide"
          onSelect={() => {
            void setThreadSidebar(id, false);
          }}
        >
          <EyeOff />
          Hide from sidebar
        </ContextMenuItem>
      )}
      {runIn && <RunInMenu threadId={id} />}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void newThreadTerminal(id);
        }}
      >
        <SquareTerminal />
        New terminal here
      </ContextMenuItem>
      {!noProject && (
        <ContextMenuItem
          onSelect={() => {
            showWorktreeInThread(id);
          }}
        >
          <FolderGit2 />
          Show worktree
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {newLike && (
        <ContextMenuItem
          data-testid="menu-new-like"
          onSelect={() => {
            composeLike(id);
          }}
        >
          <GitBranchPlus />
          New thread on this branch
        </ContextMenuItem>
      )}
      <ContextMenuItem
        data-testid="menu-fork"
        // Nothing to fork from once Claude Code deleted the transcript (docs/notes/transcript-deleted.md).
        disabled={transcriptMissing}
        onSelect={() => {
          void forkThread(id);
        }}
      >
        <GitFork />
        Fork
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onSelect={() => {
          void removeThread(id);
        }}
      >
        <Trash2 />
        Remove…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
