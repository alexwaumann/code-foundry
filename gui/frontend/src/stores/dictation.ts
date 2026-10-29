/**
 * Dictation in the GUI (docs/notes/dictation-4-gui.md): the daemon's snapshot from one
 * shared DictationService.Watch (held while something on screen needs it), this window's
 * session (the composer that pressed the mic, its Session stream, its phrases), and
 * dictation.toggle's presentation (⌘⇧M). One composer dictates at a time: starting
 * another stops the first, and a session someone else holds (another window, the CLI) is
 * stopped before this one starts (the daemon refuses a second session).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { dictationSession, startDictation, stopDictation, watchDictation, type DictationSessionEventView, type DictationView } from "@/api/dictation";
import { invalidateOnTransportError } from "@/api/endpoint";
import { errorMessage, runStream } from "@/api/stream";
import { resettleStreamSlots, type StreamPriority } from "@/api/streamSlots";
import { useSettingsStore } from "./settings";

/** The setting that turns dictation on. */
export const DICTATION_ENABLED = "dictation.enabled";
/** How long Send waits for a flushed session's last phrase (the daemon bounds its own wait at 1.5 s). */
export const FLUSH_WAIT_MS = 2_000;

export type DictationPhase = "starting" | "listening" | "stopping";

/** This window's session. */
export interface ActiveDictation {
  clientId: string;
  phase: DictationPhase;
  /** "" until Start answers. */
  sessionId: string;
  /** When listening began here (Start answered); 0 before. */
  startedAtMs: number;
}

interface DictationSlice {
  /** The daemon's last snapshot; null before the first (or with no Watch ever held). */
  snapshot: DictationView | null;
  active: ActiveDictation | null;
  /** The composer that last pressed the mic: the microphone-denied line shows under it. */
  lastClientId: string;
  /** Why the last Start in a composer failed, shown under it until its next press. */
  failure: { clientId: string; message: string } | null;
}

export const useDictationStore = create<DictationSlice>()(() => ({ snapshot: null, active: null, lastClientId: "", failure: null }));

// ---------- the Watch stream ----------

let holders = 0;
let coreHolders = 0;
let stopWatch: (() => void) | null = null;

/**
 * Holds the Watch stream for a view that needs the snapshot (a composer while dictation
 * is on, the settings section), opening it for the first holder and closing it after the
 * last. `priority`: composers hold it "inline" (a core stream may take its slot; the mic
 * then hides until it has one again), the settings section "core". Returns the release.
 */
export function holdDictation(priority: StreamPriority): () => void {
  const core = priority === "core" ? 1 : 0;
  holders++;
  coreHolders += core;
  if (stopWatch === null) {
    stopWatch = runStream<DictationView>({
      open: (signal) => watchDictation(signal),
      slot: { label: "dictation:watch", priority: () => (coreHolders > 0 ? "core" : "inline") },
      resyncOnVisible: true,
      onEvent: applySnapshot,
      onError: invalidateOnTransportError,
    });
  } else if (core) resettleStreamSlots();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    coreHolders -= core;
    if (holders > 0) return;
    stopWatch?.();
    stopWatch = null;
  };
}

/** Holds the Watch stream while mounted and `on` (useEffect around holdDictation). */
export function useHoldDictation(on: boolean, priority: StreamPriority): void {
  useEffect(() => (on ? holdDictation(priority) : undefined), [on, priority]);
}

function applySnapshot(s: DictationView): void {
  useDictationStore.setState({ snapshot: s });
  // macOS refused the microphone: nothing will be heard, so the session ends here and
  // the composer says why (the denied line).
  const a = useDictationStore.getState().active;
  if (s.micDenied && a && a.phase === "listening") void stopActive(false);
}

// ---------- selectors ----------

/** dictation.enabled from the settings snapshot: composers hold the Watch only while it is on. */
export function useDictationSettingOn(): boolean {
  return useSettingsStore((s) => s.snapshot?.values[DICTATION_ENABLED] === "true");
}

/** What a composer's mic shows: nothing (off, no model, no snapshot yet), the mic, or the mic disabled by an engine failure. */
export type MicAvailability = "hidden" | "ready" | "error";

