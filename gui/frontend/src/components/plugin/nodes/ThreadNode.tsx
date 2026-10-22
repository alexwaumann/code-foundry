import { lazy, Suspense, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { useStreamSlotsStore } from "@/api/streamSlots";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useViewCtx } from "../context";
import { useNodeHeight } from "../height";
import { useLeavingViewTab, useLiveSlot, useOnScreen } from "../live";
import type { NodeProps } from "../registry";
import { LivePaused } from "./LivePaused";
import { OwnedGone } from "./OwnedGone";

// Loaded on first use: the thread view (and its composer) stays out of what every surface imports.
const InlineThread = lazy(() => import("@/components/thread/InlineThread").then((m) => ({ default: m.InlineThread })));

/** A thread node's height for "auto". */
export const THREAD_AUTO_PX = 420;

/**
 * The plugin's own Claude thread, inline (docs/notes/plugins-6-thread-terminal.md): the
 * content pane's conversation and composer (InlineThread) in a bordered box, read-only
 * without the composer, and read-only with an "Archived" line while the thread is
 * archived. It holds the thread's Watch only while near the screen and its view tab stays
 * the active one, within the inline budget (components/plugin/live.ts; free when the
 * content pane shows the same thread, which shares its Watch). A thread the GUI does not
 * know shows a muted empty state.
 */
export function ThreadNode({ node, data }: NodeProps<"thread">) {
  const { watchKey } = useViewCtx();
  const ref = useRef<HTMLDivElement>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const height = useNodeHeight(ref, data.height, THREAD_AUTO_PX);
  const known = useThreadsStore((s) => data.threadId in s.byId);
  const loaded = useThreadsStore((s) => s.loaded);
  const archived = useThreadsStore((s) => (s.byId[data.threadId]?.archivedAtMs ?? null) !== null);
  const onScreen = useOnScreen(el);
  const leaving = useLeavingViewTab(watchKey);
  // The content pane already watches the thread it shows: this node adds no stream.
  const shared = useUiStore((s) => s.selection.kind === "thread" && s.selection.id === data.threadId);
  const show = known && onScreen && !leaving;
  const slot = useLiveSlot(`thread\u0000${watchKey}\u0000${node.key}`, show && !shared);
  const attached = show && (shared || slot.live);
  const waiting = useStreamSlotsStore((s) => attached && s.waiting.includes(`thread:${data.threadId}`));
  if (!known) {
    return (
      <OwnedGone
        kind="thread"
        testId="plugin-thread-gone"
        heading={loaded ? "This thread is gone" : "Loading the thread…"}
        detail={loaded ? "The plugin's thread was removed." : `Thread ${data.threadId}`}
      />
    );
  }
  const readOnly = (data.readOnly ?? false) || archived;
  return (
    <div
      ref={(e) => {
        ref.current = e;
        setEl(e);
      }}
      className="relative isolate flex min-w-0 flex-col overflow-hidden rounded-lg border border-cf-border bg-cf-surface"
      style={{ height }}
      data-testid="plugin-thread"
      data-key={node.key}
      data-thread-id={data.threadId}
      data-read-only={readOnly || undefined}
      data-archived={archived || undefined}
      data-live={attached || undefined}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {attached && (
          <Suspense fallback={<p className="m-auto text-caption">Loading the conversation…</p>}>
            <InlineThread threadId={data.threadId} readOnly={readOnly} placeholder={data.placeholder || undefined} />
          </Suspense>
        )}
        {!attached && <LivePaused kind="thread" reason={slot.over ? "budget" : "hidden"} onAttach={slot.take} />}
        {waiting && <LivePaused kind="thread" reason="connections" />}
      </div>
      {archived && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-cf-border px-3 py-1.5 text-caption" data-testid="plugin-thread-archived">
          <Archive className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">Archived · read-only</span>
        </div>
      )}
    </div>
  );
}
