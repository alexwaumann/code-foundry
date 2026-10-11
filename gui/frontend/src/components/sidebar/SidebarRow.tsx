import { memo, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ArrowRightLeft, Folder, FolderGit2, GitBranch, Layers, Pin, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CLAUDE_ORANGE, ClaudeMark } from "@/components/icons/ClaudeMark";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { basename, terminalLabel } from "@/lib/path";
import { sessionBadge } from "@/lib/session";
import { showsPlace, statusLine, statusText, statusTones, type StatusLine, type StatusTone } from "@/lib/statusLine";
import { modelLabel, terminalPlace, threadRowModel, type RepoLookup, type WorkspaceLookup } from "@/lib/threadRow";
import { WORKTREE_LABEL, type Row } from "@/lib/tree";
import { useReposStore } from "@/stores/repos";
import { renameSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RowTooltipsEnabled } from "./rowTooltips";
import { openWorkspaceSurface } from "@/stores/workspacePanel";
import { openLinkedPrsSurface } from "@/stores/linkedPrsPanel";
import { prBadge } from "@/surfaces/linkedprsTarget";

interface RowProps {
  row: Row;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: Row, how: "click") => void;
}

/** A small muted chip on a row's first line ("fullscreen", "exited"). */
function Chip({ children, className, ...props }: { children: ReactNode; className?: string; "aria-label"?: string; "data-testid"?: string }) {
  return (
    <span className={cn("shrink-0 rounded-[3px] bg-foreground/8 px-1 text-[10px] leading-4 font-medium text-muted-foreground", className)} {...props}>
      {children}
    </span>
  );
}

/** What a terminal row's first line says about its process: full screen, exited, or nothing while it runs. */
function TerminalState({ id }: { id: string }) {
  const state = useTerminalsStore((s) => s.byId[id]?.state ?? "unknown");
  const exitCode = useTerminalsStore((s) => s.byId[id]?.exitCode ?? 0);
  const alt = useTerminalsStore((s) => s.byId[id]?.altScreen ?? false);
  if (state === "exited") {
    return exitCode === 0 ? (
      <Chip aria-label="exited" data-testid="terminal-state">
        exited
      </Chip>
    ) : (
      <Chip className="bg-red-500/15 text-red-600 dark:text-red-300" aria-label={`exited ${String(exitCode)}`} data-testid="terminal-state">
        exit {exitCode}
      </Chip>
    );
  }
  if (state === "running" && alt) {
    return (
      <Chip aria-label="running (full screen)" data-testid="terminal-state">
        fullscreen
      </Chip>
    );
  }
  return null;
}

/** A terminal no thread owns: its title, the program, its state, and where it runs. */
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
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn("truncate", exited && "text-muted-foreground")} data-testid="terminal-name">
          {label}
        </span>
        {prog && <span className="truncate text-xs text-muted-foreground">{prog}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
          <TerminalState id={id} />
        </span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground" data-testid="row-place">
        {place}
      </span>
    </span>
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

/** "N PRs" when the thread linked pull requests; nothing otherwise. */
function LinkedPrsBadge({ id }: { id: string }) {
  const count = useSessionsStore((st) => st.byId[id]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  return (
    // Like the workspace badge: a click opens the Linked PRs surface in the thread's side
    // panel, and goes on to the row, which selects the thread (and so shows that panel).
    <span
      className="flex shrink-0 cursor-pointer items-center rounded-sm bg-emerald-500/15 px-1 text-[10px] leading-4 font-medium text-emerald-700 tabular-nums hover:bg-emerald-500/30 dark:text-emerald-300"
      title={`${prBadge(count)} linked: show them in the side panel`}
      data-testid="row-linked-prs"
      onClick={() => {
        openLinkedPrsSurface({ kind: "session", id });
      }}
    >
      {prBadge(count)}
    </span>
  );
}

/** The project, branch and queued move of a thread, each from a narrow selector over threadRowModel. */
function useThreadPlace(id: string) {
  const s = useSessionsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: x?.workspaceId ?? "", pendingWorktreePath: x?.pendingWorktreePath ?? "" };
    }),
  );
  // Each selector returns a primitive, so a row only re-renders when its own project,
  // branch, workspace or move changes.
  const ws = useWorkspacesStore((st) => (s.workspaceId ? st.byId[s.workspaceId] : undefined));
  const project = useReposStore((st) => threadRowModel(s, st, NO_WORKSPACES).project);
  const branch = useReposStore((st) => threadRowModel(s, st, NO_WORKSPACES).branch);
  const noGit = useReposStore((st) => threadRowModel(s, st, NO_WORKSPACES).noGit);
  const movingTo = useReposStore((st) => threadRowModel(s, st, { byId: ws ? { [s.workspaceId]: ws } : {} }).movingTo);
  return { project, branch, noGit, movingTo };
}

