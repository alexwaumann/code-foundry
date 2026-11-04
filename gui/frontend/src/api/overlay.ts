/**
 * The dictation overlay's page as it reaches the host and the daemon
 * (docs/notes/dictate-anywhere-overlay.md, gui/overlay.go). The host wakes the page with a
 * session id and hides it when told; everything else comes from the daemon.
 */
import { Events } from "@wailsio/runtime";
import { PageDone, PageReady } from "../../bindings/github.com/alexwaumann/code-foundry/gui/overlayservice";
import { UiService } from "@/gen/codefoundry/v1/ui_pb";
import { watchDictation, dictationSession, type DictationEndView, type DictationSessionEventView, type DictationView } from "./dictation";
import { daemon, DaemonConnection, invalidateOnTransportError, type DaemonEndpoint } from "./endpoint";
import { runStream } from "./stream";

/** The host showed the panel for a session; data is its id (gui/overlay.go EventOverlayBegin). */
export const EVENT_OVERLAY_BEGIN = "dictation-overlay:begin";

/**
 * The same daemon under the other loopback name. Both webviews share WebKit's network
 * session, whose six connections are per host (api/streamSlots.ts), and the main window
 * may hold five streams and need the sixth for its calls. Under its own host name the
 * overlay's streams never take one.
 */
export function ownHostEndpoint(ep: DaemonEndpoint): DaemonEndpoint {
  return { ...ep, baseUrl: ep.baseUrl.replace("//127.0.0.1", "//localhost") };
}

/** Resolved fresh after every invalidate, so a restarted daemon's port and token are picked up. */
const overlayDaemon = new DaemonConnection(async () => {
  daemon.invalidate();
  return ownHostEndpoint(await daemon.resolveEndpoint());
});

/** The active theme's resolved slots, as last published. */
export async function overlayThemeVars(): Promise<Readonly<Record<string, string>>> {
  try {
    const c = await overlayDaemon.client(UiService);
    return (await c.getTheme({})).vars;
  } catch (err) {
    invalidateOnTransportError(err, overlayDaemon);
    throw err;
  }
}

export interface OverlayStreamHandlers {
  /** The session is stopping with a flush. */
  onStopping: () => void;
  onLevel: (rms: number) => void;
  onEnded: (reason: DictationEndView) => void;
  /** The stream gave up without an end. */
  onLost: () => void;
}

/** Follows one session on Watch and Session until the returned stop is called. */
export function followOverlaySession(sessionId: string, h: OverlayStreamHandlers): () => void {
  const stopWatch = runStream<DictationView>({
    open: (signal) => watchDictation(signal, overlayDaemon),
    slot: { label: "overlay:watch", priority: "core" },
    onEvent: (s) => {
      if (s.session?.id === sessionId && s.session.stopping) h.onStopping();
    },
    onError: (err) => {
      invalidateOnTransportError(err, overlayDaemon);
    },
  });
  const stopSession = runStream<DictationSessionEventView>({
    open: (signal) => dictationSession(sessionId, signal, overlayDaemon),
    slot: { label: "overlay:session", priority: "core" },
    shouldReconnectOnEnd: () => false,
    onEvent: (ev) => {
      if (ev.kind === "level") h.onLevel(ev.rms);
      else if (ev.kind === "ended") h.onEnded(ev.reason);
    },
    onStatus: (status) => {
      if (status === "stopped") h.onLost();
    },
    onError: (err) => {
      invalidateOnTransportError(err, overlayDaemon);
    },
  });
  return () => {
    stopWatch();
    stopSession();
  };
}

/** Calls fn with each session the host shows the panel for. Returns an unsubscribe. */
export function onOverlayBegin(fn: (sessionId: string) => void): () => void {
  return Events.On(EVENT_OVERLAY_BEGIN, (ev) => {
    const id: unknown = ev.data;
    if (typeof id === "string" && id !== "") fn(id);
  });
}

/** A session shown before this page could hear the event, or "". */
export async function overlayPageReady(): Promise<string> {
  return PageReady();
}

/** Asks the host to hide the panel: the page has finished with the session. */
export async function overlayPageDone(sessionId: string): Promise<void> {
  await PageDone(sessionId);
}
