import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { startThreadWatch } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useElementHeight, useThreadActivity } from "./activity";
import { ThreadContext } from "./context";
import { PaneOverlay } from "./InlineHtml";
import { Timeline } from "./Timeline";
import { ThreadComposer } from "./ThreadComposer";
import "./thread.css";

/** The rows' inset in a side panel (the content pane's is 40). */
const INLINE_INSET = 12;

/**
 * A thread drawn inside something else (a plugin's thread node,
 * docs/notes/plugins-6-thread-terminal.md): the content pane's conversation and floating
 * composer without the header, sized by its parent. It holds the thread's Watch while
 * mounted (stores/thread startThreadWatch: shared when the content pane shows the same
 * thread). `readOnly` leaves the composer out. Its composer never takes the content
 * pane's focus requests, and leaving does not forget the turns the reader unfolded (the
 * content pane may show the thread too). A page card's Expand opens over the node, in a
 * modal scope of its own (`inline:<thread>`), apart from the content pane's.
 */
export function InlineThread({ threadId, readOnly = false, placeholder }: { threadId: string; readOnly?: boolean; placeholder?: string | undefined }) {
  // An inline holder (api/streamSlots.ts): the content pane's own Watch outranks it.
  useEffect(() => startThreadWatch(threadId, "inline"), [threadId]);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const { loaded, empty, catchingUp, watchError, open, busy, working, timelineWorking, timelineStrips } = useThreadActivity(threadId);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockHeight = useElementHeight(dockRef);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread cf-thread-inline relative flex h-full min-h-0 min-w-0 flex-col" aria-label="Thread" data-thread-id={threadId} data-testid="inline-thread">
        {/* A page shown here expands over this node only, in its own scope (InlineHtml PaneOverlay). */}
        <PaneOverlay key={threadId} scope={`inline:${threadId}`} threadId={threadId}>
          {loaded && catchingUp && (
            <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-md border bg-cf-surface-overlay/90 px-2 py-0.5 text-caption-sm" data-testid="thread-catching-up">
              <Loader2 className="size-3 animate-spin" />
              catching up…
            </div>
          )}
          {!loaded && <p className="absolute inset-x-0 top-6 px-4 text-center text-body-sm text-cf-text-muted">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
          {loaded && empty && !working && (
            <p className="absolute inset-x-0 top-6 px-4 text-center text-body-sm text-cf-text-muted" data-testid="thread-empty">
              No messages yet.
            </p>
          )}
          <Timeline key={threadId} threadId={threadId} working={timelineWorking} strips={timelineStrips} bottomInset={readOnly ? 0 : dockHeight} inset={INLINE_INSET} />
          {!readOnly && (
            <div className="dock" ref={dockRef}>
              <ThreadComposer key={threadId} threadId={threadId} pending={open} busy={busy} placeholder={placeholder} focusRequests={false} />
            </div>
          )}
        </PaneOverlay>
      </section>
    </ThreadContext.Provider>
  );
}
