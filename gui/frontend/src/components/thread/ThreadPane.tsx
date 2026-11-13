import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { EmberBody } from "@/components/ember/EmberPane";
import { DragBand } from "@/components/window/DragBand";
import { ThreadInfoCard } from "@/components/threadinfo/ThreadInfoCard";
import { ThreadInfoOverlay } from "@/components/threadinfo/ThreadInfoOverlay";
import { useInfoRoom } from "@/components/threadinfo/useInfoRoom";
import { useIsEmberThread } from "@/stores/ember";
import { useThreadsStore } from "@/stores/threads";
import { startThreadWatch, useSetupShown } from "@/stores/thread";
import { holdThreadPane, useThreadFindOpen } from "@/stores/threadFind";
import { useShownRun } from "@/stores/subagentView";
import { useThreadInfoOpen } from "@/stores/threadInfoOverlay";
import { useUiStore } from "@/stores/ui";
import { setupRowPhase } from "@/lib/threadSetup";
import { useElementHeight, useThreadActivity } from "./activity";
import { CiteLayer } from "./cite/CiteLayer";
import { FindBar } from "./find/FindBar";
import { FindLayer } from "./find/FindLayer";
import { SubagentPane } from "./SubagentPane";
import { ThreadContext } from "./context";
import { ThreadHeader } from "./ThreadHeader";
import { useShellPane } from "@/shell/paneContext";
import { useAskStrip } from "@/shell/askStrip";
import { PaneOverlay } from "./InlineHtml";
import { Timeline } from "./Timeline";
import { ThreadComposer } from "./ThreadComposer";
import { SnoozeStrip } from "./SnoozeStrip";
import { WaitingStrip } from "./WaitingStrip";
import "./thread.css";

/**
 * What the content pane shows for a thread id the threads store does not have: a removed
 * thread (a stale selection), or one the first List has not brought yet.
 */
function ThreadMissing() {
  const loaded = useThreadsStore((st) => st.loaded);
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
    // Leaving the thread closes its find and forgets its fold choices (a tick later, so StrictMode's replay is not a leave).
    const release = holdThreadPane(threadId);
    return () => {
      stop();
      release();
    };
  }, [threadId]);
  const runId = useShownRun(threadId);
  // Ember's thread is its chat (components/ember/EmberPane.tsx): the same stream and timeline, its own header and rows.
  const ember = useIsEmberThread(threadId);
  return runId ? <SubagentPane key={runId} threadId={threadId} runId={runId} /> : ember ? <EmberBody threadId={threadId} /> : <ThreadBody threadId={threadId} />;
}

