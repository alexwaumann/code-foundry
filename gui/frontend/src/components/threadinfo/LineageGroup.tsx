import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, Bot, CornerLeftUp, Ellipsis, Square } from "lucide-react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { agentName, fmtElapsed } from "@/lib/agents";
import { useNowSelect } from "@/lib/clock";
import { childIds, lineageStatus } from "@/lib/lineage";
import {
  agentRowState,
  childRowState,
  lineageElapsedMs,
  lineageStateWords,
  parentWord,
  splitLineage,
  type LineageRow,
  type LineageRowState,
} from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { useCreator } from "@/stores/lineage";
import { saveSettings, useShowCreatedThreads } from "@/stores/settings";
import { openAgentRun } from "@/stores/subagentActions";
import { useThreadStore } from "@/stores/thread";
import { interruptThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { Group, HOVER_CARD, Row, RowMenu } from "./Row";

const DOT: Record<LineageRowState, string> = {
  working: "text-cf-link",
  attention: "text-cf-warning-text",
  done: "text-cf-success-text",
  failed: "text-cf-error-text",
};

/** The 7px status dot in the icon column. */
function Dot({ state }: { state: LineageRowState }) {
  return (
    <span className={cn("flex size-3.5 items-center justify-center", DOT[state])} data-state={state}>
      <span className="size-1.75 rounded-full bg-current" />
    </span>
  );
}

/** The thread's subagent runs as rows, encoded so an unrelated log update re-renders nothing. */
function useAgentRows(threadId: string): readonly string[] {
  return useThreadStore(
    useShallow((s) =>
      (s.logs[threadId]?.agents ?? []).map((r) =>
        JSON.stringify({
          kind: "agent",
          id: r.id,
          name: agentName(r),
          state: agentRowState(r.status),
          type: r.agentType,
          model: r.model,
          effort: r.effort,
          startedAtMs: r.status === "running" ? (r.resumedAtMs ?? r.startedAtMs) : r.startedAtMs,
          endedAtMs: r.endedAtMs,
          durationMs: r.durationMs,
        } satisfies LineageRow),
      ),
    ),
  );
}

/** The threads created from this one (hidden ones too), encoded like useAgentRows. */
function useChildRows(threadId: string): readonly string[] {
  return useThreadsStore(
    useShallow((s) =>
      childIds(s, threadId).map((id) => {
        const t = s.byId[id];
        const state = childRowState(lineageStatus(t));
        return JSON.stringify({
          kind: "thread",
          id,
          name: t?.name || id,
          state,
          type: t?.branch ?? "",
          model: t?.model ?? "",
          effort: t?.effort ?? "",
          startedAtMs: t?.createdAtMs ?? null,
          endedAtMs: state === "done" || state === "failed" ? (t?.statusChangedAtMs ?? t?.lastActivityAtMs ?? null) : null,
          durationMs: 0,
        } satisfies LineageRow);
      }),
    ),
  );
}

/**
 * A subagent run or a child thread; identical rows. A click opens the run or the thread.
 * A live child thread swaps its elapsed time for a stop square on hover (or while the
 * square has the keyboard), which interrupts it. The square is the row's sibling, laid
 * over the value column, not a button inside the row's own: Enter on it interrupts, it
 * does not open. Subagent runs have none (nothing stops one run).
 */
function LineageItem({ threadId, row, sub = false }: { threadId: string; row: LineageRow; sub?: boolean }) {
  // A finished row's time is fixed: only a live one ticks.
  const live = row.state === "working" || row.state === "attention";
  const now = useNowSelect(1000, (n) => (live ? n : 0));
  const ms = lineageElapsedMs(row, now);
  const elapsed = ms === null ? "" : fmtElapsed(ms);
  const stoppable = row.kind === "thread" && live;
  const open = () => {
    if (row.kind === "agent") void openAgentRun(threadId, row.id);
    else useUiStore.getState().select({ kind: "thread", id: row.id }, { focusPrompt: true });
  };
  const card = (
    <div className={cn(HOVER_CARD, "flex flex-col gap-0.5")}>
      <div className="font-medium">{row.name}</div>
      {row.type && <div className={cn(row.kind === "thread" && "text-code")}>{row.type}</div>}
      {(row.model || row.effort) && <div className="text-cf-text-muted">{[row.model, row.effort].filter(Boolean).join(" · ")}</div>}
      <div className="flex gap-3">
        <span className={DOT[row.state]}>{lineageStateWords[row.state]}</span>
        {elapsed && <span className="ml-auto text-cf-text-muted tabular-nums">{elapsed}</span>}
      </div>
    </div>
  );
  return (
    <div className="group/li relative flex flex-col">
      <Tip label={card} side="left">
        <Row
          sub={sub}
          icon={<Dot state={row.state} />}
          meta={elapsed ? <span className={cn(stoppable && "group-focus-within/li:invisible group-hover/li:invisible")}>{elapsed}</span> : null}
          onActivate={open}
          testId="ti-lineage-row"
          data-kind={row.kind}
          data-id={row.id}
          data-state={row.state}
        >
          {row.name}
        </Row>
      </Tip>
      {stoppable && (
        <Tip label="Interrupt this thread" side="left">
          <button
            type="button"
            aria-label={`Interrupt ${row.name}`}
            className="absolute top-1/2 right-7 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-cf-error-text opacity-0 group-hover/li:opacity-100 hover:bg-cf-text/10 focus-visible:opacity-100 [&_svg]:size-3 [&_svg]:fill-current"
            data-testid="ti-lineage-stop"
            data-id={row.id}
            onClick={(e) => {
              e.stopPropagation();
              void interruptThread(row.id);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
            }}
          >
            <Square aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** The thread's creator: a click goes to it; its state in a word. */
function ParentRow({ threadId }: { threadId: string }) {
  const parent = useCreator(threadId);
  const state = useThreadsStore((s) => (parent ? childRowState(lineageStatus(s.byId[parent.id])) : "done"));
  if (!parent) return null;
  return (
    <Row
      icon={<CornerLeftUp />}
      meta={
        <span className="inline-flex items-center gap-1">
          <ArrowRight aria-hidden />
          {parentWord(state)}
        </span>
      }
      onActivate={
        parent.exists
          ? () => {
              useUiStore.getState().select({ kind: "thread", id: parent.id }, { focusPrompt: true });
            }
          : undefined
      }
      testId="ti-parent"
      data-id={parent.id}
    >
      {parent.name}
    </Row>
  );
}

/** "Lineage · N running" with its menu (Show hidden threads; Archive finished, not built yet). */
function LineageLabel({ running }: { running: number }) {
  const showHidden = useShowCreatedThreads();
  return (
    <Row
      trailing={
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Lineage options"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted hover:bg-cf-text/10 aria-expanded:bg-cf-text/10 [&_svg]:size-3.5"
              data-testid="ti-lineage-menu-trigger"
            >
              <Ellipsis aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <RowMenu testId="ti-lineage-menu" align="end" className="min-w-52">
            <DropdownMenuCheckboxItem
              checked={showHidden}
              className="text-caption text-cf-text"
              data-testid="ti-show-hidden"
              onCheckedChange={(on) =>
                void saveSettings({
                  "threads.show_created_threads": on ? "true" : "false",
                })
              }
            >
              Show hidden threads
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem disabled data-testid="ti-archive-finished">
              Archive finished
            </DropdownMenuItem>
          </RowMenu>
        </DropdownMenu>
      }
      testId="ti-lineage-label"
    >
      <span className="text-cf-text-muted">Lineage{running > 0 && ` · ${String(running)} running`}</span>
    </Row>
  );
}

/**
 * Lineage: the creator first (a child thread), then each running or waiting subagent run
 * and child thread (hidden children too), newest first, then "Previous agents" folding
 * the finished ones. Absent without a creator, runs or children.
 */
export function LineageGroup({ threadId }: { threadId: string }) {
  const hasParent = useThreadsStore((s) => Boolean(s.byId[threadId]?.createdBy));
  const agents = useAgentRows(threadId);
  const children = useChildRows(threadId);
  const { live, previous } = useMemo(() => splitLineage([...agents, ...children].map((r) => JSON.parse(r) as LineageRow)), [agents, children]);
  const [open, setOpen] = useState(false);
  if (!hasParent && agents.length === 0 && children.length === 0) return null;
  return (
    <Group testId="ti-lineage">
      <LineageLabel running={live.length} />
      <ParentRow threadId={threadId} />
      {live.map((r) => (
        <LineageItem key={`${r.kind}:${r.id}`} threadId={threadId} row={r} />
      ))}
      {previous.length > 0 && (
        <Row
          icon={<Bot />}
          meta={previous.length}
          chevron={open ? "open" : "closed"}
          onActivate={() => {
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          testId="ti-previous"
        >
          <span className="text-cf-text-muted">Previous agents</span>
        </Row>
      )}
      {open && previous.map((r) => <LineageItem key={`${r.kind}:${r.id}`} threadId={threadId} row={r} sub />)}
    </Group>
  );
}
