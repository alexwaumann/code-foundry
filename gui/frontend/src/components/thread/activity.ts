import { useCallback, useRef, useState } from "react";
import type { ThreadPendingView } from "@/api/thread";
import { useLinger } from "@/lib/linger";
import { useOpenRequests, useThreadEmpty, useThreadLoaded, useThreadPending, useThreadWatch } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";

/** What a thread view (the content pane's, a plugin's thread node) shows about its thread's turn. */
export interface ThreadActivity {
  /** The Watch's snapshot arrived. */
  loaded: boolean;
  /** Loaded, and no items (a thread made without a prompt, one still starting). */
  empty: boolean;
  /** The Watch retries: the log on screen may be behind; its error. */
  catchingUp: boolean;
  watchError: string | null;
  /** The prompts to dock: pending requests minus the ones just answered. */
  open: readonly ThreadPendingView[];
  /** Claude is on a turn: busy, or waiting on the user mid-turn. */
  busy: boolean;
  /** Working: busy, or Claude starting for a message just sent. */
  working: boolean;
  /** working, lingering 2 s past a stop so the live turn header turns into the finished one in place. */
  timelineWorking: boolean;
  /** On a turn (timelineWorking, or busy waiting on the user): the open turn's work runs show as strips. */
  timelineStrips: boolean;
}

/**
 * A thread view's activity. Internal only: a process on its way out or gone makes a busy
 * status (an older daemon's) mean nothing. Nothing on screen says whether it runs.
 */
export function useThreadActivity(threadId: string): ThreadActivity {
  const state = useThreadsStore((s) => s.byId[threadId]?.state ?? "unknown");
  const status = useThreadsStore((s) => s.byId[threadId]?.status ?? "unknown");
  const pendingList = useThreadPending(threadId);
  const loaded = useThreadLoaded(threadId);
  const empty = useThreadEmpty(threadId);
  const watch = useThreadWatch(threadId);
  const catchingUp = watch.status === "retrying";
  const open = useOpenRequests(threadId);
  const waiting = pendingList.length > 0;
  const running = state !== "disconnected" && state !== "closing";
  const busy = running && (status === "busy" || waiting);
  const working = running && (status === "busy" || state === "starting") && open.length === 0;
  // The status can turn idle before the turn_end arrives on the Watch: the header turns
  // into the finished one in place instead of vanishing and coming back.
  const timelineWorking = useLinger(working, open.length === 0 ? 2000 : 0);
  return { loaded, empty, catchingUp, watchError: catchingUp ? watch.error : null, open, busy, working, timelineWorking, timelineStrips: timelineWorking || busy };
}

/**
 * An element's height, followed (the floating composer's dock, for the timeline's bottom
 * inset and the jump chip's place). A callback ref, not a ref object read once: the dock
 * remounts when its keyed parent does (PaneOverlay, keyed by thread), and an observer left on
 * the detached dock reported 0 for every thread shown after the first switch (the answer's
 * end sat under the composer; docs/notes/thread-dock-height.md).
 */
export function useElementHeight(): [attach: (el: HTMLElement | null) => void, height: number] {
  const [h, setH] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const attach = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const measure = () => {
      setH(el.offsetHeight);
    };
    measure();
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
  }, []);
  return [attach, h];
}
