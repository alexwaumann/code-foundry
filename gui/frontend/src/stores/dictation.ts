/**
 * Dictation in the GUI (docs/notes/dictation-4-gui.md): the daemon's snapshot from one
 * shared DictationService.Watch (held while something on screen needs it), this window's
 * session (the composer that pressed the mic, its Session stream, its phrases), and
 * dictation.toggle's presentation. One composer dictates at a time: starting
 * another stops the first, and a session someone else holds (another window, the CLI) is
 * stopped before this one starts (the daemon refuses a second session).
 *
 * The host's hold key (docs/notes/dictate-anywhere.md) drives the same session through
 * dictation.hold, and reads composer_target and field_target to know where a hold goes: a
 * composer, the text field that has the keyboard (the host pastes into it), or nowhere.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { dictationSession, reportComposerTarget, startDictation, stopDictation, watchDictation, type DictationSessionEventView, type DictationView } from "@/api/dictation";
import { invalidateOnTransportError } from "@/api/endpoint";
import { errorMessage, runStream } from "@/api/stream";
import { isTextField } from "@/lib/dictation";
import { useLayoutStore } from "./layout";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";

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
  /** When Allow was last pressed (the settings row's advice waits on it); 0 before. */
  allowedAtMs: number;
}

export const useDictationStore = create<DictationSlice>()(() => ({ snapshot: null, active: null, lastClientId: "", failure: null, allowedAtMs: 0 }));

// ---------- the Watch stream ----------

let holders = 0;
let stopWatch: (() => void) | null = null;

/**
 * Holds the Watch stream for a view that needs the snapshot (a composer while dictation
 * is on, the settings section), opening it for the first holder and closing it after the
 * last. Returns the release.
 */
