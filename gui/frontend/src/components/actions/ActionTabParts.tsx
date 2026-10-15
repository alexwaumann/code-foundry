import { CircleCheck, CircleStop, CircleX, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { actionCommandOf, actionTabStatus, commandEcho, formatRunClock, formatRunDuration, type ActionTabStatus } from "@/lib/actions";
import { useNow } from "@/lib/clock";
import { ACTION_LABEL, ACTION_RUN_LABEL } from "@/lib/termlabel";
import { cn } from "@/lib/utils";
import { rerunAction, stopActionRun } from "@/stores/actionActions";
import { useActionsStore } from "@/stores/actions";
import { useStopRequested } from "@/stores/actionStops";
import { useTerminalsStore } from "@/stores/terminals";
import { ACTION_ICON } from "./actionIcons";

/** An action tab's status from its terminal and a pressed Stop (a primitive, for a narrow selector). */
function useTabStatus(id: string): ActionTabStatus {
  const stopRequested = useStopRequested(id);
  return useTerminalsStore((s) => {
    const t = s.byId[id];
    return t ? actionTabStatus(t, stopRequested) : stopRequested ? "stopping" : "running";
  });
}

/** The action's icon (the action as it is now; Play once it was deleted). */
export function ActionTabIcon({ id, className }: { id: string; className?: string }) {
  const actionId = useTerminalsStore((s) => s.byId[id]?.labels[ACTION_LABEL] ?? "");
  const icon = useActionsStore((s) => s.byId[actionId]?.icon ?? "play");
  const Icon = ACTION_ICON[icon];
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

/**
 * The tab's status mark: a sky spinner while running (or stopping), an emerald check for
 * exit 0, a muted stop for a run the user stopped, a red x otherwise.
 */
export function ActionTabStatusMark({ id }: { id: string }) {
  const status = useTabStatus(id);
  if (status === "stopping") return <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Stopping" data-status="stopping" data-testid="action-tab-status" />;
  if (status === "stopped") return <CircleStop className="size-3 shrink-0 text-muted-foreground" aria-label="Stopped" data-status="stopped" data-testid="action-tab-status" />;
  if (status === "running") return <LoaderCircle className="size-3 shrink-0 animate-spin text-sky-500 dark:text-sky-400" aria-label="Running" data-status="running" data-testid="action-tab-status" />;
  if (status === "ok") return <CircleCheck className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Exited with code 0" data-status="ok" data-testid="action-tab-status" />;
  return <CircleX className="size-3 shrink-0 text-red-600 dark:text-red-400" aria-label="Failed" data-status="failed" data-testid="action-tab-status" />;
}

/** The run's command line (the run's, else the terminal's argv), as a primitive. */
function useCommand(id: string): string {
  const runId = useTerminalsStore((s) => s.byId[id]?.labels[ACTION_RUN_LABEL] ?? "");
  const runCommand = useActionsStore((s) => s.runs[runId]?.command);
  return useTerminalsStore((s) => actionCommandOf(runCommand, s.byId[id]?.argv ?? []));
}

/**
 * The dimmed `$ command` above an action's terminal. The PTY does not print it (the shell
 * runs it from argv), so it is drawn here, from the run. A multi-line command shows its
 * first line and "+N lines" (the whole command in the tooltip).
 */
export function ActionEcho({ id }: { id: string }) {
  const command = useCommand(id);
  const { first, more } = commandEcho(command);
  if (!first) return null;
  return (
    <div className="flex shrink-0 items-baseline gap-2 bg-pane pt-1.5 pr-3 pl-[9px] font-mono text-xs leading-[17px] text-muted-foreground" title={command} data-testid="action-echo">
      <span className="min-w-0 truncate">$ {first}</span>
      {more > 0 && <span className="shrink-0 font-sans text-[11px] opacity-80">+{more} {more === 1 ? "line" : "lines"}</span>}
    </div>
  );
}

/** The running clock, re-rendered once a second (its own component, so the line around it is not). */
function RunningClock({ startedAtMs }: { startedAtMs: number | null }) {
  const now = useNow(1000);
  return <span className="tabular-nums" data-testid="action-status-time">{formatRunClock(startedAtMs === null ? 0 : now - startedAtMs)}</span>;
}

function Sep() {
  return (
    <span aria-hidden className="opacity-50">
      ·
    </span>
  );
}

/**
 * The status line under an action's output, shown from the start so the terminal does not
 * refit when the command exits: "Running · 0:12 · Stop", then "Exited with code N · 4.2s ·
 * Rerun", tinted red for a non-zero code. After Stop: "Stopping… · 0:12 · Stop" (disabled)
 * until the run exits (the daemon's SIGHUP, then SIGKILL after its grace period), then a
 * neutral "Stopped · 4.2s · Rerun". Times come from the run (started_at, finished_at), else
 * from the terminal. Stop is terminal.kill (the tab stays, exited); Rerun runs the action
 * again for the same owner and closes this tab.
 */
export function ActionStatusLine({ id }: { id: string }) {
  const status = useTabStatus(id);
  const exitCode = useTerminalsStore((s) => s.byId[id]?.exitCode ?? 0);
  const runId = useTerminalsStore((s) => s.byId[id]?.labels[ACTION_RUN_LABEL] ?? "");
  const runStarted = useActionsStore((s) => s.runs[runId]?.startedAtMs ?? null);
  const runFinished = useActionsStore((s) => s.runs[runId]?.finishedAtMs ?? null);
  const termStarted = useTerminalsStore((s) => s.byId[id]?.startedAtMs ?? null);
  const termExited = useTerminalsStore((s) => s.byId[id]?.exitedAtMs ?? null);
  const started = runStarted ?? termStarted;
  const finished = runFinished ?? termExited;
  const failed = status === "failed";
  const button = "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring dark:hover:bg-accent/60";
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 border-t border-pane-border pr-1.5 pl-3 text-xs text-muted-foreground",
        failed && "bg-red-500/[0.07]",
      )}
      data-testid="action-status"
      data-status={status}
    >
      {status === "running" || status === "stopping" ? (
        <>
          <LoaderCircle className={cn("size-3.5 animate-spin", status === "running" ? "text-sky-500 dark:text-sky-400" : "text-muted-foreground")} aria-hidden />
          <span className="text-foreground" data-testid="action-status-label">
            {status === "running" ? "Running" : "Stopping…"}
          </span>
          <Sep />
          <RunningClock startedAtMs={started} />
          <Sep />
          <button
            type="button"
            className={cn(button, "disabled:pointer-events-none disabled:opacity-50")}
            data-testid="action-stop"
            disabled={status === "stopping"}
            // The keyboard stays in the terminal.
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => void stopActionRun(id)}
          >
            <Square className="size-2.5" aria-hidden />
            Stop
          </button>
        </>
      ) : (
        <>
          {failed ? (
            <CircleX className="size-3.5 text-red-600 dark:text-red-400" aria-hidden />
          ) : status === "stopped" ? (
            <CircleStop className="size-3.5" aria-hidden />
          ) : (
            <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          )}
          <span className={failed ? "text-red-600 dark:text-red-400" : "text-foreground"} data-testid="action-status-label">
            {status === "stopped" ? "Stopped" : `Exited with code ${String(exitCode)}`}
          </span>
          {started !== null && finished !== null && (
            <>
              <Sep />
              <span className="tabular-nums" data-testid="action-status-time">
                {formatRunDuration(finished - started)}
              </span>
            </>
          )}
          <Sep />
          <button type="button" className={button} data-testid="action-rerun" onClick={() => void rerunAction(id)}>
            <RotateCcw className="size-3" aria-hidden />
            Rerun
          </button>
        </>
      )}
    </div>
  );
}
