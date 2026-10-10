import { useShallow } from "zustand/react/shallow";
import { ArrowRightLeft, FolderGit2, GitFork, Pencil, Pin, PinOff, Plug, Power, SquareTerminal, Trash2 } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { beginRename } from "@/keys/bindings";
import { worktreeBranch } from "@/lib/threadRow";
import type { LeafRow } from "@/lib/tree";
import { runCommand } from "@/stores/commands";
import { getUiContext } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { closeSession, forkSession, pinSession, reconnectSession, removeSession, runSessionIn, sessionContext } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { showWorktreeInThread } from "@/stores/worktreePanel";

function MemberItem({ sessionId, repoId, path, current, queued }: { sessionId: string; repoId: string; path: string; current: boolean; queued: boolean }) {
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  const branch = useReposStore((s) => worktreeBranch(s, repoId, path));
  return (
    <ContextMenuItem
      disabled={current}
      data-member={repoId}
      onSelect={() => {
        void runSessionIn(sessionId, repoId);
      }}
    >
      <FolderGit2 className="text-sky-400/90" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{branch}</span>
      </span>
      {(current || queued) && <span className="ml-auto pl-3 text-xs text-muted-foreground">{current ? "runs here" : "queued"}</span>}
    </ContextMenuItem>
  );
}

/**
 * "Run in…" for a workspace thread: its workspace's members, the current one disabled.
 * Picking one invokes session.run-in; the row shows the queued move until it happens.
 */
function RunInMenu({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
  const cwd = useSessionsStore((s) => s.byId[sessionId]?.worktreePath ?? "");
  const pending = useSessionsStore((s) => s.byId[sessionId]?.pendingWorktreePath ?? "");
  const members = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.repoId}\u0000${m.worktreePath}`)));
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
          const [repoId = "", path = ""] = k.split("\u0000");
          return <MemberItem key={k} sessionId={sessionId} repoId={repoId} path={path} current={path === cwd} queued={path === pending} />;
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function ThreadMenu({ id }: { id: string }) {
  const pinned = useSessionsStore((s) => s.byId[id]?.pinned ?? false);
  const state = useSessionsStore((s) => s.byId[id]?.state ?? "unknown");
  const workspaceId = useSessionsStore((s) => s.byId[id]?.workspaceId ?? "");
  return (
    <ContextMenuContent
      data-testid="row-menu"
      data-session={id}
      onCloseAutoFocus={(e) => {
        // Rename puts an input in the row; closing must not move focus back to the list.
        if (useUiStore.getState().renamingSessionId === id) e.preventDefault();
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
          void pinSession(id, !pinned);
        }}
      >
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      {workspaceId && <RunInMenu sessionId={id} workspaceId={workspaceId} />}
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void runCommand("terminal.new", {}, sessionContext(id));
        }}
      >
        <SquareTerminal />
        New terminal here
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          showWorktreeInThread(id);
        }}
      >
        <FolderGit2 />
        Show worktree
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void forkSession(id);
        }}
      >
        <GitFork />
        Fork
      </ContextMenuItem>
      {state === "disconnected" ? (
        <ContextMenuItem
          onSelect={() => {
            void reconnectSession(id);
          }}
        >
          <Plug />
          Reconnect
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          disabled={state !== "connected"}
          onSelect={() => {
            void closeSession(id);
          }}
        >
          <Power />
          Close
        </ContextMenuItem>
      )}
      <ContextMenuItem
        variant="destructive"
        onSelect={() => {
          void removeSession(id);
        }}
      >
        <Trash2 />
        Remove…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function TerminalMenu({ id }: { id: string }) {
  const running = useTerminalsStore((s) => s.byId[id]?.state === "running");
  const ctx = () => getUiContext({ kind: "terminal", id });
  return (
    <ContextMenuContent data-testid="row-menu" data-terminal={id}>
      {running ? (
        <ContextMenuItem
          variant="destructive"
          onSelect={() => {
            void runCommand("terminal.kill", {}, ctx());
          }}
        >
          <Power />
          Kill…
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          onSelect={() => {
            void runCommand("terminal.remove", {}, ctx());
          }}
        >
          <Trash2 />
          Remove
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

/** The context menu of a sidebar row. Every item is a registry command (or the inline rename that commits one). */
export function RowMenu({ row }: { row: LeafRow }) {
  return row.kind === "session" ? <ThreadMenu id={row.sessionId} /> : <TerminalMenu id={row.terminalId} />;
}
