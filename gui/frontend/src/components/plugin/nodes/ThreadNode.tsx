import { lazy, Suspense, useRef } from "react";
import { useThreadsStore } from "@/stores/threads";
import { useNodeHeight } from "../height";
import type { NodeProps } from "../registry";
import { OwnedGone } from "./OwnedGone";

// Loaded on first use: the thread view (and its composer) stays out of what every surface imports.
const InlineThread = lazy(() => import("@/components/thread/InlineThread").then((m) => ({ default: m.InlineThread })));

/** A thread node's height for "auto". */
export const THREAD_AUTO_PX = 420;

/**
 * The plugin's own Claude thread, inline (docs/notes/plugins-6-thread-terminal.md): the
 * content pane's conversation and composer (InlineThread) in a bordered box, read-only
 * without the composer. It holds the thread's Watch while on screen (a second stream when
 * the content pane shows another thread, the same one when it shows this one). A thread the
 * GUI does not know shows a muted empty state.
 */
export function ThreadNode({ node, data }: NodeProps<"thread">) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useNodeHeight(ref, data.height, THREAD_AUTO_PX);
  const known = useThreadsStore((s) => data.threadId in s.byId);
  const loaded = useThreadsStore((s) => s.loaded);
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
  return (
    <div
      ref={ref}
      className="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-pane"
      style={{ height }}
      data-testid="plugin-thread"
      data-key={node.key}
      data-thread-id={data.threadId}
      data-read-only={data.readOnly || undefined}
    >
      <Suspense fallback={<p className="m-auto text-caption">Loading the conversation…</p>}>
        <InlineThread threadId={data.threadId} readOnly={data.readOnly ?? false} placeholder={data.placeholder || undefined} />
      </Suspense>
    </div>
  );
}
