import { memo, useEffect, useRef } from "react";
import { AppWindow, ArrowRightLeft, Circle, CircleCheck, CircleX, Layers, Pin, SquareTerminal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SessionStatusIcon } from "@/components/session/SessionStatusIcon";
import { cn } from "@/lib/utils";
import { basename, terminalLabel } from "@/lib/path";
import { sessionBadge } from "@/lib/session";
import { terminalPlace, threadRowModel, type RepoLookup, type WorkspaceLookup } from "@/lib/threadRow";
import { WORKTREE_LABEL, type Row } from "@/lib/tree";
import { useReposStore } from "@/stores/repos";
import { renameSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { openWorkspaceSurface } from "@/stores/workspacePanel";

interface RowProps {
  row: Row;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: Row, how: "click") => void;
}

function TerminalStatusIcon({ id }: { id: string }) {
  const state = useTerminalsStore((s) => s.byId[id]?.state ?? "unknown");
  const exitCode = useTerminalsStore((s) => s.byId[id]?.exitCode ?? 0);
  const alt = useTerminalsStore((s) => s.byId[id]?.altScreen ?? false);
  if (state === "exited") {
    return exitCode === 0 ? (
      <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" aria-label="exited" />
    ) : (
      <CircleX className="size-3.5 shrink-0 text-red-400" aria-label={`exited ${String(exitCode)}`} />
    );
  }
  if (state === "running") {
    return alt ? (
      <AppWindow className="size-3.5 shrink-0 text-emerald-400" aria-label="running (full screen)" />
    ) : (
      <Circle className="size-2.5 shrink-0 fill-emerald-400 text-emerald-400" aria-label="running" />
    );
  }
  return <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** A terminal no thread owns: a terminal glyph, its title, and where it runs. */
function TerminalLabel({ id }: { id: string }) {
  const label = useTerminalsStore((s) => {
    const t = s.byId[id];
    return t ? terminalLabel(t) : id;
  });
  const prog = useTerminalsStore((s) => {
    const t = s.byId[id];
    return t?.title && t.argv[0] ? basename(t.argv[0]) : "";
  });
  const exited = useTerminalsStore((s) => s.byId[id]?.state === "exited");
  const where = useTerminalsStore(useShallow((s) => ({ cwd: s.byId[id]?.cwd ?? "", worktreeLabel: s.byId[id]?.labels[WORKTREE_LABEL] ?? "" })));
  const place = useReposStore((s) => terminalPlace(s, where));
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center self-start pt-0.5">
        <TerminalStatusIcon id={id} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-label="terminal" />
          <span className={cn("truncate", exited && "text-muted-foreground")} data-testid="terminal-name">
            {label}
          </span>
          {prog && <span className="truncate text-xs text-muted-foreground">{prog}</span>}
        </span>
        <span className="truncate text-[11px] text-muted-foreground" data-testid="row-place">
          {place}
        </span>
      </span>
    </>
  );
}

/** Inline name editor; Enter or blur commits via session.rename, Escape cancels. */
function RenameField({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value.trim() ?? "";
    useUiStore.getState().setRenaming(null);
    if (commit && value && value !== name) void renameSession(id, value);
    if (returnTo.current instanceof HTMLElement && returnTo.current.isConnected) returnTo.current.focus();
    else useUiStore.getState().focusSidebar();
  };
  return (
    <input
      ref={ref}
      autoFocus
      defaultValue={name}
      aria-label="Thread name"
      data-testid="rename-input"
      className="h-5 min-w-0 flex-1 rounded-sm border border-sidebar-ring bg-background px-1 text-[13px] outline-none"
      onClick={(e) => {
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}

const NO_REPOS: RepoLookup = { byId: {} };
const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/** The badge of the workspace that owns the thread; nothing for a project thread. */
function WorkspaceBadge({ id }: { id: string }) {
  const s = useSessionsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: "" };
    }),
  );
  const workspace = useWorkspacesStore((st) => threadRowModel(s, NO_REPOS, st).workspace);
  if (workspace === null) return null;
  return (
    // A click opens the workspace surface in the thread's side panel; the click goes on
    // to the row, which selects the thread (and so shows that panel).
    <span
      className="flex max-w-24 min-w-0 cursor-pointer items-center gap-0.5 rounded-sm bg-violet-400/15 px-1 text-[10px] leading-4 font-medium text-violet-300 hover:bg-violet-400/30"
      title={`Workspace ${workspace}: show its members in the side panel`}
      data-testid="row-workspace"
      onClick={() => {
        openWorkspaceSurface({ kind: "session", id });
      }}
    >
      <Layers className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{workspace}</span>
    </span>
  );
}

