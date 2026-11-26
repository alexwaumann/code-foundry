import { create } from "zustand";
import { daemon, invalidateOnTransportError } from "@/api/endpoint";
import { reportClientState, watchEvents, type EventEnvelope, type EventView } from "@/api/events";
import { listThreads } from "@/api/threads";
import { errorMessage, HEARTBEAT_MS, isAbort, onPageStateChange, runStream, type StreamStatus } from "@/api/stream";
import type { TerminalView } from "@/api/terminal";
import { notify } from "@/lib/notify";
import { applyActionEvent, useActionsStore } from "./actions";
import { onActionRunFinished } from "./actionActions";
import { applyGhEvent, invalidateWatchedGhOnReconnect } from "./gh";
import { applyGitOpsEvent } from "./gitops";
import { useHealthStore } from "./health";
import { applyIntent } from "./intents";
import { applyLayoutEvent } from "./layout";
import { applyMemoryEvent } from "./memory";
import { applyNotificationEvent } from "./notifications";
import { applyPageEvent } from "./pageAnswers";
import { applyPageStorageEvent } from "./bridgeHost";
import { noteNotificationArrivals } from "./arrivals";
import { raiseArrivalToasts } from "./notificationToasts";
import { applySearchActivity } from "./searchActivity";
import { applyThemeEvent } from "./themes";
import { onPluginEvent } from "./plugins";
import { applyProjectEvent, useProjectsStore } from "./projects";
import { applyRetiredUsage, applyThreadListEvent, replaceThreads, useThreadsStore } from "./threads";
import { applySettingsSnapshot, loadSettingsSchema } from "./settings";
import { onSkillEpoch } from "./skill";
import { applyTerminalEvent, useTerminalsStore } from "./terminals";
import { applyThreadSourceEvent, prunePageModals, pruneThreadLogs } from "./thread";
import { applyUpdateEvent } from "./update";
import { applyWorkspaceEvent, useWorkspacesStore } from "./workspaces";
import { applyProjectEventToDetails } from "./worktreeDetail";

interface EventsState {
  /** Status of the one EventService.Watch stream that feeds every slice. */
  stream: StreamStatus;
  streamError: string | null;
  /**
   * No attempt has brought a message for SILENT_MS. `stream` cannot say so: onConnect's calls
   * open it, and they work on a daemon whose sockets something is stopping
   * (docs/notes/ws-transport.md).
   */
  silent: boolean;
}

export const useEventsStore = create<EventsState>()(() => ({ stream: "connecting", streamError: null, silent: false }));

/** Of answered pings: longer than the backoff's longest wait, so a daemon back from any outage never shows as silence. */
export const SILENT_MS = 4 * HEARTBEAT_MS;

type Handlers = { [S in EventView["source"]]: (event: Extract<EventView, { source: S }>["event"]) => void };

/**
 * Where each source's events go. A registry, not a switch: a new source is one entry.
 * gh events invalidate the GitHub views on screen (stores/gh.ts).
 */
