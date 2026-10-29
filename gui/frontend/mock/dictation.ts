/**
 * Mock dictation (docs/notes/dictation-2-daemon.md, dictation-4-gui.md): DictationService
 * and the dictation.* commands, with no engine and no microphone. Enabled is the
 * dictation.enabled setting; the rest is scripted. A session plays levels every 50 ms and
 * the script's phrases (default two, 1 s apart); Stop with flush plays the flush phrase
 * first when the script has one. Download fills in over about 1.5 s and turns dictation on.
 *
 * Controls (mock/server.ts):
 *   POST /__mock/dictation?state=off|no-model|downloading|ready|unloaded|listening|error[&m1=true][&denied=true]
 *        (off: dictation off, no model; downloading: a static 557 MB of 874 MB; listening: the
 *        CLI holds a session; unloaded: Start loads for loadMs first)
 *   POST /__mock/dictation/script?phrases=One.|Two.[&gap=1000][&flush=Tail.][&loadMs=800][&silence=1]
 *        (silence=1: the session ends "silence" after its phrases)
 *   POST /__mock/dictation/end?reason=silence|stopped|disabled|error   (the open session ends)
 *   GET  /__mock/dictation                         ({ state, enabled, session, calls })
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { DictationEndReason, DictationState, type DictationSessionEventSchema, type DictationSnapshotSchema } from "../src/gen/codefoundry/v1/dictation_pb";
import { CommandError } from "./errors";
import { Hub } from "./hub";

type SnapshotInit = MessageInitShape<typeof DictationSnapshotSchema>;
type SessionEventInit = MessageInitShape<typeof DictationSessionEventSchema>;

export const MODEL_NAME = "ggml-large-v3-turbo-q8_0.bin";
export const MODEL_SIZE = 874_188_075;
const M4 = { chip: "Apple M4 Pro", memoryBytes: 48 * 2 ** 30, m1Family: false };
const M1 = { chip: "Apple M1 Pro", memoryBytes: 16 * 2 ** 30, m1Family: true };
const DEFAULT_PHRASES = ["Then add a table test for the race.", "And run it with the detector on."];

export interface DictationCommandEntry {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    noPalette?: boolean;
    args: [];
    confirm?: (ctx: UiContext | undefined) => string;
    confirmLabel?: string;
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
}

interface MockSession {
  id: string;
  clientId: string;
  startedAt: Date;
  hub: Hub<SessionEventInit>;
  timers: ReturnType<typeof setTimeout>[];
  ended: DictationEndReason | null;
}

export class MockDictation {
  private downloaded = false;
  private download: { received: number; total: number; bps: number; timer: ReturnType<typeof setInterval> | null } | null = null;
  private unloaded = false;
  private loading = false;
  private error = "";
  private micDenied = false;
  private hardware = M4;
  private session: MockSession | null = null;
  private readonly ended = new Map<string, MockSession>();
  private nextId = 1;
  private script = { phrases: DEFAULT_PHRASES, gapMs: 1000, flush: "", loadMs: 800, silence: false };
  private readonly hub = new Hub<SnapshotInit>();
  /** "start <client>", "stop <session> <flush>", "download", "cancel", "remove", "denied <bool>". */
  calls: string[] = [];

  constructor(
    private readonly deps: {
      enabled: () => boolean;
      setEnabled: (on: boolean) => void;
      emit: (view: string) => number;
    },
  ) {}

  reset(): void {
    this.endSession(DictationEndReason.DISABLED);
    this.ended.clear();
    this.stopDownload();
    this.downloaded = false;
    this.unloaded = false;
    this.loading = false;
    this.error = "";
    this.micDenied = false;
    this.hardware = M4;
    this.script = { phrases: DEFAULT_PHRASES, gapMs: 1000, flush: "", loadMs: 800, silence: false };
    this.calls = [];
    this.publish();
  }

  /** dictation.enabled changed (World's settings callback): off ends a session, like the daemon. */
  settingsChanged(): void {
    if (!this.deps.enabled() && this.session) this.endSession(DictationEndReason.DISABLED);
    if (!this.deps.enabled()) this.error = "";
    this.publish();
  }

  private state(): DictationState {
    if (this.download) return DictationState.DOWNLOADING;
    if (!this.deps.enabled()) return DictationState.DISABLED;
    if (!this.downloaded) return DictationState.NO_MODEL;
    if (this.error) return DictationState.ERROR;
    if (this.session && !this.loading) return DictationState.LISTENING;
    if (this.loading) return DictationState.LOADING;
    if (this.unloaded) return DictationState.UNLOADED;
    return DictationState.READY;
  }

  snapshot(): SnapshotInit {
    const d = this.download;
    return {
      enabled: this.deps.enabled(),
      state: this.state(),
      model: {
        name: MODEL_NAME,
        sizeBytes: BigInt(MODEL_SIZE),
        downloaded: this.downloaded,
        download: d ? { receivedBytes: BigInt(Math.floor(d.received)), totalBytes: BigInt(d.total), bytesPerSecond: BigInt(d.bps) } : undefined,
      },
      hardware: { chip: this.hardware.chip, memoryBytes: BigInt(this.hardware.memoryBytes), m1Family: this.hardware.m1Family },
      session: this.session && !this.loading ? { id: this.session.id, clientId: this.session.clientId, startedAt: timestampFromDate(this.session.startedAt) } : undefined,
      error: this.error,
      micDenied: this.micDenied,
    };
  }

  private publish(): void {
    this.hub.publish(this.snapshot());
  }

  watch(signal: AbortSignal): AsyncGenerator<SnapshotInit> {
    return this.hub.subscribe(signal, [this.snapshot()]);
  }

  // ---- downloads ----

  startDownload(): SnapshotInit {
    if (this.downloaded) throw new CommandError("unavailable", "the model is already downloaded");
    this.calls.push("download");
    if (this.download) return this.snapshot();
    const d: { received: number; total: number; bps: number; timer: ReturnType<typeof setInterval> | null } = { received: 0, total: MODEL_SIZE, bps: 0, timer: null };
    this.download = d;
    this.error = "";
    d.timer = setInterval(() => {
      d.received = Math.min(d.total, d.received + d.total / 15);
      d.bps = 11_200_000;
      if (d.received >= d.total) {
        this.stopDownload();
        this.downloaded = true;
        // Like the daemon: a finished download turns dictation on.
        if (!this.deps.enabled()) this.deps.setEnabled(true);
      }
      this.publish();
    }, 100);
    this.publish();
    return this.snapshot();
  }

  cancelDownload(): SnapshotInit {
    this.calls.push("cancel");
    this.stopDownload();
    this.publish();
    return this.snapshot();
  }

  removeModel(): SnapshotInit {
    this.calls.push("remove");
    this.stopDownload();
    this.endSession(DictationEndReason.DISABLED);
    this.downloaded = false;
    this.error = "";
    this.publish();
    return this.snapshot();
  }

  private stopDownload(): void {
    if (this.download?.timer) clearInterval(this.download.timer);
    this.download = null;
  }

  // ---- sessions ----

  async start(clientId: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(`start ${clientId}`);
    if (!this.deps.enabled()) throw new CommandError("unavailable", "dictation is off (settings: dictation.enabled)");
    if (!this.downloaded) throw new CommandError("unavailable", "the dictation model is not downloaded");
    if (this.error) throw new CommandError("unavailable", `dictation failed: ${this.error}`);
    if (this.session && !this.session.ended) {
      if (this.session.clientId === clientId) return this.session.id;
      throw new ConnectError("another composer is dictating; stop it first", Code.Aborted);
    }
    const s: MockSession = { id: `dict-${String(this.nextId++)}`, clientId, startedAt: new Date(), hub: new Hub<SessionEventInit>(), timers: [], ended: null };
    this.session = s;
    if (this.unloaded) {
      this.loading = true;
      this.publish();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.script.loadMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.loading = false;
      this.unloaded = false;
      if (signal?.aborted || this.session !== s) {
        if (this.session === s) this.session = null;
        this.publish();
        throw new ConnectError("cancelled", Code.Canceled);
      }
      s.startedAt = new Date();
    }
    this.play(s);
    this.publish();
    return s.id;
  }

  /** Levels every 50 ms, the script's phrases `gapMs` apart, and silence's end when scripted. */
  private play(s: MockSession): void {
    let t = 0;
    const level = setInterval(() => {
      t += 1;
      // Speech-like: syllables (a fast wobble) inside words (a slower one).
      const rms = 0.005 + 0.11 * Math.abs(Math.sin(t * 1.7)) * Math.abs(Math.sin(t * 0.45));
      s.hub.publish({ event: { case: "level", value: { rms } } });
    }, 50);
    s.timers.push(level);
    this.script.phrases.forEach((text, i) => {
      s.timers.push(
        setTimeout(() => {
          s.hub.publish({ event: { case: "phrase", value: { text } } });
        }, this.script.gapMs * (i + 1)),
      );
    });
    if (this.script.silence) {
      s.timers.push(
        setTimeout(() => {
          if (this.session === s) this.endSession(DictationEndReason.SILENCE);
        }, this.script.gapMs * (this.script.phrases.length + 1)),
      );
    }
  }

  stop(sessionId: string, flush: boolean): void {
    this.calls.push(`stop ${sessionId} ${String(flush)}`);
    const s = this.session;
    if (s?.id !== sessionId) return;
    if (flush && this.script.flush) s.hub.publish({ event: { case: "phrase", value: { text: this.script.flush } } });
    this.endSession(DictationEndReason.STOPPED);
  }

  /** The open session ends with `reason` (controls, disabling, removing). */
  endSession(reason: DictationEndReason): void {
    const s = this.session;
    if (!s) return;
    for (const t of s.timers) clearTimeout(t);
    s.ended = reason;
    s.hub.publish({ event: { case: "ended", value: { reason } } });
    this.ended.set(s.id, s);
    this.session = null;
    this.loading = false;
    this.publish();
  }

  /** Session: a heartbeat first (opening the stream), then the session's events until ended. */
  async *sessionEvents(sessionId: string, signal: AbortSignal): AsyncGenerator<SessionEventInit> {
    const s = this.session?.id === sessionId ? this.session : this.ended.get(sessionId);
    if (!s) throw new CommandError("notfound", `no dictation session ${sessionId}`);
    yield { event: { case: "heartbeat", value: {} } };
    if (s.ended !== null) {
      yield { event: { case: "ended", value: { reason: s.ended } } };
      return;
    }
    for await (const ev of s.hub.subscribe(signal)) {
      yield ev;
      if (ev.event?.case === "ended") return;
    }
  }

  setMicDenied(denied: boolean): void {
    this.calls.push(`denied ${String(denied)}`);
    this.micDenied = denied;
    this.publish();
  }

  // ---- controls ----

  control(q: URLSearchParams): Record<string, unknown> {
    const state = q.get("state");
    if (q.has("m1")) this.hardware = q.get("m1") === "true" ? M1 : M4;
    if (q.has("denied")) this.micDenied = q.get("denied") === "true";
    if (state !== null) {
      this.endSession(DictationEndReason.DISABLED);
      this.stopDownload();
      this.error = "";
      this.unloaded = false;
      this.loading = false;
      const on = state !== "off" && state !== "downloading";
      this.downloaded = !["off", "no-model", "downloading"].includes(state);
      if (state === "downloading") this.download = { received: 557_000_000, total: MODEL_SIZE, bps: 11_200_000, timer: null };
      if (state === "unloaded") this.unloaded = true;
      if (state === "error") this.error = "the engine exited 3 times in a row: signal: killed";
      if (this.deps.enabled() !== on) this.deps.setEnabled(on);
      if (state === "listening") {
        const s: MockSession = { id: `dict-${String(this.nextId++)}`, clientId: "cli", startedAt: new Date(), hub: new Hub<SessionEventInit>(), timers: [], ended: null };
        this.session = s;
      }
    }
    this.publish();
    return this.json();
  }

  scriptControl(q: URLSearchParams): Record<string, unknown> {
    if (q.has("phrases")) this.script.phrases = (q.get("phrases") ?? "").split("|").filter(Boolean);
    if (q.has("gap")) this.script.gapMs = Number(q.get("gap"));
    if (q.has("flush")) this.script.flush = q.get("flush") ?? "";
    if (q.has("loadMs")) this.script.loadMs = Number(q.get("loadMs"));
    if (q.has("silence")) this.script.silence = q.get("silence") === "1";
    return this.json();
  }

  endControl(q: URLSearchParams): Record<string, unknown> {
    const reasons: Record<string, DictationEndReason> = {
      silence: DictationEndReason.SILENCE,
      stopped: DictationEndReason.STOPPED,
      disabled: DictationEndReason.DISABLED,
      error: DictationEndReason.ERROR,
    };
    this.endSession(reasons[q.get("reason") ?? "silence"] ?? DictationEndReason.SILENCE);
    return this.json();
  }

  json(): Record<string, unknown> {
    return {
      state: DictationState[this.state()],
      enabled: this.deps.enabled(),
      downloaded: this.downloaded,
      session: this.session ? { id: this.session.id, clientId: this.session.clientId } : null,
      micDenied: this.micDenied,
      calls: this.calls,
    };
  }

  // ---- commands (internal/command/commands_dictation.go) ----

  commands(): DictationCommandEntry[] {
    const usable = () => this.deps.enabled() && this.downloaded;
    return [
      {
        cmd: {
          name: "dictation.toggle",
          title: "Dictate",
          category: "Dictation",
          description: "Start or stop dictating into the focused composer. Speech is transcribed on this Mac; each phrase lands at the caret.",
          keybindings: ["cmd+shift+m"],
          args: [],
        },
        when: usable,
        run: () => `delivered=${String(this.deps.emit("dictation.toggle"))}`,
      },
      {
        cmd: {
          name: "dictation.download",
          title: "Download Dictation Model",
          category: "Dictation",
          description: "Download the Whisper model dictation uses (about 0.9 GB, once) in the background; an interrupted download resumes. Dictation turns on when it finishes.",
          keybindings: [],
          args: [],
        },
        when: () => !this.downloaded && !this.download,
        run: () => {
          this.startDownload();
          return `downloading ${MODEL_NAME} (874 MB); dictation turns on when it finishes (dictation.status shows progress)`;
        },
      },
      {
        cmd: { name: "dictation.download.cancel", title: "Cancel Dictation Model Download", category: "Dictation", description: "Stop downloading the dictation model, keeping what arrived so the next download resumes.", keybindings: [], args: [] },
        when: () => this.download !== null,
        run: () => {
          this.cancelDownload();
          return "download cancelled";
        },
      },
      {
        cmd: {
          name: "dictation.remove",
          title: "Remove Dictation Model",
          category: "Dictation",
          description: "Delete the dictation model from this Mac, stopping dictation until it is downloaded again.",
          keybindings: [],
          args: [],
          confirm: () => "Remove the dictation model? Dictation stops until you download it again (about 0.9 GB).",
          confirmLabel: "Remove",
        },
        when: () => this.downloaded || this.download !== null,
        run: () => {
          this.removeModel();
          return "dictation model removed";
        },
      },
      {
        cmd: { name: "dictation.status", noPalette: true, title: "Dictation Status", category: "Dictation", description: "Show dictation's state.", keybindings: [], args: [] },
        when: () => true,
        run: () => `dictation: ${DictationState[this.state()].toLowerCase()}`,
      },
    ];
  }
}