/**
 * The thread's second line: the project and branch it runs in, or a queued "Run in…"
 * move until the thread's worktree changes.
 */
function ThreadPlace({ id }: { id: string }) {
  const s = useSessionsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: x?.pendingWorktreePath ?? "" };
    }),
  );
  // Narrow selectors over the one tested model: each returns a string, so a row only
  // re-renders when its own project, branch, workspace or move changes.
  const ws = useWorkspacesStore((st) => (s.workspaceId ? st.byId[s.workspaceId] : undefined));
  const project = useReposStore((st) => threadRowModel(s, st, NO_WORKSPACES).project);
  const branch = useReposStore((st) => threadRowModel(s, st, NO_WORKSPACES).branch);
  const movingTo = useReposStore((st) => threadRowModel(s, st, { byId: ws ? { [s.workspaceId]: ws } : {} }).movingTo);
  const m = { project, branch, movingTo };
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" data-testid="row-place">
      {m.movingTo !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-amber-300" data-testid="row-moving" title={`Runs in ${m.movingTo} once it is idle at its prompt (/cd)`}>
          <ArrowRightLeft className="size-3 shrink-0" aria-hidden />
          <span className="truncate">moving to {m.movingTo}…</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          <span data-testid="row-project">{m.project}</span>
          <span aria-hidden> · </span>
          <span className="font-mono" data-testid="row-branch">
            {m.branch}
          </span>
        </span>
      )}
    </span>
  );
}

function SessionLabel({ id }: { id: string }) {
  // Unnamed until the daemon names it from the first prompt: the id stands in.
  const name = useSessionsStore((s) => s.byId[id]?.name ?? "");
  const model = useSessionsStore((s) => s.byId[id]?.model ?? "");
  const pinned = useSessionsStore((s) => s.byId[id]?.pinned ?? false);
  const disconnected = useSessionsStore((s) => s.byId[id]?.state === "disconnected");
  const attention = useSessionsStore((s) => sessionBadge(s.byId[id]) === "attention");
  const renaming = useUiStore((s) => s.renamingSessionId === id);
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center self-start pt-0.5">
        <SessionStatusIcon id={id} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          {renaming ? (
            <RenameField id={id} name={name} />
          ) : (
            <>
              <span className={cn("truncate", (disconnected || !name) && "text-muted-foreground", attention && "font-medium text-amber-200")} data-testid="session-name">
                {name || id}
              </span>
              {model && <span className="shrink-0 truncate text-xs text-muted-foreground">{model}</span>}
              <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1">
                <WorkspaceBadge id={id} />
                {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="pinned" data-testid="row-pinned" />}
              </span>
            </>
          )}
        </span>
        <ThreadPlace id={id} />
      </span>
    </>
  );
}

function HeaderLabel({ label }: { label: string }) {
  return <span className="truncate pt-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>;
}

export const SidebarRow = memo(function SidebarRow({ row, selected, cursor, onActivate }: RowProps) {
  if (row.kind === "header") {
    return (
      <div id={`row-${row.key}`} role="presentation" data-row-kind="header" data-row-key={row.key} className="flex h-full items-end px-2 pb-1 select-none">
        <HeaderLabel label={row.label} />
      </div>
    );
  }
  return (
    <div
      id={`row-${row.key}`}
      role="option"
      aria-selected={selected}
      data-row-kind={row.kind}
      data-row-key={row.key}
      data-section={row.section}
      data-cursor={cursor || undefined}
      className={cn(
        "group/row flex h-full cursor-default items-center gap-1.5 rounded-md pr-2 pl-2 text-[13px] select-none",
        selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50",
        cursor && "group-focus:ring-1 group-focus:ring-sidebar-ring group-focus:ring-inset",
      )}
      onClick={() => {
        onActivate(row, "click");
      }}
      onDoubleClick={() => {
        if (row.kind === "session") useUiStore.getState().setRenaming(row.sessionId);
      }}
    >
      {row.kind === "terminal" ? <TerminalLabel id={row.terminalId} /> : <SessionLabel id={row.sessionId} />}
    </div>
  );
});