const handlers: Handlers = {
  project: (ev) => {
    useProjectsStore.setState((s) => ({ ...applyProjectEvent(s, ev), loaded: s.loaded || ev.kind === "snapshot" }));
    applyProjectEventToDetails(ev);
  },
  workspace: (ev) => {
    useWorkspacesStore.setState((s) => ({ ...applyWorkspaceEvent(s, ev), loaded: true }));
  },
  terminal: (ev) => {
    // Where a terminal shows is the layout's (its tab, the quick terminal): the daemon places it.
    useTerminalsStore.setState((s) => ({ ...applyTerminalEvent(s, ev), loaded: true }));
  },
  threadList: (ev) => {
    // A snapshot is the whole list, even if List failed transiently.
    useThreadsStore.setState((s) => ({
      ...applyThreadListEvent(s, ev),
      retiredUsage: applyRetiredUsage(s.retiredUsage, ev),
      loaded: s.loaded || ev.kind === "snapshot",
      error: null,
      epoch: ev.kind === "snapshot" ? s.epoch + 1 : s.epoch,
    }));
    // Terminal snapshots precede threadList in EventService.Watch: with zero terminals no
    // terminal event is emitted, so threadList snapshot marks terminals loaded too.
    if (ev.kind === "snapshot" && !useTerminalsStore.getState().loaded) {
      useTerminalsStore.setState({ loaded: true });
    }
    // A removed thread's items go with it.
    if (ev.kind === "removed" || ev.kind === "snapshot") pruneThreadLogs((id) => id in useThreadsStore.getState().byId);
    // A removed or archived thread's open page modal closes (session state; stores/thread.ts pageModals).
    if (useThreadsStore.getState().loaded)
      prunePageModals((id) => {
        const t = useThreadsStore.getState().byId[id];
      return t !== undefined && t.archivedAtMs === null;
    });
  },
  // Pending requests of every thread; the visible one's items come from its Watch.
  thread: applyThreadSourceEvent,
  gh: applyGhEvent,
  gitops: applyGitOpsEvent,
  ui: applyIntent,
  settings: applySettingsSnapshot,
  update: applyUpdateEvent,
  action: (ev) => {
    useActionsStore.setState((s) => applyActionEvent(s, ev));
    // A failed worktree-create run toasts (stores/actionActions.ts).
    if (ev.kind === "runFinished") onActionRunFinished(ev.finished);
  },
  // Plugins and their surfaces' availability (stores/plugins.ts re-lists commands).
  plugin: onPluginEvent,
  // The Skills marketplace read again: an open Settings → Skills re-reads (stores/skill.ts).
  skill: (ev) => { onSkillEpoch(ev.epoch); },
  // The app memory, for Settings › Memory (stores/memory.ts).
  memory: applyMemoryEvent,
  // Agent searches, for the sidebar's search row (stores/searchActivity.ts).
  search: applySearchActivity,
  // The user's own themes (stores/themes.ts; src/themes resolves them).
  theme: applyThemeEvent,
  // The window's layout (stores/layout.ts).
  layout: applyLayoutEvent,
  // The bell's notifications (stores/notifications.ts) and their arrival toasts.
  notification: (ev) => {
    applyNotificationEvent(ev);
    raiseArrivalToasts(ev);
    noteNotificationArrivals(ev);
  },
  // Pages whose owner or answer changed: their File tabs read their grant again (stores/pageAnswers.ts).
  // Pages whose storage changed: their frames read it again (stores/bridgeHost.ts).
  page: (ev) => {
    applyPageEvent(ev);
    applyPageStorageEvent(ev);
  },
};

const taps = new Set<(ev: EventView) => void>();

/**
 * Hears every event after its slice applied it (a page's bridge forwards the ui source's
 * intents, which no slice keeps: stores/bridgeSources.ts). Returns the unsubscribe.
 */
export function onDaemonEvent(cb: (ev: EventView) => void): () => void {
  taps.add(cb);
  return () => {
    taps.delete(cb);
  };
}

/**
 * Each tap hears the event on its own: one that throws is logged and the rest still hear it.
 * The slice already took the event, so a tap's failure is not a reason to resync it.
 */
function tellTaps(ev: EventView): void {
  for (const tap of taps) {
    try {
      tap(ev);
    } catch (err) {
      console.error(`code-foundry: a ${ev.source} event tap failed`, err);
    }
  }
}

/** Applies the event to its slice, then tells the taps. A slice handler's throw reaches the caller. */
export function dispatchEvent(ev: EventView): void {
  (handlers[ev.source] as (e: EventView["event"]) => void)(ev.event);
  tellTaps(ev);
}

/**
 * The sources an observer applies (startEventSync's observer): the slices a page's bridge
 * reads (stores/bridgeSources.ts) and the page source its storage follows. Not the window's
 * own (the layout, intents, the bell and its toasts): an observer shows none of them.
 */
const OBSERVED: ReadonlySet<EventView["source"]> = new Set(["project", "workspace", "terminal", "threadList", "thread", "gh", "settings", "update", "action", "plugin", "page"]);

/** dispatchEvent for an observer: the observed slices only; every tap still hears every event (the ui source's intents reach a page that way). */
export function dispatchObserved(ev: EventView): void {
  if (OBSERVED.has(ev.source)) (handlers[ev.source] as (e: EventView["event"]) => void)(ev.event);
  tellTaps(ev);
}

/**
 * How often a slice handler's throw may restart the stream from snapshots
 * (docs/notes/event-handler-throw-resync.md). A throw within it, or on a snapshot event, is
 * contained: logged, and the stream carries on past the event.
 */
export const HANDLER_RESYNC_COOLDOWN_MS = 60_000;

