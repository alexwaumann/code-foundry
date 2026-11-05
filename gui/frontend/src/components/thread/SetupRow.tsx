import { memo, useContext, useEffect, useState } from "react";
import { Ban, Check, ChevronRight, Circle, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ThreadSetupStepStatusView, ThreadSetupView } from "@/api/threads";
import { Tip } from "@/components/ui/tooltip";
import { setupLabelText, setupLineTime, setupRevealAt, setupView, SETUP_FOLD_KEY, type SetupLine } from "@/lib/threadSetup";
import type { TimelineRow } from "@/lib/threadTimeline";
import { setTurnFolded } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { KeepRowContext, useThreadCtx } from "./context";

const STATUS_ICONS: Readonly<Record<ThreadSetupStepStatusView, { icon: LucideIcon; className?: string }>> = {
  pending: { icon: Circle },
  running: { icon: LoaderCircle, className: "t-sky animate-spin" },
  done: { icon: Check, className: "t-emerald" },
  warning: { icon: TriangleAlert, className: "t-amber" },
  failed: { icon: CircleX, className: "t-red" },
};

/**
 * The clock of a setup's row: every second while it runs, and at the moment its checklist
 * is due, so the lines show at SETUP_REVEAL_MS and not at the next second.
 */
function useSetupNow(setup: ThreadSetupView | null): number {
  const [now, setNow] = useState(() => Date.now());
  const live = setup?.phase === "running";
  const revealAt = live ? setupRevealAt(setup) : null;
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      setNow(Date.now());
    };
    tick();
    const every = setInterval(tick, 1000);
    const due = revealAt === null ? 0 : revealAt - Date.now();
    const reveal = due > 0 ? setTimeout(tick, due) : undefined;
    return () => {
      clearInterval(every);
      clearTimeout(reveal);
    };
  }, [live, revealAt]);
  return now;
}

/** One line of the checklist, in the work log's row style; a failed one has git's text in a box under it. */
function StepLine({ line, now }: { line: SetupLine; now: number }) {
  const { icon: Icon, className } = STATUS_ICONS[line.status];
  const failed = line.status === "failed";
  const time = setupLineTime(line, now);
  const words = (
    <>
      {line.label.before}
      {line.label.code && <span className="mono cmd">{line.label.code}</span>}
      {line.label.after}
    </>
  );
  return (
    <>
      <div className="row setup-line" data-testid="thread-setup-line" data-key={line.key} data-status={line.status}>
        <span className="ico">
          <Icon className={className} aria-hidden />
        </span>
        <Tip label={`${line.project ? `${line.project} ` : ""}${setupLabelText(line.label)}`} whenTruncated>
          <span className="lbl">
            {line.project && <b className="setup-project">{line.project}</b>}
            {failed ? <b>{words}</b> : words}
          </span>
        </Tip>
        {time && <span className="meta">{time}</span>}
      </div>
      {line.error && (
        <div className="setup-error rounded-md text-caption font-mono text-cf-text" data-testid="thread-setup-error">
          {line.error}
        </div>
      )}
    </>
  );
}

function StepLines({ lines, now }: { lines: readonly SetupLine[]; now: number }) {
  return lines.map((l) => <StepLine key={l.key} line={l} now={now} />);
}

/**
 * The thread's setup in its timeline, under the first message (docs/notes/instant-threads-3-gui.md;
 * the rules are lib/threadSetup). Running: a live line in the turn header's style and a row
 * per step, once a step has taken long enough to be worth one. Failed: the rows as they
 * ended, git's text under the one that failed. Cancelled: one quiet line. Done: a fold line
 * in the finished turn header's style, which keeps its place on screen as it opens
 * (KeepRowContext). Nothing when there is nothing to tell, so the row takes no height.
 */
export const SetupRow = memo(function SetupRow({ row }: { row: Extract<TimelineRow, { type: "setup" }> }) {
  const { threadId } = useThreadCtx();
  const keep = useContext(KeepRowContext);
  const setup = useThreadsStore((s) => s.byId[threadId]?.setup ?? null);
  const now = useSetupNow(setup);
  const view = setupView(setup, now);
  switch (view.kind) {
    case "none":
      return null;
    case "live":
      return (
        <div data-testid="thread-setup" data-phase="running">
          <div className="thead" data-testid="thread-setup-live" data-live>
            <span className="line text-caption">
              <span className="ico">
                <LoaderCircle className="t-sky animate-spin" aria-hidden />
              </span>
              <span className="shimmer">Setting up</span>
              {view.elapsed && (
                <>
                  <span className="sep">·</span>
                  <span className="tabular-nums">{view.elapsed}</span>
                </>
              )}
            </span>
          </div>
          <StepLines lines={view.lines} now={now} />
        </div>
      );
    case "failed":
      return (
        <div data-testid="thread-setup" data-phase="failed">
          <StepLines lines={view.lines} now={now} />
        </div>
      );
    case "cancelled":
      return (
        <div data-testid="thread-setup" data-phase="cancelled">
          <div className="row">
            <span className="ico">
              <Ban aria-hidden />
            </span>
            <span className="lbl">{view.label}</span>
          </div>
        </div>
      );
    case "done":
      return (
        <div data-testid="thread-setup" data-phase="done" data-folded={row.folded || undefined}>
          <div className="thead">
            <button
              type="button"
              className="fold text-caption"
              aria-expanded={!row.folded}
              aria-label={row.folded ? "Show the setup's steps" : "Hide the setup's steps"}
              data-testid="thread-setup-fold"
              onClick={() => {
                keep(row.key);
                setTurnFolded(threadId, SETUP_FOLD_KEY, !row.folded);
              }}
            >
              <span className="ico">
                <ChevronRight aria-hidden />
              </span>
              <span>{view.label}</span>
              {view.warning && (
                <>
                  <span className="sep">·</span>
                  <span className="t-amber" data-testid="thread-setup-fold-warning">
                    {view.warning}
                  </span>
                </>
              )}
            </button>
          </div>
          {!row.folded && <StepLines lines={view.lines} now={now} />}
        </div>
      );
  }
});
