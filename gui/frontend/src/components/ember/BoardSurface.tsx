import { GitBranch } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlarmClock, X } from "lucide-react";
import type { EmberTaskView } from "@/api/ember";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { boardSections, cardMeta, cardProgress, timerRows, updatedAgo, workerRows, type BoardCard, type TaskDot, type TimerRow, type WorkerRow } from "@/lib/ember";
import type { StatusTone } from "@/lib/statusLine";
import { cn } from "@/lib/utils";
import { runCommandForResult } from "@/stores/commands";
import { holdEmberBoard, useBoardCounts, useEmberStore, useEmberTasks, useEmberTimers } from "@/stores/ember";
import { useUiStore } from "@/stores/ui";
import { Flame } from "./Flame";

/** Done today shows this many cards until "+N more" is clicked. */
const DONE_CAP = 10;

const DOT: Readonly<Record<TaskDot, string>> = {
  doing: "bg-cf-info shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-info)_25%,transparent)]",
  blocked: "bg-cf-warning",
  done: "bg-cf-success",
  open: "border-[1.5px] border-cf-text-muted opacity-70",
};

/** The sidebar's status colours, muted for "muted". */
const TONE: Readonly<Record<StatusTone, string>> = {
  muted: "text-cf-text-muted",
  sky: "text-cf-info",
  amber: "text-cf-warning",
  emerald: "text-cf-success",
  red: "text-cf-error",
};

function Dot({ dot, className }: { dot: TaskDot; className?: string }) {
  return <span className={cn("block size-2 shrink-0 rounded-full", DOT[dot], className)} data-dot={dot} aria-hidden />;
}

/** Opens a worker thread, as a Threads tab row does (it is a hidden child of Ember's). */
function openThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
}

/** A lead's team member's indent by its depth below the lead (lib/ember teamRows). */
const INDENT = ["", "pl-4", "pl-7", "pl-10"] as const;

/** A done subtask's branch, under its row. */
function BranchLine({ branch, className, testId }: { branch: string; className?: string; testId: string }) {
  return (
    <Tip label={branch} whenTruncated>
      <p className={cn("flex min-w-0 items-center gap-1 text-caption text-cf-text-muted", className)} data-testid={testId}>
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="truncate font-mono">{branch}</span>
      </p>
    </Tip>
  );
}

/**
 * A worker under a card: its dot, the subtask's title or the worker's name, its report or
 * status (a done subtask's outcome), and when it was last updated; a done subtask's branch
 * under it; a lead's team indented beneath it.
 */
function WorkerLine({ row, now }: { row: WorkerRow; now: number }) {
  const body = (
    <>
      <Dot dot={row.dot} />
      <span className={cn("min-w-0 flex-1 truncate", row.threadId === "" && row.depth > 0 ? "text-cf-text-muted" : "text-cf-text/90")} data-testid="ember-worker-title">
        {row.title}
      </span>
      {row.meta.text && (
        <Tip label={row.meta.text} whenTruncated>
          <span className={cn("max-w-[55%] min-w-0 shrink truncate", TONE[row.meta.tone])} data-testid="ember-worker-meta">
            {row.meta.text}
          </span>
        </Tip>
      )}
      {row.atMs !== null && (
        <span className="shrink-0 text-cf-text-muted tabular-nums" data-testid="ember-worker-age">
          {updatedAgo(row.atMs, now)}
        </span>
      )}
    </>
  );
  const cls = cn(
    "flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-caption",
    INDENT[Math.min(row.depth, INDENT.length - 1)],
    row.threadId === "" && "cursor-default",
  );
  const team = row.depth > 0 || undefined;
  const line =
    row.threadId === "" ? (
      <div className={cls} data-testid="ember-worker" data-subtask={row.subtask || undefined} data-team={team}>
        {body}
      </div>
    ) : (
      <button
        type="button"
        className={cn(cls, "cursor-pointer outline-none hover:bg-cf-control-hover/50 focus-visible:bg-cf-control-hover/50")}
        data-testid="ember-worker"
        data-thread={row.threadId}
        data-subtask={row.subtask || undefined}
        data-team={team}
        onClick={() => {
          openThread(row.threadId);
        }}
      >
        {body}
      </button>
    );
  if (!row.branch && !row.outcome) return line;
  // Under the title, past the dot (size-2 + gap-2 + px-1): the branch, then what the piece came to.
  return (
    <>
      {line}
      <div className="-mt-0.5 mb-0.5 flex min-w-0 items-center gap-1 pl-5 text-caption text-cf-text-muted">
        {row.branch && <BranchLine branch={row.branch} className="max-w-[60%] shrink-0" testId="ember-worker-branch" />}
        {row.branch && row.outcome && <span aria-hidden>·</span>}
        {row.outcome && (
          <Tip label={row.outcome} whenTruncated>
            <span className="min-w-0 truncate" data-testid="ember-worker-outcome">
              {row.outcome}
            </span>
          </Tip>
        )}
      </div>
    </>
  );
}