/** Ends an attempt whose slice handler threw on a live event, so the next one starts from snapshots. */
class HandlerFailedError extends Error {
  constructor(source: EventView["source"]) {
    super(`a ${source} update failed; reloading state`);
    this.name = "HandlerFailedError";
  }
}

/** Lists threads without failing the resync: a failed List keeps the threads it has. */
export async function reconcileThreads(signal: AbortSignal): Promise<void> {
  try {
    const list = await listThreads(daemon, signal);
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, list), loaded: true, error: null, epoch: s.epoch + 1 }));
  } catch (err) {
    if (isAbort(err)) throw err;
    useThreadsStore.setState({ error: errorMessage(err) });
  }
}

/**
 * Keeps every slice in sync over one EventService.Watch. On initial connect the stream's
 * snapshots populate projects, workspaces, terminals and threads without redundant List
 * RPCs. Reconnects pass the highest received `(seq, epoch)` so short blips replay missed
 * events incrementally; if the daemon restarted or the hub log wrapped and fell back to
 * snapshots (`seq === 0n`), terminal removals are reconciled from the snapshot burst and
 * watched gh details/branch lists are invalidated so nothing stays stale.
 *
 * An observer (the shot window's page check, docs/notes/page-self-check.md) keeps only the
 * slices a page's bridge reads (dispatchObserved), as a client the daemon counts as no
 * window, and tells it no visibility or focus.
 */
