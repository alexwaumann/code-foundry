import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { ThreadTitle } from "@/components/thread/ThreadParts";
import { DragBand } from "@/components/window/DragBand";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useLinger } from "@/lib/linger";
import { useThreadsStore } from "@/stores/threads";
import { startThreadWatch, useOpenRequests, useThreadEmpty, useThreadLoaded, useThreadPending, useThreadStore } from "@/stores/thread";
import { useShownRun } from "@/stores/subagentView";
import { AgentsStrip } from "./AgentsStrip";
import { SubagentPane } from "./SubagentPane";
import { ThreadContext } from "./context";
import { HeaderActions } from "./HeaderActions";
import { Timeline } from "./Timeline";
import { ThreadComposer } from "./ThreadComposer";
import "./thread.css";

/** The floating composer's height, for the timeline's bottom inset. */
function useHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setH(el.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return h;
}

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
        <p className="m-auto text-body text-muted-foreground">{loaded ? "This thread no longer exists." : "Loading thread…"}</p>
      </section>
      <DragBand />
    </div>
  );
}

/**
 * A thread in the content pane (docs/notes/rendered-threads-2-gui.md, design
 * docs/sketches/rendered-thread variant A): a header (name, project @ branch, workspace,
 * linked PRs and the pane's commands; docs/notes/thread-header.md), the conversation as a dense work log, and the follow-up composer floating
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
 * the same log. Going into a run and back keeps the one stream.
 */
function WatchedThread({ threadId }: { threadId: string }) {
  useEffect(() => startThreadWatch(threadId), [threadId]);
  const runId = useShownRun(threadId);
  return runId ? <SubagentPane key={runId} threadId={threadId} runId={runId} /> : <ThreadBody threadId={threadId} />;
}

function ThreadBody({ threadId }: { threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const state = useThreadsStore((s) => s.byId[threadId]?.state ?? "unknown");
  const status = useThreadsStore((s) => s.byId[threadId]?.status ?? "unknown");
  const pendingList = useThreadPending(threadId);
  const loaded = useThreadLoaded(threadId);
  const empty = useThreadEmpty(threadId);
  const watchError = useThreadStore((s) => (s.watch?.threadId === threadId && s.watch.status === "retrying" ? s.watch.error : null));
  const catchingUp = useThreadStore((s) => s.watch?.threadId === threadId && s.watch.status === "retrying");
  // The prompts to dock: pending requests minus the ones just answered (their answer is on its way).
  const open = useOpenRequests(threadId);
  const waiting = pendingList.length > 0;
  // Internal only: a process on its way out or gone makes a busy status (an older
  // daemon's) mean nothing. Nothing on screen says whether it runs.
  const running = state !== "disconnected" && state !== "closing";
  // Claude is on a turn: busy, or waiting on the user mid-turn.
  const busy = running && (status === "busy" || waiting);
  // Working: busy, or Claude starting for a message just sent, which looks the same.
  const working = running && (status === "busy" || state === "starting") && open.length === 0;
  // The timeline's live turn header outlasts a stop by a moment (not a docked request):
  // the status can turn idle before the turn_end arrives on the Watch, and the header then
  // turns into the finished one in place instead of vanishing and coming back.
  const timelineWorking = useLinger(working, open.length === 0 ? 2000 : 0);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockHeight = useHeight(dockRef);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none" tabIndex={-1} aria-label="Thread" data-thread-id={threadId} data-testid="thread-pane" data-region="content">
        <PaneHeader className="gap-2 px-3" data-testid="thread-header">
          <ThreadTitle id={threadId} />
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-muted-foreground tabular-nums">
            <HeaderActions threadId={threadId} />
          </span>
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* The log on screen may be behind while the Watch stream retries (a dropped or silent stream). */}
          {loaded && catchingUp && (
            <div
              className="pointer-events-none absolute top-2 right-4 z-10 flex items-center gap-1.5 rounded-md border bg-popover/90 px-2 py-0.5 text-caption-sm"
              data-testid="thread-catching-up"
            >
              <Loader2 className="size-3 animate-spin" />
              catching up…
            </div>
          )}
          {!loaded && <p className="absolute inset-x-0 top-10 text-center text-body text-muted-foreground">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
          {/* Nothing to show (a thread made without a prompt; a fork starts with its parent's items). */}
          {loaded && empty && !working && (
            <p className="absolute inset-x-0 top-10 px-10 text-center text-body text-muted-foreground" data-testid="thread-empty">
              No messages yet.
            </p>
          )}
          <Timeline key={threadId} threadId={threadId} working={timelineWorking} bottomInset={dockHeight} />
          <div className="dock" ref={dockRef}>
            <AgentsStrip threadId={threadId} />
            <ThreadComposer key={threadId} threadId={threadId} pending={open} busy={busy} />
          </div>
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
