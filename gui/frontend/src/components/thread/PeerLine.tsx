import { memo } from "react";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { peerTime } from "@/lib/peerLines";
import { rowToneDotClasses } from "@/lib/statusRegistry";
import type { PeerRow } from "@/lib/threadTimeline";
import { cn } from "@/lib/utils";
import { openThread } from "@/stores/openThread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadCtx } from "./context";

/**
 * One other thread's line (lib/peerLines, docs/notes/other-thread-lines.md): a dot in the
 * exchange's tone, the thread's name (it takes the width; a tooltip only when cut), what
 * happened in a few words, and the time at the right. The line opens that thread, as a
 * worker card's line does; nothing expands. A frozen line reads dimmer.
 */
export const PeerLineRow = memo(function PeerLineRow({ row }: { row: PeerRow }) {
  const { threadId } = useThreadCtx();
  const name = useThreadsStore((s) => s.byId[row.id]?.name ?? null);
  const ticking = row.live && row.start !== null;
  const now = useNowSelect(1000, (n) => (ticking ? n : 0));
  const label = name || (name === null ? "Removed thread" : row.id);
  const body = (
    <>
      <span className={cn("dot", rowToneDotClasses[row.tone])} aria-hidden />
      <Tip label={label} whenTruncated>
        <span className="nm" data-testid="thread-peer-name">
          {label}
        </span>
      </Tip>
      <span className="st" data-testid="thread-peer-words">
        {row.words}
      </span>
      <span className="tm" data-testid="thread-peer-time">
        {peerTime(row, now)}
      </span>
    </>
  );
  const common = { "data-testid": "thread-peer", "data-thread": row.id, "data-tone": row.tone, "data-live": row.live || undefined };
  if (name === null) {
    return (
      <div className="pline gone text-caption" {...common}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="pline text-caption"
      {...common}
      onClick={() => {
        openThread(row.id, { from: threadId });
      }}
    >
      {body}
    </button>
  );
});
