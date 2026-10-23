import { memo, useContext, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, GitBranch, LoaderCircle, RotateCcw, SquareKanban } from "lucide-react";
import type { ThreadItemView } from "@/api/thread";
import { ThreadMarkdown } from "@/components/thread/Code";
import { CodeRunContext } from "@/components/thread/codeContext";
import { KeepRowContext, useThreadCtx } from "@/components/thread/context";
import { TimelineRowView } from "@/components/thread/rows";
import { TimelineList } from "@/components/thread/Timeline";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import {
  buildEmberRows,
  clockTime,
  restartCuts,
  runEndMs,
  runMs,
  shortDuration,
  splitTaskLinks,
  turnEndAfter,
  WORK_ROW_HEIGHT,
  workMs,
  workSummary,
  type EmberRow,
  type RestartRow,
  type WorkRow,
} from "@/lib/ember";
import { decodeTimelineKey } from "@/lib/threadTimeline";
import { cn } from "@/lib/utils";
import { useLinkBranch, useLinkMeta, useLinkTitle, useLinkWaiting } from "@/stores/ember";
import { openEmberBoard } from "@/stores/emberPanel";
import { setRowExpanded, useThreadItem, useThreadStore, useTimelineKeys } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

const NO_EXPANDED: Readonly<Record<string, boolean>> = {};

/** The ids of the thread's wake messages (the daemon's, folded with the work). */
function useWakeIds(threadId: string): string[] {
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      if (!log) return [];
      return log.order.filter((id) => {
        const it = log.byId[id];
        return it?.kind === "user" && it.wake !== undefined;
      });
    }),
  );
}

/**
 * The turn ends where the app's restart cut Ember's turn (lib/ember restartCuts), as
 * "<id> <restart ms>" strings (a shallow-compared list), Ember's status still being the
 * cut ("error", "interrupted") standing in for the marks a later message brings.
 */
function useRestartCuts(threadId: string): string[] {
  const cutNow = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t?.status === "error" && t.statusReason === "interrupted";
  });
  return useThreadStore(useShallow((s) => [...restartCuts(s.logs[threadId], cutNow)].map(([id, at]) => `${id} ${at === null ? "" : String(at)}`)));
}

/** The chat's rows (lib/ember buildEmberRows) from the items' structure; text deltas do not rebuild them. */
function useEmberRows(threadId: string, working: boolean): EmberRow[] {
  const keys = useTimelineKeys(threadId);
  const wakes = useWakeIds(threadId);
  const cutList = useRestartCuts(threadId);
  const expanded = useThreadStore((s) => s.expanded[threadId] ?? NO_EXPANDED);
  const showWork = useUiStore((s) => s.emberShowWork);
  return useMemo(() => {
    const wake = new Set(wakes);
    const cuts = new Map(
      cutList.map((c) => {
        const [id = "", at = ""] = c.split(" ");
        return [id, at === "" ? null : Number(at)] as const;
      }),
    );
    return buildEmberRows(keys.map(decodeTimelineKey), { wake: (id) => wake.has(id), cuts, expanded: (k) => expanded[k], showWork, working });
  }, [keys, wakes, cutList, expanded, showWork, working]);
}

/** A thread's name (a worker Ember sent a change to), from the thread list; "" when unknown. */
function threadName(id: string): string {
  return useThreadsStore.getState().byId[id]?.name ?? "";
}

function estimate(r: EmberRow | undefined): number {
  switch (r?.type) {
    case "user":
      return 72;
    case "etext":
      return 64;
    case "work":
      return WORK_ROW_HEIGHT;
    case "restart":
      return 28;
    default:
      return 26;
  }
}

function renderRow(row: EmberRow) {
  switch (row.type) {
    case "work":
      return <WorkRowView row={row} />;
    case "etext":
      return <EmberText id={row.id} />;
    case "restart":
      return <RestartRowView row={row} />;
    default:
      return <TimelineRowView row={row} />;
  }
}

