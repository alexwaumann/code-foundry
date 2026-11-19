import { memo, useContext } from "react";
import { ChevronRight } from "lucide-react";
import { StatusCircle } from "@/components/status/StatusCircle";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { formatDuration } from "@/lib/duration";
import { sentTime } from "@/lib/format";
import { rowToneClasses, rowToneDotClasses, statusTimeUnits } from "@/lib/statusRegistry";
import type { WorkerLine, WorkersRow } from "@/lib/threadTimeline";
import { cardTitle, WORKER_STATES } from "@/lib/workerRuns";
import { cn } from "@/lib/utils";
import { openThread } from "@/stores/openThread";
import { setTurnFolded } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { KeepRowContext, useThreadCtx } from "./context";

/** How long, in the sidebar's style ("4s", "12m", "1h 4m"). */
function took(ms: number): string {
  return formatDuration(ms, statusTimeUnits(ms));
}

/**
 * The card a run of this thread's own workers reads as (lib/workerRuns,
 * docs/notes/worker-card.md): a title line, "Working with 3 threads" and the run's elapsed
 * time while it is the current one, "Worked with 3 threads" and the time the user's next
 * message froze it once frozen; then one line per worker. A frozen card shows only its
 * title line until the user opens it (not kept across visits: the thread's fold choices
 * are forgotten on leaving it); the current one has no fold.
 */
export const WorkerCardRow = memo(function WorkerCardRow({ row }: { row: WorkersRow }) {
  const { threadId } = useThreadCtx();
  const keep = useContext(KeepRowContext);
  const ticking = row.live && row.end === null && row.start !== null;
  const now = useNowSelect(1000, (n) => (ticking ? n : 0));
  const right = row.live ? (row.start === null ? "" : took((row.end ?? now) - row.start)) : sentTime(row.end);
  const title = cardTitle(row);
  const open = row.live || !row.folded;
  const head = (
    <>
      {!row.live && <ChevronRight className="chev" aria-hidden />}
      <span className="ttl">{title}</span>
      {right && (
        <span className="rt" data-testid="thread-workers-time">
          {right}
        </span>
      )}
    </>
  );
  return (
    <div className="wcard" data-testid="thread-workers" data-live={row.live || undefined} data-folded={!open || undefined}>
      {row.live ? (
        <div className="wh text-caption">{head}</div>
      ) : (
        <button
          type="button"
          className="wh text-caption"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} the threads: ${title}`}
          onClick={() => {
            keep(row.key);
            setTurnFolded(threadId, row.key, open);
          }}
        >
          {head}
        </button>
      )}
      {open && row.lines.map((l) => <WorkerLineRow key={l.id} line={l} live={row.live} />)}
    </div>
  );
});

/**
 * A worker's line: its state's mark, its name (the width is its; a tooltip only when cut),
 * its state's word and how long it has worked (this stretch). The line opens the worker's
 * thread, as a lineage row does.
 */
function WorkerLineRow({ line, live }: { line: WorkerLine; live: boolean }) {
  const { threadId } = useThreadCtx();
  const name = useThreadsStore((s) => s.byId[line.id]?.name ?? null);
  const ticking = live && line.until === null && line.since !== null;
  const now = useNowSelect(1000, (n) => (ticking ? n : 0));
  const look = WORKER_STATES[line.state];
  const time = line.since === null ? "" : took((line.until ?? now) - line.since);
  const label = name || (name === null ? "Removed thread" : line.id);
  const body = (
    <>
      <span className="nm">
        {line.state === "working" ? <StatusCircle tone="working" className="mk" aria-hidden /> : <span className={cn("dot", rowToneDotClasses[look.tone])} aria-hidden />}
        <Tip label={label} whenTruncated>
          <span className="tx">{label}</span>
        </Tip>
      </span>
      <span className={cn("st", look.toned && rowToneClasses[look.tone])} data-testid="thread-worker-state">
        {look.word}
      </span>
      <span className="tm">{time}</span>
    </>
  );
  if (name === null) {
    return (
      <div className="wl gone text-caption" data-testid="thread-worker" data-thread={line.id}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="wl text-caption"
      data-testid="thread-worker"
      data-thread={line.id}
      onClick={() => {
        // A worker opens as a preview from its lead, as the wake note's link does (stores/openThread.ts).
        openThread(line.id, { from: threadId });
      }}
    >
      {body}
    </button>
  );
}
