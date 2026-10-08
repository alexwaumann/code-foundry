import type { AttachEventView } from "@/api/terminal";
import { errorMessage, runStream, type StreamStatus } from "@/api/stream";
import type { Disposable, TerminalRenderer } from "./renderer";

export type AttachPhase = "idle" | "connecting" | "live" | "reconnecting" | "exited" | "error";

export interface AttachState {
  terminalId: string | null;
  phase: AttachPhase;
  exitCode: number | null;
  error: string | null;
}

export interface AttachDeps {
  attach: (id: string, signal: AbortSignal) => AsyncIterable<AttachEventView>;
  write: (id: string, data: Uint8Array) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  onStreamError?: (err: unknown) => void;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Owns the attach lifecycle for one renderer. At most one terminal is attached at a
 * time: attach(id) aborts the previous stream before opening the next.
 *
 *   Snapshot -> reset(), size to the snapshot, write(data), then fit (which may Resize)
 *   Output   -> write
 *   Resized  -> resize (no Resize RPC back)
 *   Exited   -> phase "exited"; no reconnect after the stream ends
 *
 * Input is sent through an ordered queue (one Write in flight, later bytes coalesced),
 * so keystrokes never reorder across concurrent requests. Viewport resizes are
 * debounced into one Resize RPC.
 */
export class AttachController {
  private stopStream: (() => void) | null = null;
  private state: AttachState = { terminalId: null, phase: "idle", exitCode: null, error: null };
  private readonly subs: Disposable[];
  private pending: Uint8Array[] = [];
  private flushing = false;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(
    private readonly renderer: TerminalRenderer,
    private readonly deps: AttachDeps,
    private readonly onState: (s: AttachState) => void,
    private readonly resizeDebounceMs = 80,
  ) {
    this.subs = [
      renderer.onData((data) => {
        this.input(data);
      }),
      renderer.onResize(({ cols, rows }) => {
        this.scheduleResize(cols, rows);
      }),
    ];
  }

  get current(): AttachState {
    return this.state;
  }

  private setState(patch: Partial<AttachState>): void {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  attach(id: string): void {
    if (this.state.terminalId === id && this.stopStream) return;
    this.detach();
    const gen = ++this.generation;
    this.renderer.reset();
    this.setState({ terminalId: id, phase: "connecting", exitCode: null, error: null });
    this.stopStream = runStream<AttachEventView>({
      open: (signal) => this.deps.attach(id, signal),
      onEvent: (ev) => {
        if (gen === this.generation) this.handle(ev);
      },
      onStatus: (s: StreamStatus, err) => {
        if (gen !== this.generation) return;
        if (s === "retrying" && this.state.phase !== "exited") this.setState({ phase: "reconnecting", error: err ?? null });
        if (s === "stopped" && err) this.setState({ phase: "error", error: err });
      },
      shouldReconnectOnEnd: () => this.state.phase !== "exited",
      onError: (err) => {
        this.deps.onStreamError?.(err);
      },
    });
  }

  detach(): void {
    this.generation++;
    this.stopStream?.();
    this.stopStream = null;
    clearTimeout(this.resizeTimer);
    this.pending = [];
    if (this.state.terminalId !== null) this.setState({ terminalId: null, phase: "idle", exitCode: null, error: null });
  }

  private handle(ev: AttachEventView): void {
    switch (ev.kind) {
      case "snapshot": {
        this.renderer.reset();
        if (ev.cols > 0 && ev.rows > 0) this.renderer.resize(ev.cols, ev.rows);
        this.renderer.write(ev.data);
        // The container decides the size; tell the daemon if it differs from the PTY's.
        this.renderer.fit();
        const { cols, rows } = this.renderer.size;
        if (cols !== ev.cols || rows !== ev.rows) this.scheduleResize(cols, rows, 0);
        if (this.state.phase !== "exited") this.setState({ phase: "live", error: null });
        break;
      }
      case "output":
        this.renderer.write(ev.data);
        if (this.state.phase === "reconnecting" || this.state.phase === "connecting") this.setState({ phase: "live", error: null });
        break;
      case "resized":
        this.renderer.resize(ev.cols, ev.rows);
        break;
      case "exited":
        this.setState({ phase: "exited", exitCode: ev.exitCode });
        break;
    }
  }

  private input(data: Uint8Array): void {
    const id = this.state.terminalId;
    if (!id || this.state.phase === "exited" || this.state.phase === "idle") return;
    this.pending.push(data);
    void this.flush(id);
  }

  private async flush(id: string): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0 && this.state.terminalId === id) {
        const chunk = concat(this.pending.splice(0));
        try {
          await this.deps.write(id, chunk);
        } catch (err) {
          this.deps.onStreamError?.(err);
          this.setState({ error: `write failed: ${errorMessage(err)}` });
          this.pending = [];
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private scheduleResize(cols: number, rows: number, delay = this.resizeDebounceMs): void {
    const id = this.state.terminalId;
    if (!id) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.state.terminalId !== id || this.state.phase === "exited") return;
      this.deps.resize(id, cols, rows).catch((err: unknown) => {
        this.deps.onStreamError?.(err);
      });
    }, delay);
  }

  dispose(): void {
    this.detach();
    for (const s of this.subs) s.dispose();
  }
}
