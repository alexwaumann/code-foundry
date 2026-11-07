/**
 * The dictation overlay's page as it reaches the host and the daemon
 * (docs/notes/dictate-anywhere-overlay.md, gui/overlay.go). The host wakes the page with a
 * session id and hides it when told; everything else comes from the daemon.
 */
import { Events } from "@wailsio/runtime";
import { PageDone, PageReady } from "../../bindings/github.com/alexwaumann/code-foundry/gui/overlayservice";
import { UiService } from "@/gen/codefoundry/v1/ui_pb";
import { watchDictation, dictationSession, type DictationEndView, type DictationSessionEventView, type DictationView } from "./dictation";
import { daemon, invalidateOnTransportError } from "./endpoint";
import { runStream } from "./stream";

/** The host showed the panel for a session; data is its id (gui/overlay.go EventOverlayBegin). */
export const EVENT_OVERLAY_BEGIN = "dictation-overlay:begin";

/** The active theme's resolved slots, as last published. */
export async function overlayThemeVars(): Promise<Readonly<Record<string, string>>> {
  try {
    const c = await daemon.client(UiService);
    return (await c.getTheme({})).vars;
  } catch (err) {
    invalidateOnTransportError(err);
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
    open: (signal) => watchDictation(signal),
    onEvent: (s) => {
      if (s.session?.id === sessionId && s.session.stopping) h.onStopping();
    },
    onError: invalidateOnTransportError,
  });
  const stopSession = runStream<DictationSessionEventView>({
    open: (signal) => dictationSession(sessionId, signal),
    shouldReconnectOnEnd: () => false,
    onEvent: (ev) => {
      if (ev.kind === "level") h.onLevel(ev.rms);
      else if (ev.kind === "ended") h.onEnded(ev.reason);
    },
    onStatus: (status) => {
      if (status === "stopped") h.onLost();
    },
    onError: invalidateOnTransportError,
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