function ThreadBody({ threadId }: { threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  // A thread made with no prompt still has its setup's row to show.
  const shown = useSetupShown(threadId).size > 0;
  const setupRow = useThreadsStore((s) => setupRowPhase(s.byId[threadId]?.setup, shown) !== "");
  const { loaded, empty, catchingUp, watchError, open, busy, working, timelineWorking, timelineStrips } = useThreadActivity(threadId);
  const [dockAttach, dockHeight] = useElementHeight();
  const bodyRef = useRef<HTMLDivElement>(null);
  const dockEl = useRef<HTMLDivElement>(null);
  const dockRef = useCallback(
    (el: HTMLDivElement | null) => {
      dockEl.current = el;
      dockAttach(el);
    },
    [dockAttach],
  );

  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const infoOpen = useThreadInfoOpen(threadId);
  const findOpen = useThreadFindOpen(threadId);
  const [rowRef, infoFits] = useInfoRoom(threadId);
  // The pane's header (ThreadHeader): the tab above is the title. None outside a pane (tests).
  const shellPane = useShellPane();
  // A shell pane too short for the full ask draws it as one line above the composer (shell/askStrip.ts).
  const askKey = open.map((p) => p.requestId).join(" ");
  const askStrip = useAskStrip(shellPane !== null && open.length > 0, bodyRef, dockEl, askKey);
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none" tabIndex={-1} aria-label="Thread" data-thread-id={threadId} data-testid="thread-pane" data-region="content">
        {shellPane && <ThreadHeader threadId={threadId} paneId={shellPane.paneId} />}
        {/* The find bar (thread.find) sits where the card starts, which moves down under it (--ti-find), inline or floating.
            Clipped: in a pane narrower than a thread's minimum (200% zoom in a small window) the composer's
            footer stacks and its dock grows taller than this box; it would cover the header above. */}
        <div
          className="relative flex min-h-0 flex-1 overflow-hidden"
          ref={rowRef}
          data-testid="thread-pane-body"
          data-info-room={infoFits ? "" : undefined}
          style={findOpen ? ({ "--ti-find": "var(--ti-find-open)" } as CSSProperties) : undefined}
        >
          {/* The card lays over this column's right side (inside the list's scroller): the list, the dock, the chips and the page modal keep clear of it (--ti-inset) and the list's scrollbar stays at the pane's edge. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" ref={bodyRef} data-ask-strip={askStrip || undefined} style={{ "--ti-inset": infoOpen && infoFits ? "var(--ti-card)" : "0px" } as CSSProperties}>
            {/* The page modal (an inline page's Expand) covers this body only: the header, sidebar and other panes stay usable. */}
            <PaneOverlay key={threadId} scope={threadId} threadId={threadId}>
              {/* The log on screen may be behind while the Watch stream retries (a dropped or silent stream). */}
              {loaded && catchingUp && (
                <div
                  className="pointer-events-none absolute top-[calc(0.5rem+var(--ti-find))] right-[calc(var(--ti-inset)+1rem)] z-10 flex items-center gap-1.5 rounded-md border bg-cf-surface-overlay/90 px-2 py-0.5 text-caption-sm"
                  data-testid="thread-catching-up"
                >
                  <Loader2 className="size-3 animate-spin" />
                  catching up…
                </div>
              )}
              {!loaded && <p className="absolute top-10 right-(--ti-inset) left-0 text-center text-body text-cf-text-muted">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
              {/* Nothing to show (a thread made without a prompt; a fork starts with its parent's items). */}
              {loaded && empty && !working && !setupRow && (
                <p className="absolute top-10 right-(--ti-inset) left-0 px-10 text-center text-body text-cf-text-muted" data-testid="thread-empty">
                  No messages yet.
                </p>
              )}
              {/* The thread info card (view.thread-info) is drawn inside the list's scroller, over its right padding: a wheel over it scrolls the list natively. */}
              <Timeline
                key={threadId}
                threadId={threadId}
                working={timelineWorking}
                strips={timelineStrips}
                bottomInset={dockHeight}
                rail
                pinnedLayer={
                  findOpen || (infoOpen && infoFits) ? (
                    <>
                      <FindBar threadId={threadId} narrow={!infoFits} />
                      {infoOpen && infoFits && <ThreadInfoCard threadId={threadId} />}
                    </>
                  ) : undefined
                }
              />
              <div className="dock" ref={dockRef}>
                <WaitingStrip key={`wait:${threadId}`} threadId={threadId} />
                <SnoozeStrip key={`snooze:${threadId}`} threadId={threadId} />
                <ThreadComposer key={threadId} threadId={threadId} pending={open} busy={busy} askStrip={askStrip && shellPane ? shellPane.paneId : null} />
              </div>
              <CiteLayer key={`cite:${threadId}`} threadId={threadId} paneRef={bodyRef} />
              <FindLayer key={`find:${threadId}`} threadId={threadId} paneRef={bodyRef} />
            </PaneOverlay>
          </div>
          {/* Without room, the card floats over the conversation instead: no --ti-inset, the conversation does not reflow under it. */}
          {!infoFits && <ThreadInfoOverlay threadId={threadId} />}
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
