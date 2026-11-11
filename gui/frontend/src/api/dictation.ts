/**
 * DictationService (docs/notes/dictation-2-daemon.md, dictation-4-gui.md) as the GUI sees
 * it: the snapshot (Watch), one session's events (Session), and Start and Stop. Download,
 * cancel and remove are user actions, so they run as the dictation.* commands, not here.
 */
import {
  DictationEndReason,
  DictationService,
  DictationState,
  type DictationSessionEvent,
  type DictationSnapshot,
} from "@/gen/codefoundry/v1/dictation_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";
import { ms } from "./timestamp";

export type DictationStateView = "disabled" | "noModel" | "downloading" | "loading" | "ready" | "unloaded" | "listening" | "error";

export interface DictationDownloadView {
  receivedBytes: number;
  totalBytes: number;
  /** 0 until known. */
  bytesPerSecond: number;
}

export interface DictationView {
  /** dictation.enabled. */
  enabled: boolean;
  state: DictationStateView;
  model: {
    name: string;
    sizeBytes: number;
    downloaded: boolean;
    /** The running download; null when none runs. */
    download: DictationDownloadView | null;
  };
  hardware: { chip: string; memoryBytes: number; m1Family: boolean };
  /** The open session; null unless listening. */
  session: { id: string; clientId: string; startedAtMs: number; stopping: boolean } | null;
  /** The engine's failure in ERROR, else the last download's failure ("" when none). */
  error: string;
  /** macOS denied the microphone (the host says so). */
  micDenied: boolean;
  /** What macOS allows the hold key, as the host last said; null before it has. */
  accessibility: DictationAccessibilityView | null;
  /** The daemon's word on whether a composer can take dictation (what this window told it). */
  composerTarget: boolean;
  /** The Mac's inputs and what the settings choose among them, as the host last said; null before it has. */
  microphone: DictationMicrophoneView | null;
}

/** An input device. `transport` says what the menu notes: "bluetooth", "usb", or something it leaves out. */
export interface DictationInputView {
  uid: string;
  name: string;
  transport: string;
}

/** The Microphone row's facts: which of its descriptions, and the names in it. */
export interface DictationMicrophoneView {
  devices: DictationInputView[];
  state: "plain" | "avoiding" | "named" | "missing";
  /** While avoiding: what is listened to, and the Bluetooth default passed over. */
  listeningName: string;
  defaultName: string;
  /** The last name seen for the chosen microphone, connected or not. */
  chosenName: string;
}

/** What macOS allows the hold key. */
export interface DictationAccessibilityView {
  granted: boolean;
  /** Granted, but the host's event tap hears nothing: it needs a restart. */
  tapSilent: boolean;
  /** What System Settings calls the list on this macOS. */
  listName: string;
  /** The host's executable, for adding it to the list by hand. */
  executable: string;
}

export type DictationEndView = "stopped" | "silence" | "disabled" | "error" | "discarded";

export type DictationSessionEventView = { kind: "level"; rms: number } | { kind: "phrase"; text: string } | { kind: "ended"; reason: DictationEndView };

const stateMap: Record<DictationState, DictationStateView> = {
  [DictationState.UNSPECIFIED]: "disabled",
  [DictationState.DISABLED]: "disabled",
  [DictationState.NO_MODEL]: "noModel",
  [DictationState.DOWNLOADING]: "downloading",
  [DictationState.LOADING]: "loading",
  [DictationState.READY]: "ready",
  [DictationState.UNLOADED]: "unloaded",
  [DictationState.LISTENING]: "listening",
  [DictationState.ERROR]: "error",
};

const endMap: Record<DictationEndReason, DictationEndView> = {
  [DictationEndReason.UNSPECIFIED]: "stopped",
  [DictationEndReason.STOPPED]: "stopped",
  [DictationEndReason.SILENCE]: "silence",
  [DictationEndReason.DISABLED]: "disabled",
  [DictationEndReason.ERROR]: "error",
  [DictationEndReason.DISCARDED]: "discarded",
};

