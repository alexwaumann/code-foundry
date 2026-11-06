import type { AttachEventView } from "@/api/terminal";
import { errorMessage, runStream, type Heartbeat, type StreamStatus } from "@/api/stream";
import type { StreamPriority } from "@/api/streamSlots";
import type { Disposable, TerminalRenderer } from "./renderer";

export type AttachPhase = "idle" | "connecting" | "live" | "reconnecting" | "exited" | "error";

export interface AttachState {
  terminalId: string | null;
  phase: AttachPhase;
  exitCode: number | null;
  error: string | null;
}

export interface AttachDeps {
  /** Yields HEARTBEAT for the daemon's heartbeats (runStream's liveness watchdog consumes them). */
  attach: (id: string, signal: AbortSignal) => AsyncIterable<AttachEventView | Heartbeat>;
  write: (id: string, data: Uint8Array) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  onStreamError?: (err: unknown) => void;
  /** The Attach stream's priority (api/streamSlots.ts): "inline" for a plugin's terminal node. Default core. */
  priority?: StreamPriority;
}

/**
 * The most output this side may hold unparsed, xterm's buffer and what waits for a snapshot
 * together. Past it the stream is dropped for a fresh snapshot, which costs nothing: the daemon
 * has the whole screen and its scrollback. About a second of xterm's parsing (9 MB/s under
 * `yes`), so Ctrl-C shows soon, and far below the 50 MB where xterm's write throws.
 */
export const MAX_BEHIND_BYTES = 8 << 20;

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
 *   Snapshot -> once xterm has parsed all it was given: reset(), size to the snapshot,
 *               write(data); once xterm has parsed that, fit (which may Resize) and apply
 *               what arrived meanwhile
 *   Output   -> write (held while a snapshot waits or is being parsed). A stream that outruns
 *               xterm by MAX_BEHIND_BYTES is dropped; a new one opens once xterm has caught up
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
  /**
   * Events that arrived while a snapshot was still being parsed (null: none is). xterm
   * parses a large write over later frames while resize() applies at once, so output or
   * a resize applied before the snapshot lands would draw at the wrong size and the
   * replay would interleave with live output.
   */
  private held: AttachEventView[] | null = null;
  private snapshots = 0;
  /**
   * Bytes xterm was given and has not parsed. These outlive a detach: reset() does not empty
   * xterm's buffer, so what is in it would land on a reset screen, and a snapshot must meet a
   * freshly reset one (internal/store/terminal/snapshot.go).
   */
  private unparsed = 0;
  /** Output accepted and not yet parsed: the unparsed part of it and the part in `held`. */
  private behind = 0;
  /** Runs once xterm has parsed everything (null: nothing waits). */
  private afterParsed: (() => void) | null = null;

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
    this.open(id, gen);
  }

  private open(id: string, gen: number): void {
    this.stopStream = runStream<AttachEventView>({
      open: (signal) => this.deps.attach(id, signal),
      slot: { label: `terminal:${id}`, priority: this.deps.priority ?? "core" },
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
    this.dropHeld();
    this.afterParsed = null;
    this.snapshots++;
    if (this.state.terminalId !== null) this.setState({ terminalId: null, phase: "idle", exitCode: null, error: null });
  }

  private handle(ev: AttachEventView): void {
    if (ev.kind === "snapshot") {
      this.snapshot(ev);
      return;
    }
    if (ev.kind === "output") {
      if (this.behind + ev.data.length > MAX_BEHIND_BYTES) {
        this.fallBehind();
        return;
      }
      this.behind += ev.data.length;
    }
    if (this.held) this.held.push(ev);
    else this.apply(ev);
  }

  /** A new snapshot (a reconnect) replaces whatever the previous one was holding. */
  private snapshot(ev: Extract<AttachEventView, { kind: "snapshot" }>): void {
    const seq = ++this.snapshots;
    this.dropHeld();
    this.held = [];
    this.whenParsed(() => {
      this.renderer.reset();
      if (ev.cols > 0 && ev.rows > 0) this.renderer.resize(ev.cols, ev.rows);
      this.write(ev.data, () => {
        if (seq !== this.snapshots) return;
        this.snapshotParsed(ev.cols, ev.rows);
      });
    });
  }

  /** What the stream had for an up to date terminal: it applies now, in order. */
  private apply(ev: Exclude<AttachEventView, { kind: "snapshot" }>): void {
    switch (ev.kind) {
      case "output":
        this.write(ev.data, () => {
          this.behind -= ev.data.length;
        });
        if (this.state.phase === "reconnecting" || this.state.phase === "connecting") this.setState({ phase: "live", error: null });
        break;
      case "resized":
        this.renderer.resize(ev.cols, ev.rows);
        break;
      case "exited":
        // No input point any more: no cursor (the program may have left it showing).
        this.renderer.hideCursor();
        this.setState({ phase: "exited", exitCode: ev.exitCode });
        break;
    }
  }

  /** Runs in xterm's parse loop through `parsed`, where a throw would end the loop for good. */
  private write(data: Uint8Array, parsed: () => void): void {
    this.unparsed += data.length;
    this.renderer.write(data, () => {
      this.unparsed -= data.length;
      parsed();
      if (this.unparsed > 0) return;
      const next = this.afterParsed;
      this.afterParsed = null;
      next?.();
    });
  }

  /** Now if xterm has nothing left to parse, else then. A later call replaces an earlier one. */
  private whenParsed(fn: () => void): void {
    if (this.unparsed > 0) this.afterParsed = fn;
    else fn();
  }

  private dropHeld(): void {
    for (const ev of this.held ?? []) if (ev.kind === "output") this.behind -= ev.data.length;
    this.held = null;
  }

  /**
   * Output outran xterm: stop taking it, let xterm finish what it has, and open a new stream,
   * whose snapshot has everything dropped here. Waiting for xterm keeps a flood to a reconnect
   * every second or so, with nothing open between them. Input keeps working, so the phase
   * stays: this is not a lost connection.
   */
  private fallBehind(): void {
    const id = this.state.terminalId;
    if (!id) return;
    const gen = this.generation;
    this.stopStream?.();
    this.stopStream = null;
    this.dropHeld();
    this.snapshots++;
    this.whenParsed(() => {
      if (gen === this.generation) this.open(id, gen);
    });
  }

  /** The snapshot is on the grid: fit it to the container, then apply what arrived meanwhile. */
  private snapshotParsed(snapCols: number, snapRows: number): void {
    const held = this.held ?? [];
    this.held = null;
    // The container decides the size; tell the daemon if it differs from the PTY's.
    this.renderer.fit();
    const { cols, rows } = this.renderer.size;
    if (cols !== snapCols || rows !== snapRows) this.scheduleResize(cols, rows, 0);
    if (this.state.phase !== "exited") this.setState({ phase: "live", error: null });
    for (const ev of held) if (ev.kind !== "snapshot") this.apply(ev);
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