export function startEventSync({ observer = false }: { observer?: boolean } = {}): () => void {
  // Counted in ticks, not by the clock: a Mac waking from sleep is not a silent stream.
  let delivered = false;
  let quietTicks = 0;
  // Resume cursor across reconnects (reset cleanly on daemon restart or snapshot fallback).
  let lastSeq = 0n;
  let lastEpoch = "";
  let hadConnected = false;
  // Per-attempt snapshot reconciliation state.
  let reconnecting = false;
  let attemptFirstEvent = true;
  let attemptSawLive = false;
  let lastEnvelopeSeq = 0n;
  let snapshotTerminals: Set<string> | null = null;
  let ghSnapshotInvalidated = false;

  let schemaLoadedEpoch: string | null = null;
  // A slice handler's throw (see HANDLER_RESYNC_COOLDOWN_MS): when it last restarted the stream
  // from snapshots, and whether a live event was skipped since without one.
  let handlerResyncAt: number | null = null;
  let skippedLive = false;
  const resyncAfterThrow = (source: EventView["source"]): HandlerFailedError => {
    handlerResyncAt = Date.now();
    skippedLive = false;
    // Forget the cursor: resuming would replay the event that threw.
    lastSeq = 0n;
    if (!observer) notify({ id: "event-handler-failed", level: "error", title: "A live update failed", description: "Code Foundry reloaded its state from the daemon. The console has the details." });
    return new HandlerFailedError(source);
  };

  const onEnvelope = (meta: EventEnvelope): void => {
    if (meta.epoch) {
      if (meta.epoch !== lastEpoch) {
        if (lastEpoch) {
          // Daemon restarted: reset seq and reload schema (model registry may have changed).
          lastSeq = 0n;
        }
        lastEpoch = meta.epoch;
      }
      if (schemaLoadedEpoch !== meta.epoch) {
        schemaLoadedEpoch = meta.epoch;
        void loadSettingsSchema();
      }
    } else if (schemaLoadedEpoch === null) {
      schemaLoadedEpoch = "";
      void loadSettingsSchema();
    }
    if (meta.isHeartbeat) {
      // A resume-at-head heartbeat confirms the attempt resumed without snapshot fallback;
      // clear attemptFirstEvent so a later mid-stream seq-0 resync is never treated as a
      // full reconnect fallback that would wipe terminals.
      attemptFirstEvent = false;
      return;
    }
    lastEnvelopeSeq = meta.seq;
    if (meta.seq > 0n) {
      attemptSawLive = true;
      ghSnapshotInvalidated = false;
    } else if (reconnecting && attemptFirstEvent) {
      // Reconnect fell back to full snapshots (log wrapped or daemon restarted): reset seq
      // and collect terminal snapshot IDs to prune any terminals that exited while disconnected.
      lastSeq = 0n;
      snapshotTerminals = new Set<string>();
      // The snapshots rebuild every slice, a skipped event's too.
      skippedLive = false;
    }
    attemptFirstEvent = false;
  };

  const deliver = observer ? dispatchObserved : dispatchEvent;
  const onEvent = (ev: EventView): void => {
    hadConnected = true;
    const live = lastEnvelopeSeq > 0n;
    const mayResync = () => handlerResyncAt === null || Date.now() - handlerResyncAt >= HANDLER_RESYNC_COOLDOWN_MS;
    // A live event skipped during the cooldown: once it is over, resync before going on.
    if (skippedLive && live && mayResync()) throw resyncAfterThrow(ev.source);
    if (snapshotTerminals !== null) {
      if (ev.source === "terminal" && ev.event.kind === "updated") {
        snapshotTerminals.add(ev.event.terminal.id);
      } else if (ev.source === "threadList" && ev.event.kind === "snapshot") {
        // Terminal snapshot events always precede threadList snapshot in EventService.Watch.
        const keep = snapshotTerminals;
        snapshotTerminals = null;
        useTerminalsStore.setState((s) => {
          const kept = s.order.filter((id) => keep.has(id));
          if (kept.length === s.order.length && s.loaded) return s;
          const byId: Record<string, TerminalView> = {};
          for (const id of kept) {
            const t = s.byId[id];
            if (t) byId[id] = t;
          }
          return { byId, order: kept, loaded: true };
        });
      }
    }
    try {
      deliver(ev);
    } catch (err) {
      console.error(`code-foundry: the ${ev.source} handler failed on an event`, ev.event, err);
      // A live event's throw restarts the stream from snapshots, so the slice is rebuilt instead
      // of resumed past (or, resuming at it, replayed into the same throw forever). A snapshot
      // event's throw would come back with the next snapshot, and one within the cooldown would
      // loop: those are skipped, a live one marked for a resync after the cooldown.
      if (live && mayResync()) throw resyncAfterThrow(ev.source);
      if (live) skippedLive = true;
    }
    if (lastEnvelopeSeq > lastSeq) lastSeq = lastEnvelopeSeq;
    // A full gh snapshot on reconnect (or after a mid-stream gh drop resync) invalidates
    // viewer, dashboard and repo activity via its events, but not watched PR details or
    // branch lists; invalidate those once per gh snapshot burst so they do not wait 60s-5m.
    if (ev.source === "gh") {
      if (lastEnvelopeSeq === 0n && (reconnecting || attemptSawLive) && !ghSnapshotInvalidated) {
        ghSnapshotInvalidated = true;
        invalidateWatchedGhOnReconnect();
      }
    } else {
      ghSnapshotInvalidated = false;
    }
  };

  const stop = runStream<EventView>({
    open: (signal) => {
      reconnecting = hadConnected;
      attemptFirstEvent = true;
      attemptSawLive = false;
      lastEnvelopeSeq = 0n;
      snapshotTerminals = null;
      ghSnapshotInvalidated = false;
      return watchEvents(signal, daemon, observer, {
        sinceSeq: lastSeq,
        sinceEpoch: lastEpoch,
        onEnvelope,
      });
    },
    onEvent,
    onStatus: (stream, err) => {
      if (stream === "connecting" || stream === "retrying") delivered = false;
      useEventsStore.setState({ stream, streamError: err ?? null });
    },
    onMessage: () => {
      delivered = true;
      quietTicks = 0;
      if (useEventsStore.getState().silent) useEventsStore.setState({ silent: false });
    },
    onError: (err) => {
      // A handler's throw is ours, not the transport's: the endpoint is fine.
      if (!(err instanceof HandlerFailedError)) invalidateOnTransportError(err);
    },
  });
  const silence = setInterval(() => {
    // Silence is a daemon that answers and streams nothing; a down daemon is the red dot.
    const answers = useHealthStore.getState().status === "ok";
    quietTicks = delivered || !answers ? 0 : quietTicks + 1;
    const silent = quietTicks * HEARTBEAT_MS >= SILENT_MS;
    if (silent !== useEventsStore.getState().silent) useEventsStore.setState({ silent });
  }, HEARTBEAT_MS);
  // The daemon polls GitHub less while no GUI window is visible, and counts an open
  // thread as seen only while a window is visible and focused.
  const unwatchPageState = observer ? () => undefined : onPageStateChange(() => void reportClientState());
  return () => {
    unwatchPageState();
    clearInterval(silence);
    stop();
  };
}