function toMicrophoneView(s: DictationSnapshot): DictationMicrophoneView | null {
  const inputs = s.inputs;
  const pick = s.microphonePick;
  if (!inputs || !pick) return null;
  return {
    devices: inputs.devices.map((d) => ({ uid: d.uid, name: d.name, transport: d.transport })),
    state: pick.state === "avoiding" || pick.state === "named" || pick.state === "missing" ? pick.state : "plain",
    listeningName: pick.name,
    defaultName: pick.defaultName,
    chosenName: inputs.microphoneName,
  };
}

export function toDictationView(s: DictationSnapshot): DictationView {
  const m = s.model;
  const d = m?.download;
  const hw = s.hardware;
  return {
    enabled: s.enabled,
    state: stateMap[s.state],
    model: {
      name: m?.name ?? "",
      sizeBytes: Number(m?.sizeBytes ?? 0n),
      downloaded: m?.downloaded ?? false,
      download: d ? { receivedBytes: Number(d.receivedBytes), totalBytes: Number(d.totalBytes), bytesPerSecond: Number(d.bytesPerSecond) } : null,
    },
    hardware: { chip: hw?.chip ?? "", memoryBytes: Number(hw?.memoryBytes ?? 0n), m1Family: hw?.m1Family ?? false },
    session: s.session ? { id: s.session.id, clientId: s.session.clientId, startedAtMs: ms(s.session.startedAt) ?? 0, stopping: s.session.stopping } : null,
    error: s.error,
    micDenied: s.micDenied,
    accessibility: s.accessibility
      ? { granted: s.accessibility.granted, tapSilent: s.accessibility.tapSilent, listName: s.accessibility.listName, executable: s.accessibility.executable }
      : null,
    composerTarget: s.composerTarget,
    microphone: toMicrophoneView(s),
  };
}

/** A session event's view; null for a heartbeat (or an event this GUI does not know). */
export function toDictationSessionEventView(e: DictationSessionEvent): DictationSessionEventView | null {
  switch (e.event.case) {
    case "level":
      return { kind: "level", rms: e.event.value.rms };
    case "phrase":
      return { kind: "phrase", text: e.event.value.text };
    case "ended":
      return { kind: "ended", reason: endMap[e.event.value.reason] };
    default:
      return null;
  }
}

/** DictationService.Watch: the snapshot now and on every change; HEARTBEAT for a heartbeat. */
export async function* watchDictation(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<DictationView | Heartbeat> {
  const c = await conn.client(DictationService);
  for await (const s of c.watch({}, { signal })) yield s.heartbeat ? HEARTBEAT : toDictationView(s);
}

/** DictationService.Session: one session's events, ending after `ended`; HEARTBEAT for a heartbeat. */
export async function* dictationSession(sessionId: string, signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<DictationSessionEventView | Heartbeat> {
  const c = await conn.client(DictationService);
  for await (const e of c.session({ sessionId }, { signal })) {
    if (e.event.case === "heartbeat") {
      yield HEARTBEAT;
      continue;
    }
    const v = toDictationSessionEventView(e);
    if (v) yield v;
  }
}

/** Opens a session for a composer (its client id); resolves to the session id. */
export async function startDictation(clientId: string, conn: DaemonConnection = daemon): Promise<string> {
  const c = await conn.client(DictationService);
  return (await c.start({ clientId })).sessionId;
}

/** Tells the daemon whether this window has a composer dictation can target, for the host's hold key. */
export async function reportComposerTarget(available: boolean, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(DictationService);
  await c.composerTarget({ available });
}

/** Ends a session; with flush its last phrase arrives on Session first (bounded by the daemon: 1.5 s). */
export async function stopDictation(sessionId: string, flush: boolean, tail = false, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(DictationService);
  await c.stop({ sessionId, flush, tail });
}
