import { create } from "zustand";
import { Code, ConnectError } from "@connectrpc/connect";
import { daemon, invalidateOnTransportError } from "@/api/endpoint";
import { reportClientState, watchEvents, type EventView } from "@/api/events";
import { listProjects } from "@/api/project";
import { listThreads } from "@/api/threads";
import { errorMessage, isAbort, onPageStateChange, runStream, type StreamStatus } from "@/api/stream";
import { listTerminals } from "@/api/terminal";
import { applyActionEvent, useActionsStore } from "./actions";
import { onActionRunFinished } from "./actionActions";
import { closeEmptyPanels, onNewTerminal, onRemovedTerminal, revealArrived } from "./bottomActions";
import { applyGhEvent } from "./gh";
import { applyGitOpsEvent } from "./gitops";
import { applyIntent } from "./intents";
import { applyMemoryEvent } from "./memory";
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
}

export const useEventsStore = create<EventsState>()(() => ({ stream: "connecting", streamError: null }));

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
    // A terminal the store did not have (not one the reconnect's List already brought):
    // a new shell opens its owner's bottom panel (stores/bottomActions.ts).
    // A removed one that was its panel's active tab hands that to its neighbour; its
    // panel's last tab hides the panel.
    const before = useTerminalsStore.getState();
    const fresh = ev.kind === "updated" && before.loaded && !(ev.terminal.id in before.byId) ? ev.terminal : null;
    const removed = ev.kind === "removed" ? before.byId[ev.id] : undefined;
    useTerminalsStore.setState((s) => applyTerminalEvent(s, ev));
    if (fresh) onNewTerminal(fresh);
    if (removed) onRemovedTerminal(removed, before);
  },
  threadList: (ev) => {
    // Thread events prove the service exists, even if List failed transiently.
    useThreadsStore.setState((s) => ({
      ...applyThreadListEvent(s, ev),
      retiredUsage: applyRetiredUsage(s.retiredUsage, ev),
      availability: "available",
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
    useActionsStore.setState((s) => ({ ...applyActionEvent(s, ev), loaded: true }));
    // A failed worktree-create run toasts (stores/actionActions.ts).
    if (ev.kind === "runFinished") onActionRunFinished(ev.finished);
  },
  // Plugins and their surfaces' availability (stores/plugins.ts re-lists commands).
  plugin: onPluginEvent,
  // The Skills marketplace read again: an open Settings → Skills re-reads (stores/skill.ts).
  skill: (ev) => { onSkillEpoch(ev.epoch); },
  // The app memory, for Settings › Memory (stores/memory.ts).
  memory: applyMemoryEvent,
  // The user's own themes (stores/themes.ts; src/themes resolves them).
  theme: applyThemeEvent,
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

/** True when the error means the daemon does not serve the RPC (older daemon). */
function isMissingService(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  return err.code === Code.Unimplemented || err.code === Code.NotFound || /HTTP 404/.test(err.rawMessage);
}

/** Lists threads without failing the resync: a daemon without ThreadService still works. */
async function reconcileThreads(signal: AbortSignal): Promise<void> {
  try {
    const list = await listThreads(daemon, signal);
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, list), loaded: true, availability: "available", error: null, epoch: s.epoch + 1 }));
  } catch (err) {
    if (isAbort(err)) throw err;
    const missing = isMissingService(err);
    useThreadsStore.setState((s) => ({
      ...(missing ? replaceThreads(s, []) : s),
      availability: missing ? "unavailable" : s.availability,
      error: missing ? "service unavailable" : errorMessage(err),
    }));
  }
}

/**
 * Keeps every slice in sync over one EventService.Watch. On each (re)connect the
 * per-service List calls run alongside the stream (events are buffered until they
 * resolve), so a reconnect reconciles removals the stream's snapshot cannot express
 * (terminal.proto has no snapshot message). Threads are retried every `threadRetryMs`
 * while the service is unavailable.
 */
export function startEventSync(threadRetryMs = 10_000): () => void {
  const stop = runStream<EventView>({
    open: (signal) => watchEvents(signal),
    slot: { label: "events", priority: "core" },
    onConnect: async (signal) => {
      // The schema carries the model registry; a restarted daemon may have a new one.
      void loadSettingsSchema();
      const [projects, terminals] = await Promise.all([listProjects(daemon, signal), listTerminals(daemon, signal), reconcileThreads(signal)]);
      useProjectsStore.setState({ ...replaceProjects(projects), loaded: true });
      useTerminalsStore.setState((s) => ({ ...replaceTerminals(s, terminals), loaded: true }));
      // The List brings terminals without updated events: a pending reveal's shell may be here now.
      revealArrived();
      // Nor removed events: a restarted daemon pruned its shells, so open panels left
      // without tabs hide (as a last tab's removal does) instead of showing empty.
      closeEmptyPanels();
    },
    onEvent: dispatchEvent,
    onStatus: (stream, err) => {
      useEventsStore.setState({ stream, streamError: err ?? null });
    },
    onError: invalidateOnTransportError,
  });
  // The daemon polls GitHub less while no GUI window is visible, and counts an open
  // thread as seen only while a window is visible and focused.
  const unwatchPageState = onPageStateChange(() => void reportClientState());
  const retry = setInterval(() => {
    if (useThreadsStore.getState().availability === "unavailable" && useEventsStore.getState().stream === "open") {
      void reconcileThreads(new AbortController().signal).catch(() => undefined);
    }
  }, threadRetryMs);
  return () => {
    unwatchPageState();
    clearInterval(retry);
    stop();
  };
}
