import { useMemo, type KeyboardEvent } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { sentTime } from "@/lib/format";
import { firstLine } from "@/lib/peerLines";
import { userText } from "@/lib/threadFind";
import { openThread } from "@/stores/openThread";
import { setRowExpanded, useRowExpanded } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadCtx } from "./context";
import { QueuedTag } from "./QueuedTag";

/**
 * A message from another thread, neither this thread's lead nor its worker
 * (docs/notes/other-thread-lines.md): the cause of the turn that follows, drawn where the
 * user's bubble would be as one line: "From <thread>", "wants a reply" in the warning tone
 * when the sender waits for an answer, the message's first line, and its time. A click (or
 * Enter) opens the whole message in place under the line, kept as the row's expanded state
 * (the find bar opens it for a match inside: stores/threadFind openThreadFindItem). The
 * name opens that thread.
 */
export function FromRow({
  id,
  fromId,
  wanted,
  text,
  composerText,
  attachments,
  createdAtMs,
  steer = false,
  queued = false,
  unsent = false,
}: {
  id: string;
  fromId: string;
  wanted: boolean;
  text: string;
  composerText: string;
  attachments: readonly string[];
  createdAtMs: number | null;
  steer?: boolean;
  queued?: boolean;
  /** Claude never read it (its process ended first; docs/notes/steer-segments.md). */
  unsent?: boolean;
}) {
  const { threadId } = useThreadCtx();
  const open = useRowExpanded(threadId, id, false);
  const name = useThreadsStore((s) => s.byId[fromId]?.name ?? null);
  const full = useMemo(() => userText(text, composerText, attachments), [text, composerText, attachments]);
  const toggle = () => {
    setRowExpanded(threadId, id, !open);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    toggle();
  };
  const label = name || (name === null ? "Removed thread" : fromId);
  return (
    <div className="fromrow" data-testid="thread-from" data-steer={steer || undefined} data-open={open || undefined} data-thread={fromId}>
      <div className="fl text-body-sm" role="button" tabIndex={0} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the message from ${label}`} data-testid="thread-from-line" onClick={toggle} onKeyDown={onKey}>
        <CornerDownRight className="ic" aria-hidden />
        <span className="lead">From</span>
        <Tip label={label} whenTruncated>
          {name === null ? (
            <span className="nm gone" data-testid="thread-from-name">
              {label}
            </span>
          ) : (
            <button
              type="button"
              className="nm"
              data-testid="thread-from-name"
              onClick={(e) => {
                e.stopPropagation();
                openThread(fromId, { from: threadId });
              }}
            >
              {label}
            </button>
          )}
        </Tip>
        {wanted && (
          <span className="tag text-caption text-cf-warning-text" data-testid="thread-from-tag">
            wants a reply
          </span>
        )}
        <span className="sum" data-testid="thread-from-summary">
          {firstLine(full)}
        </span>
        <span className="ago text-caption" data-testid="thread-from-time">
          {sentTime(createdAtMs)}
        </span>
        {(queued || unsent) && <QueuedTag unsent={unsent} />}
        <ChevronRight className="chev" aria-hidden />
      </div>
      {open && (
        <div className="fbody text-body selectable" data-testid="thread-from-body" data-find-item={id}>
          {full}
        </div>
      )}
    </div>
  );
}
