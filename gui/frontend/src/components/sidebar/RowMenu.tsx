import { useShallow } from "zustand/react/shallow";
import { Archive, ArchiveRestore, ArrowRightLeft, EyeOff, FolderGit2, GitFork, Pencil, Pin, PinOff, SquareTerminal, Trash2 } from "lucide-react";
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
import { SnoozeRowItems } from "@/components/snooze/SnoozeMenu";
import { beginRename } from "@/keys/bindings";
import { worktreeBranch } from "@/lib/threadRow";
import { newThreadTerminal } from "@/stores/bottomActions";
import { useProjectsStore } from "@/stores/projects";
import { archiveThread, forkThread, pinThread, removeThread, runThreadIn, setThreadSidebar } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { showWorktreeInThread } from "@/stores/worktreePanel";

function MemberItem({ threadId, projectId, path, current, queued }: { threadId: string; projectId: string; path: string; current: boolean; queued: boolean }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => worktreeBranch(s, projectId, path));
  return (
    <ContextMenuItem
      disabled={current}
      data-member={projectId}
      onSelect={() => {
        void runThreadIn(threadId, projectId);
      }}
    >
      <FolderGit2 className="text-cf-info/90" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="truncate font-mono text-caption">{branch}</span>
      </span>
      {(current || queued) && <span className="ml-auto pl-3 text-caption">{current ? "runs here" : "queued"}</span>}
    </ContextMenuItem>
  );
}

/**
 * "Run in…" for a workspace thread: its workspace's members, the current one disabled.
 * Picking one invokes thread.run-in; the row shows the queued move until it happens.
 */
function RunInMenu({ threadId, workspaceId }: { threadId: string; workspaceId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const pending = useThreadsStore((s) => s.byId[threadId]?.pendingWorktreePath ?? "");
  const members = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.projectId}\u0000${m.worktreePath}`)));
  const wsName = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="menu-run-in">
        <ArrowRightLeft />
        Run in…
      </ContextMenuSubTrigger>
      <ContextMenuSubContent data-testid="menu-run-in-members">
        <ContextMenuLabel>{wsName}</ContextMenuLabel>
        {members.map((k) => {
          const [projectId = "", path = ""] = k.split("\u0000");
          return <MemberItem key={k} threadId={threadId} projectId={projectId} path={path} current={path === cwd} queued={path === pending} />;
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
  const workspaceId = useThreadsStore((s) => s.byId[id]?.workspaceId ?? "");
  // Another thread created it: a row in the sidebar is shown, so it can be handed back.
  const created = useThreadsStore((s) => (s.byId[id]?.createdBy ?? "") !== "");
  return (
    <ContextMenuContent
      data-testid="row-menu"
      data-thread={id}
      onCloseAutoFocus={(e) => {
        // Rename puts an input in the row; closing must not move focus back to the list.
        if (useUiStore.getState().renamingThreadId === id) e.preventDefault();
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
      {workspaceId && <RunInMenu threadId={id} workspaceId={workspaceId} />}
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
      <ContextMenuItem
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