export function holdDictation(): () => void {
  holders++;
  if (stopWatch === null) {
    stopWatch = runStream<DictationView>({
      open: (signal) => watchDictation(signal),
      onEvent: applySnapshot,
      onError: invalidateOnTransportError,
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0) return;
    stopWatch?.();
    stopWatch = null;
  };
}

/** Holds the Watch stream while mounted and `on` (useEffect around holdDictation). */
export function useHoldDictation(on: boolean): void {
  useEffect(() => (on ? holdDictation() : undefined), [on]);
}

function applySnapshot(s: DictationView): void {
  useDictationStore.setState({ snapshot: s });
  // The snapshot is the daemon's word, so a restarted daemon is told again.
  sentTarget = null;
  syncComposerTarget();
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

/** A mounted composer the mic and dictation.toggle can dictate into. */
export interface DictationTarget {
  clientId: string;
  /** Its root element: ⌘⇧M dictates into the composer that has the keyboard. */
  root: () => HTMLElement | null;
  /** A pane's own composer (a thread's, the new-thread composer's): dictation may go here while it has no keyboard (contextComposer). */
  primary: boolean;
  /** The thread it writes to; absent for the new-thread composer. */
  threadId?: string;
  /** Puts a phrase at the caret. */
  insert: (text: string) => void;
}

const targets = new Map<string, DictationTarget>();

/** A composer registers while mounted; unmounting the dictating one ends its session. Returns the unregister. */
export function registerDictationTarget(t: DictationTarget): () => void {
  targets.set(t.clientId, t);
  followFocus();
  syncComposerTarget();
  return () => {
    if (targets.get(t.clientId) === t) targets.delete(t.clientId);
    if (useDictationStore.getState().active?.clientId === t.clientId) void stopActive(false);
    syncComposerTarget();
  };
}

/** Where dictation goes now: into a composer, into the text field that has the keyboard, or nowhere (null). */
type Destination = { kind: "composer"; clientId: string } | { kind: "field" } | null;

/**
 * The composer of the thread the keyboard is in, when it is on screen. In a pane: the pane's
 * own composer (a thread's tab, its quick terminal under it, the new-thread composer's tab);
 * else the composer of the thread the pane's tab is linked to (its terminal, its diff, its
 * pull request), which is mounted only while that thread is the selected tab of a pane in
 * this space. Outside the panes (the sidebar, the page): the selected thread's composer, or
 * the new-thread composer when that is what is selected. None when the keyboard is in
 * something that belongs to no thread on screen, such as a terminal linked to nothing.
 */
function contextComposer(active: Element | null, mounted: readonly DictationTarget[]): DictationTarget | undefined {
  const primaries = mounted.filter((t) => t.primary);
  const paneEl = active?.closest<HTMLElement>("[data-pane-id]") ?? null;
  if (paneEl) {
    const own = primaries.find((t) => paneEl.contains(t.root()));
    if (own) return own;
    const layout = useLayoutStore.getState();
    const thread = layout.tabs[layout.panes[paneEl.dataset.paneId ?? ""]?.active ?? ""]?.thread ?? "";
    return thread ? primaries.find((t) => t.threadId === thread) : undefined;
  }
  const sel = useUiStore.getState().selection;
  if (sel.kind === "thread") return primaries.find((t) => t.threadId === sel.id);
  if (sel.kind === "compose") return primaries.find((t) => t.threadId === undefined);
  return undefined;
}

/**
 * Where dictation goes (docs/notes/dictation-focused-field.md): the composer that has the
 * keyboard; else the text field that has it (a note's, a search's, a setting's: the host
 * pastes the words into it on release, as in any other app, gui/hold.go routeHold); else the
 * composer of the thread the keyboard is in, when it is on screen (contextComposer); else
 * the composer already dictating (dictation.toggle stops it); else nowhere, and then a hold
 * does nothing at all rather than put the words somewhere the user is not looking.
 */
function pickDestination(): Destination {
  const active = document.activeElement;
  const mounted = [...targets.values()].filter((t) => t.root()?.isConnected);
  const focused = active ? mounted.find((t) => t.root()?.contains(active)) : undefined;
  if (focused) return { kind: "composer", clientId: focused.clientId };
  if (isTextField(active)) return { kind: "field" };
  const context = contextComposer(active, mounted);
  if (context) return { kind: "composer", clientId: context.clientId };
  const dictating = useDictationStore.getState().active?.clientId;
  return dictating ? { kind: "composer", clientId: dictating } : null;
}

/** The composer dictation goes to (pickDestination), or null. */
function pickTarget(): string | null {
  const d = pickDestination();
  return d?.kind === "composer" ? d.clientId : null;
}

// ---------- what the host's hold key needs to know ----------

/** How long focus settles before the answer is read: moving between two composers passes through none. */
const FOCUS_SETTLE_MS = 50;

/** What this window last sent and the daemon has not yet echoed: "composer", "field" or "none". */
let sentTarget: string | null = null;
let focusFollowed = false;
let focusTimer: ReturnType<typeof setTimeout> | null = null;

/** Tells the daemon when the answer to "where does a hold in this window go?" changed. Nothing while dictation is off. */
function syncComposerTarget(): void {
  const snap = useDictationStore.getState().snapshot;
  if (!snap?.enabled) return;
  const now = pickDestination()?.kind ?? "none";
  const known = sentTarget ?? (snap.composerTarget ? "composer" : snap.fieldTarget ? "field" : "none");
  if (now === known) return;
  sentTarget = now;
  reportComposerTarget(now === "composer", now === "field").catch((err: unknown) => {
    sentTarget = null;
    console.warn("dictation composer target", errorMessage(err));
  });
}

/** Where a hold goes follows the keyboard (pickDestination), so every focus change is looked at. */
function followFocus(): void {
  if (focusFollowed) return;
  focusFollowed = true;
  const settle = () => {
    if (focusTimer !== null) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = null;
      syncComposerTarget();
    }, FOCUS_SETTLE_MS);
  };
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  // The selection and the panes' tabs decide it too (contextComposer).
  useUiStore.subscribe((now, was) => {
    if (now.selection !== was.selection) settle();
  });
  useLayoutStore.subscribe((now, was) => {
    if (now.panes !== was.panes || now.tabs !== was.tabs) settle();
  });
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
 * session ended (bounded by FLUSH_WAIT_MS past the Stop). `tail` is a release of the hold
 * key: the daemon hears out the word still being said first.
 */
async function stopActive(flush: boolean, tail = false): Promise<void> {
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
    await stopDictation(a.sessionId, flush, tail);
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
  if (st.active) {
    // A Stop on a session stopping cuts a hold's tail: this press should not wait it out.
    if (st.active.phase === "stopping" && st.active.sessionId) void stopDictation(st.active.sessionId, true).catch(() => undefined);
    await stopActive(true);
  }
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
 * dictation.toggle in this window: the composer pickDestination names. False when there is
 * none (a text field or nothing takes it).
 */
export function presentDictationToggle(): boolean {
  const target = pickTarget();
  if (!target) return false;
  if (micAvailability(useDictationStore.getState().snapshot) === "hidden") return false;
  toggleDictation(target);
  return true;
}

/** The Start a press of the hold key is waiting on. */
let holdStart: Promise<void> = Promise.resolve();

/**
 * dictation.hold in this window: the host's hold key, for the composer dictation.toggle
 * would pick. A press starts it (a session already open there is kept, one on its way out
 * is not); a release stops it with the last phrase and its tail, a discard without. A stop
 * while the press is still getting its session waits for it, as Start may not have gone out
 * yet: nothing else would close the microphone it opens.
 */
export function presentDictationHold(phase: string | undefined): boolean {
  if (phase === "press") {
    const target = pickTarget();
    if (!target || micAvailability(useDictationStore.getState().snapshot) === "hidden") return false;
    const a = useDictationStore.getState().active;
    if (a?.clientId !== target || a.phase === "stopping") holdStart = startFor(target);
    return true;
  }
  const release = phase === "release";
  const pressed = holdStart;
  void stopActive(release, release)
    .then(() => pressed)
    .then(() => (holdStart === pressed ? stopActive(release, release) : undefined)); // a later press owns what is open now
  return true;
}

/** dictation.allow's row: remembers the press, so the advice can follow if nothing changes. */
export function noteDictationAllow(atMs: number): void {
  useDictationStore.setState({ allowedAtMs: atMs });
}

/** Tests: the module's session state back to idle. */
export function resetDictationForTests(): void {
  stopSession?.();
  stopSession = null;
  startAbort = null;
  endedWaiters = [];
  targets.clear();
  levelListeners.clear();
  sentTarget = null;
  holdStart = Promise.resolve();
  if (focusTimer !== null) clearTimeout(focusTimer);
  focusTimer = null;
  useDictationStore.setState({ snapshot: null, active: null, lastClientId: "", failure: null, allowedAtMs: 0 });
}