export function micAvailability(s: DictationView | null): MicAvailability {
  if (!s?.enabled || !s.model.downloaded) return "hidden";
  switch (s.state) {
    case "ready":
    case "unloaded":
    case "loading":
    case "listening":
      return "ready";
    case "error":
      return "error";
    default:
      return "hidden";
  }
}

// ---------- composers ----------

/** A mounted composer the mic and ⌘⇧M can dictate into. */
export interface DictationTarget {
  clientId: string;
  /** Its root element: ⌘⇧M dictates into the composer that has the keyboard. */
  root: () => HTMLElement | null;
  /** The content pane's composer: ⌘⇧M with no composer focused dictates here. */
  primary: boolean;
  /** Puts a phrase at the caret. */
  insert: (text: string) => void;
}

const targets = new Map<string, DictationTarget>();

/** A composer registers while mounted; unmounting the dictating one ends its session. Returns the unregister. */
export function registerDictationTarget(t: DictationTarget): () => void {
  targets.set(t.clientId, t);
  return () => {
    if (targets.get(t.clientId) === t) targets.delete(t.clientId);
    if (useDictationStore.getState().active?.clientId === t.clientId) void stopActive(false);
  };
}

// ---------- levels ----------

type LevelListener = (rms: number) => void;
const levelListeners = new Set<LevelListener>();

/** Level events of this window's session, outside React (the pill animates its bars itself). */
export function onDictationLevel(cb: LevelListener): () => void {
  levelListeners.add(cb);
  return () => {
    levelListeners.delete(cb);
  };
}

// ---------- the session ----------

let stopSession: (() => void) | null = null;
/** Aborts a Start still waiting (the model loading) when the user stops first. */
let startAbort: AbortController | null = null;
let endedWaiters: (() => void)[] = [];

function setActive(a: ActiveDictation | null): void {
  useDictationStore.setState({ active: a });
}

/** The session ended (ended, a failed Start, a stop before Start answered): back to idle. */
function finish(): void {
  stopSession?.();
  stopSession = null;
  setActive(null);
  const w = endedWaiters;
  endedWaiters = [];
  for (const r of w) r();
}

function onSessionEvent(clientId: string, ev: DictationSessionEventView): void {
  switch (ev.kind) {
    case "level":
      for (const l of levelListeners) l(ev.rms);
      break;
    case "phrase":
      targets.get(clientId)?.insert(ev.text);
      break;
    case "ended":
      // Auto-stop (silence), Stop, disabling: the mic is simply idle again.
      finish();
      break;
  }
}

function openSession(clientId: string, sessionId: string): void {
  stopSession = runStream<DictationSessionEventView>({
    open: (signal) => dictationSession(sessionId, signal),
    slot: { label: "dictation:session", priority: "core" },
    shouldReconnectOnEnd: () => false,
    onEvent: (ev) => {
      onSessionEvent(clientId, ev);
    },
    onStatus: (status) => {
      // NotFound (the daemon restarted): there is no session any more.
      if (status === "stopped" && useDictationStore.getState().active?.sessionId === sessionId) finish();
    },
    onError: invalidateOnTransportError,
  });
}

/** Resolves once this window's session has ended, or after `ms`. */
function waitEnded(ms: number): Promise<void> {
  if (!useDictationStore.getState().active) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      resolve();
    }
    endedWaiters.push(done);
  });
}

/**
 * Stops this window's session. With flush the last phrase lands first; resolves once the
 * session ended (bounded by FLUSH_WAIT_MS past the Stop).
 */
async function stopActive(flush: boolean): Promise<void> {
  const a = useDictationStore.getState().active;
  if (!a) return;
  if (a.phase === "starting") {
    // Start has not answered (the model loads): give it up; a session it opens anyway is stopped when it answers.
    setActive({ ...a, phase: "stopping" });
    startAbort?.abort();
    return waitEnded(FLUSH_WAIT_MS);
  }
  if (a.phase === "stopping") return waitEnded(FLUSH_WAIT_MS);
  setActive({ ...a, phase: "stopping" });
  const ended = waitEnded(FLUSH_WAIT_MS + 500);
  try {
    await stopDictation(a.sessionId, flush);
  } catch (err) {
    console.warn("dictation stop", errorMessage(err));
    finish();
  }
  await ended;
  // No ended arrived in time (a stream that dropped): idle anyway.
  if (useDictationStore.getState().active?.sessionId === a.sessionId) finish();
}

