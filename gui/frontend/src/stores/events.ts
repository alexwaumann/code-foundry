import { create } from "zustand";
import { Code, ConnectError } from "@connectrpc/connect";
import { daemon, invalidateOnTransportError } from "@/api/endpoint";
import { watchEvents, type EventView } from "@/api/events";
import { listRepos } from "@/api/repo";
import { listSessions } from "@/api/threads";
import { errorMessage, isAbort, runStream, type StreamStatus } from "@/api/stream";
import { listTerminals } from "@/api/terminal";
import { applyActionEvent, useActionsStore } from "./actions";
import { onActionRunFinished } from "./actionActions";
import { closeEmptyPanels, onNewTerminal, onRemovedTerminal, revealArrived } from "./bottomActions";
import { applyGhEvent } from "./gh";
import { applyGitOpsEvent } from "./gitops";
import { applyIntent } from "./intents";
import { applyRepoEvent, replaceRepos, useReposStore } from "./repos";
import { applyRetiredUsage, applySessionEvent, replaceSessions, useSessionsStore } from "./threads";
import { applySettingsSnapshot, loadSettingsSchema } from "./settings";
import { applyTerminalEvent, replaceTerminals, useTerminalsStore } from "./terminals";
import { applyThreadSourceEvent, pruneThreadLogs } from "./thread";
import { applyUpdateEvent } from "./update";
import { applyWorkspaceEvent, useWorkspacesStore } from "./workspaces";
import { applyRepoEventToDetails } from "./worktreeDetail";

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
  repo: (ev) => {
    useReposStore.setState((s) => applyRepoEvent(s, ev));
    applyRepoEventToDetails(ev);
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
  session: (ev) => {
    // Session events prove the service exists, even if List failed transiently.
    useSessionsStore.setState((s) => ({
      ...applySessionEvent(s, ev),
      retiredUsage: applyRetiredUsage(s.retiredUsage, ev),
      availability: "available",
      error: null,
      epoch: ev.kind === "snapshot" ? s.epoch + 1 : s.epoch,
    }));
    // A removed thread's items go with it.
    if (ev.kind === "removed" || ev.kind === "snapshot") pruneThreadLogs((id) => id in useSessionsStore.getState().byId);
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
};

export function dispatchEvent(ev: EventView): void {
  (handlers[ev.source] as (e: EventView["event"]) => void)(ev.event);
}

/** True when the error means the daemon does not serve the RPC (older daemon). */
function isMissingService(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  return err.code === Code.Unimplemented || err.code === Code.NotFound || /HTTP 404/.test(err.rawMessage);
}

/** Lists sessions without failing the resync: a daemon without ThreadService still works. */
async function reconcileSessions(signal: AbortSignal): Promise<void> {
  try {
    const list = await listSessions(daemon, signal);
    useSessionsStore.setState((s) => ({ ...replaceSessions(s, list), loaded: true, availability: "available", error: null, epoch: s.epoch + 1 }));
  } catch (err) {
    if (isAbort(err)) throw err;
    const missing = isMissingService(err);
    useSessionsStore.setState((s) => ({
      ...(missing ? replaceSessions(s, []) : s),
      availability: missing ? "unavailable" : s.availability,
      error: missing ? "service unavailable" : errorMessage(err),
    }));
  }
}

/**
 * Keeps every slice in sync over one EventService.Watch. On each (re)connect the
 * per-service List calls run alongside the stream (events are buffered until they
 * resolve), so a reconnect reconciles removals the stream's snapshot cannot express
 * (terminal.proto has no snapshot message). Sessions are retried every `sessionRetryMs`
 * while the service is unavailable.
 */
export function startEventSync(sessionRetryMs = 10_000): () => void {
  const stop = runStream<EventView>({
    open: (signal) => watchEvents(signal),
    onConnect: async (signal) => {
      // The schema carries the model registry; a restarted daemon may have a new one.
      void loadSettingsSchema();
      const [repos, terminals] = await Promise.all([listRepos(daemon, signal), listTerminals(daemon, signal), reconcileSessions(signal)]);
      useReposStore.setState({ ...replaceRepos(repos), loaded: true });
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
  const retry = setInterval(() => {
    if (useSessionsStore.getState().availability === "unavailable" && useEventsStore.getState().stream === "open") {
      void reconcileSessions(new AbortController().signal).catch(() => undefined);
    }
  }, sessionRetryMs);
  return () => {
    clearInterval(retry);
    stop();
  };
}
