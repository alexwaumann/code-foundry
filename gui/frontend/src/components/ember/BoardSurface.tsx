import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EmberTaskView } from "@/api/ember";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { boardSections, cardMeta, cardProgress, workerRows, type BoardCard, type TaskDot, type WorkerRow } from "@/lib/ember";
import type { StatusTone } from "@/lib/statusLine";
import { shortAge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { holdEmberBoard, useBoardCounts, useEmberStore, useEmberTasks } from "@/stores/ember";
import { useUiStore } from "@/stores/ui";
import { Flame } from "./Flame";

/** Done today shows this many cards until "+N more" is clicked. */
const DONE_CAP = 10;

const DOT: Readonly<Record<TaskDot, string>> = {
  doing: "bg-info shadow-[0_0_0_3px_color-mix(in_oklab,var(--info)_25%,transparent)]",
  blocked: "bg-warning",
  done: "bg-success",
  open: "border-[1.5px] border-muted-foreground opacity-70",
};

/** The sidebar's status colours, muted for "muted". */
const TONE: Readonly<Record<StatusTone, string>> = {
  muted: "text-muted-foreground",
  sky: "text-info",
  amber: "text-warning",
  emerald: "text-success",
  red: "text-destructive",
};

function Dot({ dot, className }: { dot: TaskDot; className?: string }) {
  return <span className={cn("block size-2 shrink-0 rounded-full", DOT[dot], className)} data-dot={dot} aria-hidden />;
}

/** Opens a worker thread, as a Threads tab row does (it is a hidden child of Ember's). */
function openThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
}

/** A worker under a card: its dot, the subtask's title or the worker's name, its report or status, and its age. */
function WorkerLine({ row, now }: { row: WorkerRow; now: number }) {
  const body = (
    <>
      <Dot dot={row.dot} />
      <span className="min-w-0 flex-1 truncate text-foreground/90">{row.title}</span>
      <Tip label={row.meta.text} whenTruncated>
        <span className={cn("max-w-[55%] min-w-0 shrink truncate", TONE[row.meta.tone])} data-testid="ember-worker-meta">
          {row.meta.text}
        </span>
      </Tip>
      {row.atMs !== null && <span className="shrink-0 text-muted-foreground tabular-nums">{shortAge(row.atMs, now)}</span>}
    </>
  );
  const cls = cn("flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-caption", row.subtask && row.threadId === "" && "cursor-default");
  if (row.threadId === "")
    return (
      <div className={cls} data-testid="ember-worker" data-subtask={row.subtask || undefined}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      className={cn(cls, "cursor-pointer outline-none hover:bg-accent/50 focus-visible:bg-accent/50")}
      data-testid="ember-worker"
      data-thread={row.threadId}
      data-subtask={row.subtask || undefined}
      onClick={() => {
        openThread(row.threadId);
      }}
    >
      {body}
    </button>
  );
}

/** A task's card: dot, title, "x of y" or its worker's status, a progress bar for a parent, a blocked task's outcome, its workers. */
function TaskCard({ card, now, focused }: { card: BoardCard; now: number; focused: string | null }) {
  const t = card.task;
  const meta = cardMeta(card);
  const progress = cardProgress(card);
  const rows = workerRows(card);
  return (
    <li
      className={cn("rounded-lg border border-pane-border px-2.5 py-2 transition-shadow", focused === t.id && "ring-2 ring-ring/60")}
      data-testid="ember-task"
      data-task={t.id}
      data-state={t.state}
      data-focused={focused === t.id || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot dot={t.state === "doing" ? "doing" : t.state === "blocked" ? "blocked" : t.state === "done" ? "done" : "open"} />
        <span className={cn("min-w-0 flex-1 truncate text-label font-semibold", t.state === "cancelled" && "text-muted-foreground line-through")} data-testid="ember-task-title">
          {t.title}
        </span>
        <span className={cn("shrink-0 text-caption tabular-nums", TONE[meta.tone])} data-testid="ember-task-meta">
          {meta.text}
        </span>
      </div>
      {progress && progress.total > 0 && (
        <div className="mt-2 mb-1.5 h-0.75 overflow-hidden rounded-full bg-foreground/10" data-testid="ember-task-progress">
          <div className="h-full bg-info" style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }} />
        </div>
      )}
      {t.state === "blocked" && t.outcome && (
        <p className="mt-1 text-caption break-words text-warning" data-testid="ember-task-outcome">
          {t.outcome}
        </p>
      )}
      {(t.state === "done" || t.state === "cancelled") && t.outcome && (
        <Tip label={t.outcome} whenTruncated>
          <p className="mt-0.5 truncate text-caption text-muted-foreground" data-testid="ember-task-outcome">
            {t.outcome}
          </p>
        </Tip>
      )}
      {rows.length > 0 && (
        <div className={cn("flex min-w-0 flex-col", !progress && "mt-1.5")}>
          {rows.map((r) => (
            <WorkerLine key={r.key} row={r} now={now} />
          ))}
        </div>
      )}
    </li>
  );
}