/** Tailwind colours for the status text: the sketch's sky / amber / emerald / red 400s, darker in light mode. */
const toneClasses: Readonly<Record<StatusTone, string>> = {
  muted: "",
  sky: "text-sky-600 dark:text-sky-400",
  amber: "text-amber-600 dark:text-amber-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  red: "text-red-600 dark:text-red-400",
};

/** Status text with a relative time; only these rows subscribe to the shared 30 s clock. */
function TimedStatusText({ line }: { line: StatusLine }) {
  const now = useNow(30_000);
  return <>{statusText(line, now)}</>;
}

/**
 * The thread's second line (lib/statusLine): what it is doing or waiting on, coloured, and
 * "project · branch" where the status leaves room for it (working, idle, offline). A queued
 * "Run in…" move replaces it until the thread's worktree changes.
 */
function ThreadLine({ id }: { id: string }) {
  const line = useSessionsStore(useShallow((st) => statusLine(st.byId[id])));
  const badge = useSessionsStore((st) => sessionBadge(st.byId[id]));
  const { project, branch, noGit, movingTo } = useThreadPlace(id);
  const status = line.kind !== "place";
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" data-testid="row-place" data-status-line={line.kind} data-session-badge={badge}>
      {movingTo !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-amber-300" data-testid="row-moving" title={`Runs in ${movingTo} once it is idle at its prompt (/cd)`}>
          <ArrowRightLeft className="size-3 shrink-0" aria-hidden />
          <span className="truncate">moving to {movingTo}…</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          {status && (
            <span className={toneClasses[statusTones[line.kind]]} data-testid="row-status">
              {line.at !== null ? <TimedStatusText line={line} /> : statusText(line, 0)}
            </span>
          )}
          {showsPlace(line.kind) && (
            <>
              {status && <span aria-hidden> · </span>}
              <span data-testid="row-project">{project}</span>
              <span aria-hidden> · </span>
              {noGit ? (
                <NoGitBadge className="align-[1px]" />
              ) : (
                <span className="font-mono" data-testid="row-branch">
                  {branch}
                </span>
              )}
            </>
          )}
        </span>
      )}
    </span>
  );
}

function SessionLabel({ id }: { id: string }) {
  // Unnamed until the daemon names it from the first prompt: the id stands in.
  const name = useSessionsStore((s) => s.byId[id]?.name ?? "");
  const pinned = useSessionsStore((s) => s.byId[id]?.pinned ?? false);
  const offline = useSessionsStore((s) => s.byId[id]?.state === "disconnected");
  const renaming = useUiStore((s) => s.renamingSessionId === id);
  return (
    // An offline (disconnected) thread is dimmed as a whole; its text is otherwise the same.
    <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", offline && "opacity-50")} data-testid="session-body" data-offline={offline || undefined}>
      <span className="flex min-w-0 items-center gap-1.5">
        {renaming ? (
          <RenameField id={id} name={name} />
        ) : (
          <>
            <span className={cn("truncate", !name && "text-muted-foreground")} data-testid="session-name">
              {name || id}
            </span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 pl-1">
              <LinkedPrsBadge id={id} />
              <WorkspaceBadge id={id} />
              {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="pinned" data-testid="row-pinned" />}
            </span>
          </>
        )}
      </span>
      <ThreadLine id={id} />
    </span>
  );
}