/**
 * A blocked task's outcome in amber, three lines at most (a worker's error can run to
 * dozens); a click opens it in full and closes it again.
 */
function BlockedOutcome({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        "mt-1 w-full cursor-pointer rounded-sm text-left text-caption break-words whitespace-pre-line text-cf-warning outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50",
        !open && "line-clamp-3",
      )}
      aria-expanded={open}
      data-testid="ember-task-outcome"
      onClick={() => {
        setOpen(!open);
      }}
    >
      {text}
    </button>
  );
}

/** A task's card: dot, title, "x of y" or its worker's status, a progress bar for a parent, a blocked task's outcome, its branch, its workers. */
function TaskCard({ card, now, focused }: { card: BoardCard; now: number; focused: string | null }) {
  const t = card.task;
  const meta = cardMeta(card);
  const progress = cardProgress(card);
  const rows = workerRows(card);
  return (
    <li
      className={cn("rounded-lg border border-cf-divider px-2.5 py-2 transition-shadow", focused === t.id && "ring-2 ring-cf-focus/60")}
      data-testid="ember-task"
      data-task={t.id}
      data-state={t.state}
      data-focused={focused === t.id || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot dot={t.state === "doing" ? "doing" : t.state === "blocked" ? "blocked" : t.state === "done" ? "done" : "open"} />
        <span className={cn("min-w-0 flex-1 truncate text-label font-semibold", t.state === "cancelled" && "text-cf-text-muted line-through")} data-testid="ember-task-title">
          {t.title}
        </span>
        <span className={cn("shrink-0 text-caption tabular-nums", TONE[meta.tone])} data-testid="ember-task-meta">
          {meta.text}
        </span>
      </div>
      {progress && progress.total > 0 && (
        <div className="mt-2 mb-1.5 h-0.75 overflow-hidden rounded-full bg-cf-text/10" data-testid="ember-task-progress">
          <div className="h-full bg-cf-info" style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }} />
        </div>
      )}
      {t.state === "blocked" && t.outcome && <BlockedOutcome text={t.outcome} />}
      {(t.state === "done" || t.state === "cancelled") && t.outcome && (
        <Tip label={t.outcome} whenTruncated>
          <p className="mt-0.5 truncate text-caption text-cf-text-muted" data-testid="ember-task-outcome">
            {t.outcome}
          </p>
        </Tip>
      )}
      {t.branch && <BranchLine branch={t.branch} className="mt-0.5" testId="ember-task-branch" />}
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

/**
 * One of Ember's timers, laid out as a worker line: a clock where the dot sits, its note
 * (or "Reminder"), "every 2m" for a repeating one, when it fires, and an × that cancels it
 * (thread.unsubscribe; the row goes when the board says so).
 */
function TimerLine({ row }: { row: TimerRow }) {
  const [cancelling, setCancelling] = useState(false);
  return (
    <div className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm pl-1 text-caption" data-testid="ember-timer" data-timer={row.id}>
      <AlarmClock className="size-3 shrink-0 text-cf-text-muted" aria-hidden />
      <Tip label={row.title} whenTruncated>
        <span className={cn("min-w-0 flex-1 truncate", row.noted ? "text-cf-text/90" : "text-cf-text-muted")} data-testid="ember-timer-note">
          {row.title}
        </span>
      </Tip>
      {row.every && (
        <span className="shrink-0 text-cf-text-muted" data-testid="ember-timer-every">
          {row.every}
        </span>
      )}
      <span className="shrink-0 text-cf-text-muted tabular-nums" data-testid="ember-timer-when">
        {row.when}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 shrink-0 text-cf-text-muted hover:text-cf-text"
        aria-label={`Cancel the timer${row.noted ? `: ${row.title}` : ""}`}
        disabled={cancelling}
        data-testid="ember-timer-cancel"
        onClick={() => {
          setCancelling(true);
          void runCommandForResult("thread.unsubscribe", { subscription: row.id }, { quiet: true }).then(() => {
            setCancelling(false);
          });
        }}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

/** The Scheduled section's one card: Ember's timers, soonest first. */
function TimersCard({ rows }: { rows: readonly TimerRow[] }) {
  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-cf-divider py-1.5 pr-1.5 pl-2.5" data-testid="ember-timers">
      {rows.map((r) => (
        <TimerLine key={r.id} row={r} />
      ))}
    </li>
  );
}

function Section({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5" data-testid={`ember-section-${id}`}>
      <h3 className="text-overline text-cf-text-muted">{label}</h3>
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
 * (todo), Scheduled (Ember's timers, each with an × that cancels it) and Done today (done or
 * cancelled since midnight, ten until "+N more"); a card per top-level task with its
 * subtasks' workers beneath. A worker row opens its thread. The tasks are Ember's to change;
 * nothing here edits them.
 */
export function BoardSurface() {
  useEffect(() => holdEmberBoard("core"), []);
  const loaded = useEmberStore((s) => s.board !== null);
  const error = useEmberStore((s) => s.error);
  const tasks = useEmberTasks();
  const now = useNow(30_000);
  const counts = useBoardCounts(now);
  const sections = boardSections(tasks, now);
  const timers = timerRows(useEmberTimers(), now);
  const [allDone, setAllDone] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const marked = useFocusedTask(scroller, tasks);
  const done = allDone ? sections.doneToday : sections.doneToday.slice(0, DONE_CAP);
  const more = sections.doneToday.length - done.length;
  const empty = sections.inProgress.length + sections.upNext.length + sections.doneToday.length + timers.length === 0;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-testid="ember-board">
      <header className="flex min-w-0 items-baseline gap-2 border-b border-cf-divider px-4 pt-2 pb-2.5" data-testid="ember-board-header">
        <h2 className="text-heading">Board</h2>
        <span className="min-w-0 truncate text-caption text-cf-text-muted tabular-nums" data-testid="ember-board-counts">
          {counts.inProgress} in progress · {counts.upNext} up next
          {counts.scheduled > 0 && ` · ${String(counts.scheduled)} scheduled`}
        </span>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!loaded ? (
          <p className="text-caption text-cf-text-muted">{error ? `Cannot load the board: ${error}. Retrying…` : "Loading the board…"}</p>
        ) : empty ? (
          <div className="flex flex-col items-center gap-3 pt-10 text-center" data-testid="ember-board-empty">
            <Flame state="idle" size="hero" />
            <p className="text-body-sm text-cf-text-muted">Nothing on the board yet. Ember adds a task before every piece of work.</p>
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
            {timers.length > 0 && (
              <Section id="scheduled" label="Scheduled">
                <TimersCard rows={timers} />
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
                      className="w-full rounded-md px-2 py-1 text-left text-caption text-cf-text-muted outline-none hover:bg-cf-control-hover/50 hover:text-cf-text focus-visible:bg-cf-control-hover/50"
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