function Section({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5" data-testid={`ember-section-${id}`}>
      <h3 className="text-overline text-muted-foreground">{label}</h3>
      <ul className="flex min-w-0 flex-col gap-2">{children}</ul>
    </section>
  );
}

/** Scrolls the board to the task a link asked for (stores/ember.ts focus) and marks it for a moment. */
function useFocusedTask(scroller: React.RefObject<HTMLDivElement | null>, tasks: readonly EmberTaskView[]): string | null {
  const focus = useEmberStore((s) => s.focus);
  // The last focus request whose mark went (its seq).
  const [faded, setFaded] = useState(0);
  // A subtask's card is its parent's.
  const task = focus === null ? undefined : tasks.find((t) => t.id === focus.id);
  const card = task ? (task.parentId && tasks.some((t) => t.id === task.parentId) ? task.parentId : task.id) : null;
  useEffect(() => {
    if (!focus || card === null) return;
    scroller.current?.querySelector(`[data-task="${card}"]`)?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => {
      setFaded(focus.seq);
    }, 1600);
    return () => {
      clearTimeout(t);
    };
  }, [focus, card, scroller]);
  return focus !== null && focus.seq !== faded ? card : null;
}

/**
 * The side panel's Board (docs/notes/ember-3-gui.md): Ember's task board, live from one
 * WatchBoard stream (held while the tab shows). In progress (doing and blocked), Up next
 * (todo) and Done today (done or cancelled since midnight, ten until "+N more"); a card per
 * top-level task with its subtasks' workers beneath. A worker row opens its thread. The
 * board is Ember's to change; nothing here edits it.
 */
export function BoardSurface() {
  useEffect(() => holdEmberBoard("core"), []);
  const loaded = useEmberStore((s) => s.board !== null);
  const error = useEmberStore((s) => s.error);
  const tasks = useEmberTasks();
  const now = useNow(30_000);
  const counts = useBoardCounts(now);
  const sections = boardSections(tasks, now);
  const [allDone, setAllDone] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const marked = useFocusedTask(scroller, tasks);
  const done = allDone ? sections.doneToday : sections.doneToday.slice(0, DONE_CAP);
  const more = sections.doneToday.length - done.length;
  const empty = sections.inProgress.length + sections.upNext.length + sections.doneToday.length === 0;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-testid="ember-board">
      <header className="flex min-w-0 items-baseline gap-2 border-b border-pane-border px-4 pt-2 pb-2.5" data-testid="ember-board-header">
        <h2 className="text-heading">Board</h2>
        <span className="min-w-0 truncate text-caption text-muted-foreground tabular-nums" data-testid="ember-board-counts">
          {counts.inProgress} in progress · {counts.upNext} up next
        </span>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!loaded ? (
          <p className="text-caption text-muted-foreground">{error ? `Cannot load the board: ${error}. Retrying…` : "Loading the board…"}</p>
        ) : empty ? (
          <div className="flex flex-col items-center gap-3 pt-10 text-center" data-testid="ember-board-empty">
            <Flame state="idle" size="hero" />
            <p className="text-body-sm text-muted-foreground">Nothing on the board yet. Ember adds a task before every piece of work.</p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {sections.inProgress.length > 0 && (
              <Section id="in-progress" label="In progress">
                {sections.inProgress.map((c) => (
                  <TaskCard key={c.task.id} card={c} now={now} focused={marked} />
                ))}
              </Section>
            )}
            {sections.upNext.length > 0 && (
              <Section id="up-next" label="Up next">
                {sections.upNext.map((c) => (
                  <TaskCard key={c.task.id} card={c} now={now} focused={marked} />
                ))}
              </Section>
            )}
            {sections.doneToday.length > 0 && (
              <Section id="done-today" label="Done today">
                {done.map((c) => (
                  <TaskCard key={c.task.id} card={c} now={now} focused={marked} />
                ))}
                {more > 0 && (
                  <li>
                    <button
                      type="button"
                      className="w-full rounded-md px-2 py-1 text-left text-caption text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50"
                      data-testid="ember-done-more"
                      onClick={() => {
                        setAllDone(true);
                      }}
                    >
                      +{more} more
                    </button>
                  </li>
                )}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
