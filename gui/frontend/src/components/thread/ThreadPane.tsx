import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HeaderActions } from "@/components/terminal/TerminalPane";
import { SessionIndicator, SessionTitle } from "@/components/session/SessionParts";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useSessionsStore } from "@/stores/sessions";
import { startThreadWatch, useOpenRequests, useThreadEmpty, useThreadLoaded, useThreadPending, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
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
 * A rendered thread in the content pane (docs/notes/rendered-threads-2-gui.md, design
 * docs/sketches/rendered-thread variant A): the terminal pane's header (title, status,
 * the pane's commands), the conversation as a dense work log, and the follow-up composer
 * floating over its bottom. While shown it holds the thread's ThreadService.Watch (the
 * slot a terminal's Attach takes; it also marks finished turns seen).
 */
export default function ThreadPane({ sessionId }: { sessionId: string }) {
  useEffect(() => startThreadWatch(sessionId), [sessionId]);
  const cwd = useSessionsStore((s) => s.byId[sessionId]?.worktreePath ?? "");
  const state = useSessionsStore((s) => s.byId[sessionId]?.state ?? "unknown");
  const status = useSessionsStore((s) => s.byId[sessionId]?.status ?? "unknown");
  const pendingList = useThreadPending(sessionId);
  const loaded = useThreadLoaded(sessionId);
  const empty = useThreadEmpty(sessionId);
  const parentName = useSessionsStore((s) => {
    const parent = s.byId[sessionId]?.parentId;
    return parent ? s.byId[parent]?.name || parent : "";
  });
  const watchError = useThreadStore((s) => (s.watch?.sessionId === sessionId && s.watch.status === "retrying" ? s.watch.error : null));
  // The prompts to dock: pending requests minus the ones just answered (their answer is on its way).
  const open = useOpenRequests(sessionId);
  const waiting = pendingList.length > 0;
  const live = state === "connected" || state === "starting";
  // Claude is on a turn: busy, or waiting on the user mid-turn.
  const busy = live && (status === "busy" || waiting);
  const working = live && (status === "busy" || state === "starting") && open.length === 0;
  const dockRef = useRef<HTMLDivElement>(null);
  const dockHeight = useHeight(dockRef);
  const ctx = useMemo(() => ({ sessionId, cwd }), [sessionId, cwd]);
  return (
    <ThreadContext.Provider value={ctx}>
      <section className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none" tabIndex={-1} aria-label="Thread" data-session-id={sessionId} data-testid="thread-pane" data-region="content">
        <PaneHeader className="gap-3 px-3 text-xs" data-testid="terminal-header">
          <SessionTitle id={sessionId} />
          <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground tabular-nums">
            <HeaderActions sessionId={sessionId} />
          </span>
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SessionIndicator id={sessionId} />
          {!loaded && <p className="absolute inset-x-0 top-10 text-center text-sm text-muted-foreground">{watchError ? `Cannot load the conversation: ${watchError}` : "Loading the conversation…"}</p>}
          {/* Connected with nothing to show: a fork's history is Claude's, not ours (its items start empty). */}
          {empty && state === "connected" && !working && (
            <p className="absolute inset-x-0 top-10 px-10 text-center text-sm text-muted-foreground" data-testid="thread-empty">
              {parentName ? `Forked from ${parentName}. Claude has the conversation so far; send a follow-up to continue.` : "No messages yet."}
            </p>
          )}
          <Timeline key={sessionId} sessionId={sessionId} working={working} bottomInset={dockHeight} />
          <div className="dock" ref={dockRef}>
            <ThreadComposer key={sessionId} sessionId={sessionId} pending={open} busy={busy} />
          </div>
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
