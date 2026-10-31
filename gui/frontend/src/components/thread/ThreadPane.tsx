import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { EmberBody } from "@/components/ember/EmberPane";
import { ThreadTitle } from "@/components/thread/ThreadParts";
import { DragBand } from "@/components/window/DragBand";
import { PaneHeader } from "@/components/window/PaneHeader";
import { ThreadInfoCard } from "@/components/threadinfo/ThreadInfoCard";
import { ThreadInfoOverlay } from "@/components/threadinfo/ThreadInfoOverlay";
import { useIsEmberThread } from "@/stores/ember";
import { useThreadsStore } from "@/stores/threads";
import { forgetTurnView, startThreadWatch } from "@/stores/thread";
import { useShownRun } from "@/stores/subagentView";
import { hideThreadInfoOverlay, setCardRoom, useCardRoom } from "@/stores/threadInfo";
import { useUiStore } from "@/stores/ui";
import { cardFits } from "@/lib/threadInfo";
import { useWidth } from "@/lib/useWidth";
import { useElementHeight, useThreadActivity } from "./activity";
import { AgentsStrip } from "./AgentsStrip";
import { CiteLayer } from "./cite/CiteLayer";
import { SubagentPane } from "./SubagentPane";
import { ThreadContext } from "./context";
import { HeaderActions } from "./HeaderActions";
import { PaneOverlay } from "./InlineHtml";
import { Timeline } from "./Timeline";
import { ThreadComposer } from "./ThreadComposer";
import "./thread.css";

/**
 * What the content pane shows for a thread id the threads store does not have: a removed
 * thread (a stale selection), or one the first List has not brought yet.
 */
function ThreadMissing() {
  const loaded = useThreadsStore((st) => st.loaded || st.availability !== "unknown");
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Backdrop />
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col p-10 outline-none" tabIndex={-1} data-focus-root data-region="content" aria-label="Thread" data-testid="thread-missing">
        <p className="m-auto text-body text-cf-text-muted">{loaded ? "This thread no longer exists." : "Loading thread…"}</p>
      </section>
      <DragBand />
    </div>
  );
}

/**
 * A thread in the content pane (docs/notes/rendered-threads-2-gui.md, design
 * docs/sketches/rendered-thread variant A): a header (where it runs › its title, whose menu
 * holds the thread's actions, then the window's toggles; docs/notes/thread-header-crumb.md),
 * the conversation as a dense work log, and the follow-up composer floating
 * over its bottom, the same whether Claude's process runs or not (the daemon starts it on
 * a message and stops it at cache expiry; docs/notes/hide-connection-state.md). While
 * shown it holds the thread's ThreadService.WatchThread (which also marks finished turns seen).
 */
export function ThreadPane({ threadId }: { threadId: string }) {
  const exists = useThreadsStore((s) => threadId in s.byId);
  return exists ? <WatchedThread threadId={threadId} /> : <ThreadMissing />;
}

/**
 * The thread's Watch, held while it is selected, and what it shows: the conversation, or
 * one of its subagent runs read-only (SubagentPane, stores/subagentView.ts), which reads
 * the same log. Going into a run and back keeps the one stream, and the turns the reader
 * unfolded: only leaving the thread forgets them (the next visit shows every finished turn
 * folded).
 */
function WatchedThread({ threadId }: { threadId: string }) {
  useEffect(() => {
    const stop = startThreadWatch(threadId);
    return () => {
      stop();
      forgetTurnView(threadId);
    };
  }, [threadId]);
  const runId = useShownRun(threadId);
  // Ember's thread is its chat (components/ember/EmberPane.tsx): the same stream and timeline, its own header and rows.
  const ember = useIsEmberThread(threadId);
  return runId ? <SubagentPane key={runId} threadId={threadId} runId={runId} /> : ember ? <EmberBody threadId={threadId} /> : <ThreadBody threadId={threadId} />;
}

function ThreadBody({ threadId }: { threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const { loaded, empty, catchingUp, watchError, open, busy, working, timelineWorking, timelineStrips } = useThreadActivity(threadId);
  const [dockRef, dockHeight] = useElementHeight();
  const bodyRef = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const infoOpen = useUiStore((s) => s.threadInfoOpen);
  // The card shows inline only while the conversation keeps CONVERSATION_MIN beside it; else the toggle floats it (ThreadInfoOverlay).
  const [rowRef, rowWidth] = useWidth(1280);
  const infoFits = cardFits(rowWidth);
  useEffect(() => {
    setCardRoom(infoFits);
  }, [infoFits]);
  // Another thread hides the overlay (unless it was shown for that one: the sidebar's linked PRs tag).
  useEffect(() => {
    if (useCardRoom.getState().overlayFor !== threadId) hideThreadInfoOverlay();
  }, [threadId]);
  useEffect(
    () => () => {
      setCardRoom(true);
      hideThreadInfoOverlay();
    },
    [],
  );
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none" tabIndex={-1} aria-label="Thread" data-thread-id={threadId} data-testid="thread-pane" data-region="content">
        <PaneHeader className="gap-2 px-3" data-testid="thread-header">
          <ThreadTitle id={threadId} />
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-cf-text-muted tabular-nums">
            <HeaderActions />
          </span>
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1" ref={rowRef} data-testid="thread-pane-body" data-info-room={infoFits ? "" : undefined}>
          {/* The card lays over this column's right side: the list and the dock keep clear of it (--ti-inset) and the list's scrollbar stays at the pane's edge. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" ref={bodyRef} style={{ "--ti-inset": infoOpen && infoFits ? "var(--ti-card)" : "0px" } as CSSProperties}>
            {/* The page modal (an inline page's Expand) covers this body only: the header, sidebar and side panel stay usable. */}
            <PaneOverlay key={threadId} scope={threadId} threadId={threadId}>
              {/* The log on screen may be behind while the Watch stream retries (a dropped or silent stream). */}
              {loaded && catchingUp && (
                <div
                  className="pointer-events-none absolute top-2 right-[calc(var(--ti-inset)+1rem)] z-10 flex items-center gap-1.5 rounded-md border bg-cf-surface-overlay/90 px-2 py-0.5 text-caption-sm"
                  data-testid="thread-catching-up"
                >
                  <Loader2 className="size-3 animate-spin" />
                  catching up…
                </div>
              )}
              {!loaded && <p className="absolute top-10 right-(--ti-inset) left-0 text-center text-body text-cf-text-muted">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
              {/* Nothing to show (a thread made without a prompt; a fork starts with its parent's items). */}
              {loaded && empty && !working && (
                <p className="absolute top-10 right-(--ti-inset) left-0 px-10 text-center text-body text-cf-text-muted" data-testid="thread-empty">
                  No messages yet.
                </p>
              )}
              <Timeline key={threadId} threadId={threadId} working={timelineWorking} strips={timelineStrips} bottomInset={dockHeight} rail />
              <div className="dock" ref={dockRef}>
                <AgentsStrip threadId={threadId} />
                <ThreadComposer key={threadId} threadId={threadId} pending={open} busy={busy} />
              </div>
              <CiteLayer key={`cite:${threadId}`} threadId={threadId} paneRef={bodyRef} />
            </PaneOverlay>
          </div>
          {/* The thread info card (view.thread-info), over the column's right: the column's own messages, chips and page modal keep clear of it. */}
          {infoOpen && infoFits && <ThreadInfoCard threadId={threadId} scrollerRef={bodyRef} />}
          {/* Without room, the card floats over the conversation instead: no --ti-inset, the conversation does not reflow under it. */}
          {!infoFits && <ThreadInfoOverlay threadId={threadId} />}
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
