import { create } from "zustand";
import { Code, ConnectError } from "@connectrpc/connect";
import { daemon, invalidateOnTransportError } from "@/api/endpoint";
import { watchEvents, type EventView } from "@/api/events";
import { listRepos } from "@/api/repo";
import { listSessions } from "@/api/session";
import { errorMessage, isAbort, runStream, type StreamStatus } from "@/api/stream";
import { listTerminals } from "@/api/terminal";
import { applyGhEvent } from "./gh";
import { applyGitOpsEvent } from "./gitops";
import { applyIntent } from "./intents";
import { applyRepoEvent, replaceRepos, useReposStore } from "./repos";
import { applySessionEvent, replaceSessions, sessionOfTerminal, useSessionsStore } from "./sessions";
import { applySettingsSnapshot } from "./settings";
import { applyTerminalEvent, replaceTerminals, useTerminalsStore } from "./terminals";
import { applyUpdateEvent } from "./update";
import { useUiStore } from "./ui";
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
  terminal: (ev) => {
    useTerminalsStore.setState((s) => applyTerminalEvent(s, ev));
  },
  session: (ev) => {
    // Session events prove the service exists, even if List failed transiently.
    useSessionsStore.setState((s) => ({ ...applySessionEvent(s, ev), availability: "available", error: null }));
  },
  gh: applyGhEvent,
  gitops: applyGitOpsEvent,
  ui: applyIntent,
  settings: applySettingsSnapshot,
  update: applyUpdateEvent,
};

export function dispatchEvent(ev: EventView): void {
  (handlers[ev.source] as (e: EventView["event"]) => void)(ev.event);
  if (ev.source === "terminal" || ev.source === "session") promoteTerminalSelection();
}

/**
 * Terminals of known sessions have no row of their own. If the selection points at one
 * (e.g. a FocusTerminal that raced the session event), show it as its session.
 */
function promoteTerminalSelection(): void {
  const ui = useUiStore.getState();
  if (ui.selection.kind !== "terminal") return;
  const t = useTerminalsStore.getState().byId[ui.selection.id];
  const session = t && sessionOfTerminal(useSessionsStore.getState(), t);
  if (session) ui.select({ kind: "session", id: session.id });
}

/** True when the error means the daemon does not serve the RPC (older daemon). */
function isMissingService(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false;
  return err.code === Code.Unimplemented || err.code === Code.NotFound || /HTTP 404/.test(err.rawMessage);
}

/** Lists sessions without failing the resync: a daemon without SessionService still works. */
async function reconcileSessions(signal: AbortSignal): Promise<void> {
  try {
    const list = await listSessions(daemon, signal);
    useSessionsStore.setState((s) => ({ ...replaceSessions(s, list), loaded: true, availability: "available", error: null }));
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
      const [repos, terminals] = await Promise.all([listRepos(daemon, signal), listTerminals(daemon, signal), reconcileSessions(signal)]);
      useReposStore.setState({ ...replaceRepos(repos), loaded: true });
      useTerminalsStore.setState((s) => ({ ...replaceTerminals(s, terminals), loaded: true }));
      promoteTerminalSelection();
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
