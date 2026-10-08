import { memo } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  FolderGit2,
  GitBranch,
  Layers,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { basename, terminalLabel } from "@/lib/path";
import type { Row } from "@/lib/tree";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useTerminalsStore } from "@/stores/terminals";

export const ROW_HEIGHT = 26;

interface RowProps {
  row: Row;
  selected: boolean;
  cursor: boolean;
  onActivate: (row: Row, how: "click" | "toggle") => void;
}

function Chevron({ row, onActivate }: { row: Row & { expanded: boolean; hasChildren: boolean }; onActivate: RowProps["onActivate"] }) {
  if (!row.hasChildren) return <span className="size-4 shrink-0" />;
  const Icon = row.expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={row.expanded ? "Collapse" : "Expand"}
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
      onClick={(e) => {
        e.stopPropagation();
        onActivate(row, "toggle");
      }}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function RepoLabel({ repoId }: { repoId: string }) {
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  const slug = useReposStore((s) => s.byId[repoId]?.githubSlug ?? "");
  return (
    <>
      <FolderGit2 className="size-4 shrink-0 text-sky-400/90" aria-hidden />
      <span className="max-w-[80%] shrink-0 truncate font-medium">{name}</span>
      {slug && <span className="min-w-0 truncate text-xs text-muted-foreground">{slug}</span>}
    </>
  );
}

function WorktreeLabel({ repoId, path }: { repoId: string; path: string }) {
  const w = useReposStore((s) => findWorktree(s, repoId, path));
  const branch = w?.branch || (w?.head ? w.head.slice(0, 7) : basename(path));
  const st = w?.status;
  const changes = st ? st.staged + st.modified + st.untracked : 0;
  return (
    <>
      <GitBranch className={cn("size-3.5 shrink-0", w?.isMain ? "text-muted-foreground" : "text-violet-400/90")} aria-hidden />
      <span className="truncate" title={path}>
        {branch}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-[11px] text-muted-foreground tabular-nums">
        {st?.dirty && (
          <span className="flex items-center gap-0.5 text-amber-400" title={`${String(changes)} changed`}>
            <CircleDot className="size-3" aria-label="dirty" />
            {changes > 0 && changes}
          </span>
        )}
        {st && st.ahead > 0 && (
          <span className="flex items-center" title={`${String(st.ahead)} ahead`}>
            <ArrowUp className="size-3" />
            {st.ahead}
          </span>
        )}
        {st && st.behind > 0 && (
          <span className="flex items-center" title={`${String(st.behind)} behind`}>
            <ArrowDown className="size-3" />
            {st.behind}
          </span>
        )}
      </span>
    </>
  );
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
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <TerminalStatusIcon id={id} />
      </span>
      <span className={cn("truncate", exited && "text-muted-foreground")}>{label}</span>
      {prog && <span className="truncate text-xs text-muted-foreground">{prog}</span>}
    </>
  );
}

export const SidebarRow = memo(function SidebarRow({ row, selected, cursor, onActivate }: RowProps) {
  const indent = 8 + row.depth * 14;
  return (
    <div
      id={`row-${row.key}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.kind === "terminal" ? undefined : row.expanded}
      data-row-kind={row.kind}
      data-row-key={row.key}
      data-cursor={cursor || undefined}
      className={cn(
        "flex h-full cursor-default items-center gap-1.5 rounded-md pr-2 text-[13px] select-none",
        selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50",
        cursor && "group-focus:ring-1 group-focus:ring-sidebar-ring group-focus:ring-inset",
      )}
      style={{ paddingLeft: indent }}
      onClick={() => {
        onActivate(row, "click");
      }}
      onDoubleClick={() => {
        if (row.kind !== "terminal") onActivate(row, "toggle");
      }}
    >
      {row.kind === "terminal" ? (
        <TerminalLabel id={row.terminalId} />
      ) : (
        <>
          <Chevron row={row} onActivate={onActivate} />
          {row.kind === "repo" && <RepoLabel repoId={row.repoId} />}
          {row.kind === "worktree" && <WorktreeLabel repoId={row.repoId} path={row.path} />}
          {row.kind === "group" && (
            <>
              <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-muted-foreground">{row.label}</span>
            </>
          )}
        </>
      )}
    </div>
  );
});
