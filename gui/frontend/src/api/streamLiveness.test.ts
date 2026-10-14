/**
 * runStream's liveness watchdog and visibility resync (docs/notes/thread-render-stall.md):
 * the daemon heartbeats quiet streams every HEARTBEAT_MS; a stream that has heartbeated
 * and then goes silent for livenessMs is reconnected, and a stream with resyncOnVisible
 * reconnects at once when the page becomes visible after being hidden.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT, HEARTBEAT_MS, LIVENESS_MS, runStream, StreamSilentError, type Heartbeat, type StreamHandlers, type StreamStatus } from "./stream";

/** A server stream the test drives; each open() is one attempt, numbered from 1. */
function server() {
  let current: { queue: (number | Heartbeat)[]; wake: (() => void) | null } | null = null;
  const s = {
    opened: 0,
    aborted: 0,
    async *open(signal: AbortSignal): AsyncGenerator<number | Heartbeat> {
      s.opened++;
      const attempt = { queue: [] as (number | Heartbeat)[], wake: null as (() => void) | null };
      current = attempt;
      const onAbort = () => attempt.wake?.();
      signal.addEventListener("abort", onAbort);
      try {
        for (;;) {
          if (signal.aborted) {
            s.aborted++;
            throw new ConnectError("aborted", Code.Canceled);
          }
          const v = attempt.queue.shift();
          if (v !== undefined) {
            yield v;
            continue;
          }
          await new Promise<void>((r) => (attempt.wake = r));
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    /** Sends on the latest attempt. */
    push(v: number | Heartbeat) {
      current?.queue.push(v);
      current?.wake?.();
    },
  };
  return s;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

function start(s: ReturnType<typeof server>, extra: Partial<StreamHandlers<number>> = {}) {
  const got: number[] = [];
  const statuses: StreamStatus[] = [];
  const errors: unknown[] = [];
  const stop = runStream<number>({
    open: (signal) => s.open(signal),
    onEvent: (v) => got.push(v),
    onStatus: (st) => statuses.push(st),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { got, statuses, errors, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("liveness watchdog", () => {
  it("never watches an attempt that has sent no heartbeat", async () => {
    const s = server();
    const r = start(s);
    s.push(1);
    await vi.advanceTimersByTimeAsync(10 * LIVENESS_MS);
    expect(s.opened).toBe(1);
    expect(r.got).toEqual([1]);
    expect(r.errors).toEqual([]);
    r.stop();
  });

  it("reconnects a stream silent for livenessMs after a heartbeat", async () => {
    const s = server();
    const r = start(s);
    s.push(1);
    s.push(HEARTBEAT);
    await vi.advanceTimersByTimeAsync(LIVENESS_MS - 10);
    expect(s.opened).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(StreamSilentError);
    expect(r.statuses).toContain("retrying");
    // The backoff (about 250 ms after a stream that was open) and a new attempt.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.opened).toBe(2);
    s.push(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.got).toEqual([1, 2]);
    expect(r.statuses.at(-1)).toBe("open");
    r.stop();
  });

  it("stays connected while heartbeats or events keep coming", async () => {
    const s = server();
    const r = start(s);
    s.push(HEARTBEAT);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      s.push(i % 2 === 0 ? HEARTBEAT : i);
    }
    expect(s.opened).toBe(1);
    expect(r.errors).toEqual([]);
    r.stop();
  });

  it("never passes a heartbeat to onEvent", async () => {
    const s = server();
    const r = start(s);
    s.push(HEARTBEAT);
    s.push(7);
    s.push(HEARTBEAT);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.got).toEqual([7]);
    r.stop();
  });

  it("is off with livenessMs 0", async () => {
    const s = server();
    const r = start(s, { livenessMs: 0 });
    s.push(HEARTBEAT);
    await vi.advanceTimersByTimeAsync(10 * LIVENESS_MS);
    expect(s.opened).toBe(1);
    r.stop();
  });

  it("is disarmed by stop", async () => {
    const s = server();
    const r = start(s);
    s.push(HEARTBEAT);
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    await vi.advanceTimersByTimeAsync(10 * LIVENESS_MS);
    expect(s.opened).toBe(1);
    expect(r.errors).toEqual([]);
  });
});

describe("resyncOnVisible", () => {
  it("reconnects at once when the page becomes visible after being hidden", async () => {
    const s = server();
    const r = start(s, { resyncOnVisible: true });
    s.push(1);
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.opened).toBe(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.opened).toBe(2);
    // A resync is not a failure: no error, no backoff, "connecting" rather than "retrying".
    expect(r.errors).toEqual([]);
    expect(r.statuses).toEqual(["connecting", "open", "connecting", "open"]);
    r.stop();
  });

  it("does nothing for a page that was never hidden, or without the option", async () => {
    const s1 = server();
    const r1 = start(s1, { resyncOnVisible: true });
    const s2 = server();
    const r2 = start(s2);
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(s1.opened).toBe(1);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(s1.opened).toBe(2);
    expect(s2.opened).toBe(1);
    r1.stop();
    r2.stop();
  });

  it("cuts a backoff sleep short", async () => {
    const s = server();
    let fail = true;
    const r = runStream<number>({
      open: async function* (signal) {
        if (fail) throw new ConnectError("down", Code.Unavailable);
        yield* s.open(signal);
      },
      onEvent: () => undefined,
      // A long backoff: only the resync can end it within the test.
      backoff: { initialMs: 60_000, maxMs: 60_000, factor: 1 },
      resyncOnVisible: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.opened).toBe(1);
    r();
  });

  it("stops listening once stopped", async () => {
    const s = server();
    const r = start(s, { resyncOnVisible: true });
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.opened).toBe(1);
  });
});