/**
 * Ember's conversation (docs/notes/ember-3-gui.md): the thread timeline's list and rows,
 * with Ember's rows (lib/ember buildEmberRows): the user's messages and Ember's text show,
 * and every run of work between them is one "Worked for" row, open while "Show work" is on
 * or the user opened it.
 */
export function EmberTimeline({ threadId, working, bottomInset }: { threadId: string; working: boolean; bottomInset: number }) {
  const rows = useEmberRows(threadId, working);
  return <TimelineList threadId={threadId} rows={rows} bottomInset={bottomInset} renderRow={renderRow} estimateRow={estimate} />;
}

type ItemLog = { byId: Readonly<Record<string, ThreadItemView>>; order: readonly string[] } | undefined;

/** The run's items, as the thread's Watch has them. */
function runItems(log: ItemLog, ids: readonly string[]): ThreadItemView[] {
  if (!log) return [];
  return ids.flatMap((id) => {
    const it = log.byId[id];
    return it ? [it] : [];
  });
}

/** A finished run's time (lib/ember runMs): its tools' spans, else its turn's duration. */
function finishedMs(log: ItemLog, ids: readonly string[]): number {
  const run = runItems(log, ids);
  const first = ids[0];
  // Only a run without tools looks for its turn's end (a walk of the log).
  const turn = log && first !== undefined && !run.some((it) => it.kind === "tool") ? turnEndAfter(log, first) : null;
  return runMs(run, turn);
}

/** The live row's clock: ticks while live, frozen otherwise. */
function LiveElapsed({ threadId, ids }: { threadId: string; ids: readonly string[] }) {
  const now = useNow(1000);
  const ms = useThreadStore((s) => workMs(runItems(s.logs[threadId], ids), now));
  const d = shortDuration(ms);
  return d ? (
    <>
      <span className="sep">·</span>
      <span className="tabular-nums">{d}</span>
    </>
  ) : null;
}

/**
 * A run of work folded into one line (the turn header's look, thread.css .thead):
 * "Worked for 2m · read 5 files, created 2 threads, updated the board" behind a chevron
 * that opens the run's ordinary rows below it, in place. Live (Ember is on it): a sky
 * spinner, "Working", what it did so far and the time it has taken.
 */
const WorkRowView = memo(function WorkRowView({ row }: { row: WorkRow }) {
  const { threadId } = useThreadCtx();
  const keep = useContext(KeepRowContext);
  const summary = useThreadStore((s) => workSummary(runItems(s.logs[threadId], row.ids), threadName));
  const ms = useThreadStore((s) => (row.live ? 0 : finishedMs(s.logs[threadId], row.ids)));
  const endMs = useThreadStore((s) => (row.live ? null : runEndMs(runItems(s.logs[threadId], row.ids))));
  const now = useNow(60_000);
  const took = shortDuration(ms);
  const lead = row.live ? null : took ? `Worked for ${took}` : "Worked";
  // When the run ended (the reply after it came), right-aligned like a user message's time.
  const time = endMs === null ? null : (
    <span className="ml-auto shrink-0 pl-3 text-caption-sm text-cf-text-muted tabular-nums" data-testid="ember-work-time">
      {clockTime(endMs, now)}
    </span>
  );
  const body = (
    <>
      <span className="ico">{row.live ? <LoaderCircle className="t-sky animate-spin" aria-hidden /> : <ChevronRight aria-hidden />}</span>
      {row.live ? <span className="shimmer">Working</span> : <span>{lead}</span>}
      {summary && (
        <>
          <span className="sep">·</span>
          <span className="min-w-0 truncate" data-testid="ember-work-summary">
            {summary}
          </span>
        </>
      )}
      {row.live && <LiveElapsed threadId={threadId} ids={row.ids} />}
    </>
  );
  if (row.ids.length === 0)
    return (
      <div className="thead" data-testid="ember-work" data-live>
        <span className="line max-w-full text-caption">{body}</span>
      </div>
    );
  return (
    <div className="thead" data-testid="ember-work" data-live={row.live || undefined} data-expanded={row.expanded || undefined}>
      <button
        type="button"
        className="fold max-w-full text-caption"
        aria-expanded={row.expanded}
        aria-label={row.expanded ? "Hide this work" : "Show this work"}
        onClick={() => {
          keep(row.key);
          setRowExpanded(threadId, row.key, !row.expanded);
        }}
      >
        {body}
      </button>
      {time}
    </div>
  );
});

