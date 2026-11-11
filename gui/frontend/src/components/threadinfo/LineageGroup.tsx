import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, Bot, CornerLeftUp, Square } from "lucide-react";
import { ThreadPlaceRows } from "@/components/thread/ThreadPlaceRows";
import { Tip } from "@/components/ui/tooltip";
import { agentName } from "@/lib/agents";
import { formatDuration } from "@/lib/duration";
import { useNowSelect } from "@/lib/clock";
import { childIds, lineageStatus } from "@/lib/lineage";
import { canonicalModelName } from "@/lib/models";
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
import { useCreator, useLiveCount } from "@/stores/lineage";
import { useModelChoices } from "@/stores/settings";
import { goUpFromSubagent, openAgentRun } from "@/stores/subagentActions";
import { useThreadStore } from "@/stores/thread";
import { interruptThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { Group, HOVER_CARD, Row } from "./Row";

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

/** The threads created from this one, encoded like useAgentRows. */
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
          type: "",
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
 * does not open. Subagent runs have none (nothing stops one run). The hover card opens at
 * once (delay 0) like the sidebar's, and names the model as the app does (canonicalModelName):
 * a run that asked for none used its thread's model, as the subagent view says. A child
 * thread's card also says where it works; a run's does not, as the daemon records no cwd per
 * run and its thread's place could be wrong (docs/notes/lineage-card-place.md). `inert`: a
 * row that opens nothing, only its hover card (a run's own runs: the stream never carries
 * their work).
 */
function LineageItem({ threadId, row, sub = false, inert = false }: { threadId: string; row: LineageRow; sub?: boolean; inert?: boolean }) {
  // A finished row's time is fixed: only a live one ticks.
  const live = row.state === "working" || row.state === "attention";
  const now = useNowSelect(1000, (n) => (live ? n : 0));
  const ms = lineageElapsedMs(row, now);
  const elapsed = ms === null ? "" : formatDuration(ms, { hours: true, minutes: true, seconds: true });
  const stoppable = row.kind === "thread" && live;
  const choices = useModelChoices();
  const threadModel = useThreadsStore((s) => (row.kind === "agent" ? (s.byId[threadId]?.model ?? "") : ""));
  const modelId = row.model || threadModel;
  const model = modelId ? canonicalModelName(choices, modelId) : "";
  const open = () => {
    if (row.kind === "agent") void openAgentRun(threadId, row.id);
    else useUiStore.getState().select({ kind: "thread", id: row.id }, { focusPrompt: true });
  };
  const card = (
    <div className={cn(HOVER_CARD, "flex flex-col gap-0.5")}>
      <div className="font-medium">{row.name}</div>
      {row.type && <div>{row.type}</div>}
      {(model || row.effort) && (
        <div className="text-cf-text-muted" data-testid="ti-lineage-model">
          {[model, row.effort].filter(Boolean).join(" · ")}
        </div>
      )}
      {row.kind === "thread" && (
        <div className="my-1 border-y border-cf-divider py-1" data-testid="ti-lineage-place">
          <ThreadPlaceRows id={row.id} worktreeBranchOnly />
        </div>
      )}
      <div className="flex gap-3">
        <span className={DOT[row.state]}>{lineageStateWords[row.state]}</span>
        {elapsed && <span className="ml-auto text-cf-text-muted tabular-nums">{elapsed}</span>}
      </div>
    </div>
  );
  return (
    <div className="group/li relative flex flex-col">
      <Tip label={card} side="left" delay={0}>
        <Row
          sub={sub}
          icon={<Dot state={row.state} />}
          meta={elapsed ? <span className={cn(stoppable && "group-focus-within/li:invisible group-hover/li:invisible")}>{elapsed}</span> : null}
          hoverable={inert}
          onActivate={inert ? undefined : open}
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
            className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-cf-error-text opacity-0 group-hover/li:opacity-100 hover:bg-cf-text/10 focus-visible:opacity-100 [&_svg]:size-3 [&_svg]:fill-current"
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

/**
 * "Lineage · N running". N is the sidebar
 * badge's live count (lib/liveCount: background subagents plus live child threads), so the
 * two always agree; a foreground run listed here is the busy tool, not counted.
 */
function LineageLabel({ threadId }: { threadId: string }) {
  const running = useLiveCount(threadId);
  return (
    <Row testId="ti-lineage-label">
      <span className="text-cf-text-muted">Lineage{running > 0 && ` · ${String(running)} running`}</span>
    </Row>
  );
}

/** The rows under the label: the live ones, then "Previous agents" folding the finished ones. */
function LineageRows({ threadId, rows, inert = false }: { threadId: string; rows: readonly string[]; inert?: boolean }) {
  const { live, previous } = useMemo(() => splitLineage(rows.map((r) => JSON.parse(r) as LineageRow)), [rows]);
  const [open, setOpen] = useState(false);
  return (
    <>
      {live.map((r) => (
        <LineageItem key={`${r.kind}:${r.id}`} threadId={threadId} row={r} inert={inert} />
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
      {open && previous.map((r) => <LineageItem key={`${r.kind}:${r.id}`} threadId={threadId} row={r} sub inert={inert} />)}
    </>
  );
}

/**
 * Lineage: the creator first (a child thread), then each running or waiting subagent run
 * and child thread, newest first, then "Previous agents" folding
 * the finished ones. Absent without a creator, runs or children.
 */
export function LineageGroup({ threadId }: { threadId: string }) {
  const hasParent = useThreadsStore((s) => Boolean(s.byId[threadId]?.createdBy));
  const agents = useAgentRows(threadId);
  const children = useChildRows(threadId);
  const rows = useMemo(() => [...agents, ...children], [agents, children]);
  if (!hasParent && rows.length === 0) return null;
  return (
    <Group testId="ti-lineage">
      <LineageLabel threadId={threadId} />
      <ParentRow threadId={threadId} />
      <LineageRows threadId={threadId} rows={rows} />
    </Group>
  );
}

/**
 * A subagent's Lineage (its read-only card): the thread it reports to with that thread's
 * state, a click going back up, then the runs this one started. Those rows open nothing:
 * a run's own runs have no view. No menu: nothing here acts on a thread.
 */
export function RunLineageGroup({ threadId, runId }: { threadId: string; runId: string }) {
  const name = useThreadsStore((s) => s.byId[threadId]?.name || threadId);
  const state = useThreadsStore((s) => childRowState(lineageStatus(s.byId[threadId])));
  const all = useAgentRows(threadId);
  const parents = useThreadStore(useShallow((s) => (s.logs[threadId]?.agents ?? []).map((r) => r.parentId)));
  const rows = useMemo(() => all.filter((_, i) => parents[i] === runId), [all, parents, runId]);
  const running = useMemo(() => rows.filter((r) => (JSON.parse(r) as LineageRow).state === "working").length, [rows]);
  return (
    <Group testId="ti-lineage">
      <Row testId="ti-lineage-label">
        <span className="text-cf-text-muted">Lineage{running > 0 && ` · ${String(running)} running`}</span>
      </Row>
      <Row
        icon={<CornerLeftUp />}
        meta={
          <span className="inline-flex items-center gap-1">
            <ArrowRight aria-hidden />
            {parentWord(state)}
          </span>
        }
        onActivate={() => void goUpFromSubagent()}
        testId="ti-parent"
        data-id={threadId}
      >
        {name}
      </Row>
      <LineageRows threadId={threadId} rows={rows} inert />
    </Group>
  );
}