/** One line of the thread tooltip: an icon, the text, and an optional muted chip on the right. */
function TipRow({ icon, chip, children, testId }: { icon: ReactNode; chip?: string | null; children: ReactNode; testId: string }) {
  return (
    <div className="flex items-center gap-2 leading-5" data-testid={testId}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {chip && (
        <Chip className="ml-auto" data-testid={`${testId}-chip`}>
          {chip}
        </Chip>
      )}
    </div>
  );
}

function TipIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** The tooltip's body: name, project, branch (git only) and model. Mounted only while open. */
function ThreadTipBody({ id }: { id: string }) {
  const name = useSessionsStore((s) => s.byId[id]?.name ?? "");
  const model = useSessionsStore((s) => s.byId[id]?.model ?? "");
  const effort = useSessionsStore((s) => s.byId[id]?.effort ?? "");
  const where = useSessionsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return { repoId: x?.repoId ?? "", worktreePath: x?.worktreePath ?? "", workspaceId: "", pendingWorktreePath: "" };
    }),
  );
  const m = useReposStore(
    useShallow((st) => {
      const r = threadRowModel(where, st, NO_WORKSPACES);
      return { project: r.project, branch: r.branch, noGit: r.noGit, worktree: r.worktree };
    }),
  );
  return (
    <>
      <div className="mb-[5px] truncate text-[13px] font-semibold" data-testid="tip-name">
        {name || id}
      </div>
      <TipRow icon={<TipIcon icon={m.noGit ? Folder : FolderGit2} />} chip={m.noGit ? "no git" : null} testId="tip-project">
        {m.project}
      </TipRow>
      {!m.noGit && (
        <TipRow icon={<TipIcon icon={GitBranch} />} chip={m.worktree ? "worktree" : null} testId="tip-branch">
          <span className="font-mono">{m.branch}</span>
        </TipRow>
      )}
      <TipRow icon={<ClaudeMark className="size-3.5 shrink-0" style={{ color: CLAUDE_ORANGE }} />} testId="tip-model">
        {modelLabel(model)}
        {effort && <span className="text-muted-foreground"> ({effort})</span>}
      </TipRow>
    </>
  );
}

/**
 * A thread row's hover tooltip (the provider in Sidebar sets the 500 ms delay). Pointer
 * only: the rows are not focusable (the list uses aria-activedescendant), so keyboard
 * navigation never opens it; a click or right-click closes it. Not while renaming.
 */
function ThreadTooltip({ id, children }: { id: string; children: ReactElement }) {
  const enabled = useContext(RowTooltipsEnabled);
  const renaming = useUiStore((s) => s.renamingSessionId === id);
  const [open, setOpen] = useState(false);
  const allowed = enabled && !renaming;
  return (
    <Tooltip
      open={open && allowed}
      onOpenChange={(o) => {
        setOpen(o && allowed);
      }}
      disableHoverableContent
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" align="start" sideOffset={12} className="w-[220px] px-2.5 py-2 text-xs" data-testid="thread-tooltip" data-session-id={id}>
        <ThreadTipBody id={id} />
      </TooltipContent>
    </Tooltip>
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
  const el = (
    <div
      id={`row-${row.key}`}
      role="option"
      aria-selected={selected}
      data-row-kind={row.kind}
      data-row-key={row.key}
      data-section={row.section}
      data-cursor={cursor || undefined}
      className={cn(
        "group/row flex h-full cursor-default items-center gap-1.5 rounded-md px-2 text-[13px] select-none",
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
  return row.kind === "session" ? <ThreadTooltip id={row.sessionId}>{el}</ThreadTooltip> : el;
});