/**
 * A task link Ember wrote (`[Title](cf-task://t-…)`, alone on its line) as a pointer line:
 * a board glyph, the task's title on the board now (Ember may have renamed it; the link's
 * text while the board does not have it), and where the task is ("in progress · 3 pieces
 * · 2 working", "needs you" in amber while a worker waits on the user, a done task's
 * branch), live. A click opens the Board panel at that task.
 */
export function TaskPointer({ id, name }: { id: string; name: string }) {
  const meta = useLinkMeta(id);
  const waiting = useLinkWaiting(id);
  const title = useLinkTitle(id) || name;
  const branch = useLinkBranch(id);
  return (
    <Tip label="Open on the board">
      <button
        type="button"
        className="my-1.5 flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left text-body-sm text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-2 focus-visible:ring-cf-focus/50"
        data-testid="ember-task-link"
        data-task={id}
        onClick={() => {
          openEmberBoard(id);
        }}
      >
        <SquareKanban className="size-3.5 shrink-0 opacity-80" aria-hidden data-testid="ember-task-link-glyph" />
        <span className="truncate font-medium text-cf-text" data-testid="ember-task-link-title">
          {title}
        </span>
        {meta && (
          <span className={cn("shrink-0 truncate", waiting && "text-cf-warning-text")} data-testid="ember-task-link-meta">
            · {meta}
          </span>
        )}
        {branch && (
          <span className="flex min-w-0 shrink items-center gap-1" data-testid="ember-task-link-branch">
            <span aria-hidden>·</span>
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{branch}</span>
          </span>
        )}
      </button>
    </Tip>
  );
}

/**
 * Where the app's restart cut Ember's turn (lib/ember restartCuts): "Code Foundry restarted
 * at 01:26 while Ember was working", a muted line in place of a bare error.
 */
const RestartRowView = memo(function RestartRowView({ row }: { row: RestartRow }) {
  const now = useNow(60_000);
  const at = row.atMs === null ? "" : ` at ${clockTime(row.atMs, now)}`;
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-1 text-caption text-cf-text-muted" data-testid="ember-restart" role="note">
      <RotateCcw className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        Code Foundry restarted{at} while Ember was working
      </span>
    </div>
  );
});

/** Ember's text: plain markdown (no bubble, no glyph), its task links as pointer lines. */
const EmberText = memo(function EmberText({ id }: { id: string }) {
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
  const text = it?.kind === "text" ? it.text : "";
  const streaming = it?.kind === "text" && it.streaming;
  const parts = useMemo(() => splitTaskLinks(text), [text]);
  // Its shell blocks offer Run in terminal, as in any thread (CodeActions).
  const run = useMemo(() => ({ threadId, text, streaming }), [threadId, text, streaming]);
  if (it?.kind !== "text") return null;
  return (
    <div className="a-md final selectable" data-testid="ember-text" data-streaming={streaming || undefined}>
      <CodeRunContext.Provider value={run}>
        {parts.map((p, i) =>
          p.kind === "md" ? (
            <ThreadMarkdown key={i} className={streaming && i === parts.length - 1 ? "cf-streaming" : undefined}>
              {p.text}
            </ThreadMarkdown>
          ) : (
            <TaskPointer key={i} id={p.id} name={p.title} />
          ),
        )}
      </CodeRunContext.Provider>
    </div>
  );
});
