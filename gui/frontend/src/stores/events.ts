import { create } from "zustand";
import { daemon, invalidateOnTransportError } from "@/api/endpoint";
import { reportClientState, watchEvents, type EventView } from "@/api/events";
import { listProjects } from "@/api/project";
import { listThreads } from "@/api/threads";
import { errorMessage, HEARTBEAT_MS, isAbort, onPageStateChange, runStream, type StreamStatus } from "@/api/stream";
import { listTerminals } from "@/api/terminal";
import { applyActionEvent, useActionsStore } from "./actions";
import { onActionRunFinished } from "./actionActions";
import { applyGhEvent } from "./gh";
import { applyGitOpsEvent } from "./gitops";
import { useHealthStore } from "./health";
import { applyIntent } from "./intents";
import { applyLayoutEvent } from "./layout";
import { applyMemoryEvent } from "./memory";
import { applySearchActivity } from "./searchActivity";
import { applyThemeEvent } from "./themes";
import { onPluginEvent } from "./plugins";
import { applyProjectEvent, replaceProjects, useProjectsStore } from "./projects";
import { applyRetiredUsage, applyThreadListEvent, replaceThreads, useThreadsStore } from "./threads";
import { applySettingsSnapshot, loadSettingsSchema } from "./settings";
import { onSkillEpoch } from "./skill";
import { applyTerminalEvent, replaceTerminals, useTerminalsStore } from "./terminals";
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
    useProjectsStore.setState((s) => applyProjectEvent(s, ev));
    applyProjectEventToDetails(ev);
  },
  workspace: (ev) => {
    useWorkspacesStore.setState((s) => ({ ...applyWorkspaceEvent(s, ev), loaded: true }));
  },
  terminal: (ev) => {
    // Where a terminal shows is the layout's (its tab, the quick terminal): the daemon places it.
    useTerminalsStore.setState((s) => applyTerminalEvent(s, ev));
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

export function dispatchEvent(ev: EventView): void {
  (handlers[ev.source] as (e: EventView["event"]) => void)(ev.event);
  for (const tap of taps) tap(ev);
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
 * Keeps every slice in sync over one EventService.Watch. On each (re)connect the
 * per-service List calls run alongside the stream (events are buffered until they
 * resolve), so a reconnect reconciles removals the stream's snapshot cannot express
 * (terminal.proto has no snapshot message).
 */
export function startEventSync(): () => void {
  // Counted in ticks, not by the clock: a Mac waking from sleep is not a silent stream.
  let delivered = false;
  let quietTicks = 0;
  const stop = runStream<EventView>({
    open: (signal) => watchEvents(signal),
    onConnect: async (signal) => {
      // The schema carries the model registry; a restarted daemon may have a new one.
      void loadSettingsSchema();
      const [projects, terminals] = await Promise.all([listProjects(daemon, signal), listTerminals(daemon, signal), reconcileThreads(signal)]);
      useProjectsStore.setState({ ...replaceProjects(projects), loaded: true });
      useTerminalsStore.setState((s) => ({ ...replaceTerminals(s, terminals), loaded: true }));
    },
    onEvent: dispatchEvent,
    onStatus: (stream, err) => {
      if (stream === "connecting" || stream === "retrying") delivered = false;
      useEventsStore.setState({ stream, streamError: err ?? null });
    },
    onMessage: () => {
      delivered = true;
      quietTicks = 0;
      if (useEventsStore.getState().silent) useEventsStore.setState({ silent: false });
    },
    onError: invalidateOnTransportError,
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
  const unwatchPageState = onPageStateChange(() => void reportClientState());
  return () => {
    unwatchPageState();
    clearInterval(silence);
    stop();
  };
}
