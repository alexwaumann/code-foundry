/**
 * A fake DictationService for unit tests (stores/dictation.ts and the components that use
 * it), standing in for @/api/dictation's Watch, Session, Start and Stop:
 *
 *   vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));
 *
 * `publish` sends a snapshot to every open Watch (and to the next one opened); `phrase`
 * and `end` drive the open session. Every Start and Stop is recorded in `calls` as the
 * mock daemon does ("start <client>", "stop <session> <flush>"). Stop ends the session
 * ("stopped"), after the flush phrase when one is set; Start answers at once unless
 * `holdStart` made it wait.
 */
import type { DictationEndView, DictationSessionEventView, DictationView } from "@/api/dictation";
import type { Heartbeat } from "@/api/stream";

/** A pushable stream: what a test pushes, the iterator yields; it ends on end() or the signal. */
class Channel<T> {
  private queue: T[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(v: T): void {
    if (this.done) return;
    this.queue.push(v);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  get ended(): boolean {
    return this.done;
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<T> {
    const onAbort = () => {
      this.end();
    };
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.done || signal.aborted) return;
        await new Promise<void>((r) => {
          this.wake = r;
        });
        this.wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** A snapshot: dictation on, the model downloaded, ready, on an M4 Pro (the mock's default). */
export function dictationSnap(o: Partial<Omit<DictationView, "model" | "hardware">> & { model?: Partial<DictationView["model"]>; hardware?: Partial<DictationView["hardware"]> } = {}): DictationView {
  const { model, hardware, ...rest } = o;
  return {
    enabled: true,
    state: "ready",
    session: null,
    error: "",
    micDenied: false,
    ...rest,
    model: { name: "ggml-large-v3-turbo-q8_0.bin", sizeBytes: 874_188_075, downloaded: true, download: null, ...model },
    hardware: { chip: "Apple M4 Pro", memoryBytes: 48 * 2 ** 30, m1Family: false, ...hardware },
  };
}

interface Session {
  id: string;
  clientId: string;
  events: Channel<DictationSessionEventView>;
}

const watchers = new Set<Channel<DictationView>>();
const sessions = new Map<string, Session>();
let latest: DictationView | null = null;
let nextId = 1;
let flushPhrase = "";
let startGate: Promise<void> | null = null;

function lastSession(): string {
  return [...sessions.keys()].at(-1) ?? "";
}

function phrase(text: string, sessionId = lastSession()): void {
  sessions.get(sessionId)?.events.push({ kind: "phrase", text });
}

function end(reason: DictationEndView = "stopped", sessionId = lastSession()): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.events.push({ kind: "ended", reason });
  s.events.end();
  sessions.delete(sessionId);
}

const calls: string[] = [];

export interface FakeDictation {
  /** "start <client>", "stop <session> <flush>", in order. */
  readonly calls: readonly string[];
  /** Sends a snapshot to every open Watch; one opened later starts with it. */
  publish(s: DictationView): void;
  /** The phrase Stop with flush sends before the session ends. */
  setFlushPhrase(text: string): void;
  /** Start waits until the returned release is called (the model loading). */
  holdStart(): () => void;
  /** The open session's id (the last one started). */
  readonly sessionId: string;
  phrase(text: string, sessionId?: string): void;
  end(reason?: DictationEndView, sessionId?: string): void;
  reset(): void;
}

export const fakeDictation: FakeDictation = {
  calls,
  publish(s) {
    latest = s;
    for (const w of watchers) w.push(s);
  },
  setFlushPhrase(text) {
    flushPhrase = text;
  },
  holdStart() {
    let release: () => void = () => undefined;
    startGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      startGate = null;
      release();
    };
  },
  get sessionId() {
    return lastSession();
  },
  phrase,
  end,
  reset() {
    for (const w of watchers) w.end();
    watchers.clear();
    for (const s of sessions.values()) s.events.end();
    sessions.clear();
    latest = null;
    nextId = 1;
    flushPhrase = "";
    startGate = null;
    calls.length = 0;
  },
};

/** The @/api/dictation functions the store calls, over the fake. */
export const fakeDictationApi = {
  watchDictation(signal: AbortSignal): AsyncGenerator<DictationView | Heartbeat> {
    const ch = new Channel<DictationView>();
    watchers.add(ch);
    if (latest) ch.push(latest);
    return ch.iterate(signal);
  },

  dictationSession(sessionId: string, signal: AbortSignal): AsyncGenerator<DictationSessionEventView | Heartbeat> {
    const s = sessions.get(sessionId);
    if (!s) {
      const none = new Channel<DictationSessionEventView>();
      none.end();
      return none.iterate(signal);
    }
    return s.events.iterate(signal);
  },

  async startDictation(clientId: string): Promise<string> {
    calls.push(`start ${clientId}`);
    if (startGate) await startGate;
    const id = `dict-${String(nextId++)}`;
    sessions.set(id, { id, clientId, events: new Channel() });
    return id;
  },

  stopDictation(sessionId: string, flush: boolean): Promise<void> {
    calls.push(`stop ${sessionId} ${String(flush)}`);
    if (flush && flushPhrase) phrase(flushPhrase, sessionId);
    end("stopped", sessionId);
    return Promise.resolve();
  },
};