/** Starts dictating into a composer, ending this window's other session (or anyone's) first. */
async function startFor(clientId: string): Promise<void> {
  const st = useDictationStore.getState();
  if (st.active) await stopActive(true);
  const other = useDictationStore.getState().snapshot?.session;
  // Another window's composer (or the CLI) holds the one session: it gives way.
  if (other && !useDictationStore.getState().active) {
    try {
      await stopDictation(other.id, true);
    } catch (err) {
      console.warn("dictation stop (other)", errorMessage(err));
    }
  }
  useDictationStore.setState({ active: { clientId, phase: "starting", sessionId: "", startedAtMs: 0 }, lastClientId: clientId, failure: null });
  const ctl = new AbortController();
  startAbort = ctl;
  let sessionId: string;
  try {
    sessionId = await startDictationAbortable(clientId, ctl.signal);
  } catch (err) {
    if (startAbort === ctl) startAbort = null;
    const cancelled = ctl.signal.aborted;
    finish();
    if (!cancelled) useDictationStore.setState({ failure: { clientId, message: errorMessage(err) } });
    return;
  }
  if (startAbort === ctl) startAbort = null;
  const now = useDictationStore.getState().active;
  if (now?.clientId !== clientId || now.phase !== "starting") {
    // Stopped (or switched) while Start waited.
    void stopDictation(sessionId, false).catch(() => undefined);
    if (now?.clientId === clientId) finish();
    return;
  }
  setActive({ clientId, phase: "listening", sessionId, startedAtMs: Date.now() });
  openSession(clientId, sessionId);
}

/** startDictation that gives up when the signal aborts (the request itself is abandoned; the daemon bounds its wait). */
function startDictationAbortable(clientId: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
    startDictation(clientId).then(
      (id) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) void stopDictation(id, false).catch(() => undefined);
        else resolve(id);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** The mic, the pill and ⌘⇧M: stop when this composer dictates, else start here. */
export function toggleDictation(clientId: string): void {
  const a = useDictationStore.getState().active;
  if (a?.clientId === clientId) void stopActive(false);
  else void startFor(clientId);
}

/** Pill click and Escape: stop this composer's session; true when it had one. */
export function stopDictationIn(clientId: string): boolean {
  const a = useDictationStore.getState().active;
  if (a?.clientId !== clientId) return false;
  void stopActive(false);
  return true;
}

/** Whether a composer dictates now (any phase): Send then waits for its last phrase. */
export function isDictatingIn(clientId: string): boolean {
  return useDictationStore.getState().active?.clientId === clientId;
}

/**
 * Send while dictating: stop with flush and wait (bounded) for the session to end, so
 * its last phrase is in the draft before it is sent. Resolves at once when this composer
 * is not dictating.
 */
export async function flushDictationIn(clientId: string): Promise<void> {
  if (!isDictatingIn(clientId)) return;
  await stopActive(true);
}

/**
 * dictation.toggle in this window: the composer that has the keyboard; else the one
 * dictating (it stops); else the content pane's composer. False when there is none.
 */
export function presentDictationToggle(): boolean {
  const active = document.activeElement;
  const mounted = [...targets.values()].filter((t) => t.root()?.isConnected);
  const focused = active ? mounted.find((t) => t.root()?.contains(active)) : undefined;
  const dictating = useDictationStore.getState().active?.clientId;
  const target = focused?.clientId ?? dictating ?? mounted.find((t) => t.primary)?.clientId;
  if (!target) return false;
  if (micAvailability(useDictationStore.getState().snapshot) === "hidden") return false;
  toggleDictation(target);
  return true;
}

/** Tests: the module's session state back to idle. */
export function resetDictationForTests(): void {
  stopSession?.();
  stopSession = null;
  startAbort = null;
  endedWaiters = [];
  targets.clear();
  levelListeners.clear();
  useDictationStore.setState({ snapshot: null, active: null, lastClientId: "", failure: null });
}
