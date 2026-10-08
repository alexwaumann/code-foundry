import { Code, ConnectError } from "@connectrpc/connect";

/** Lifecycle of a long-lived server stream, for the footer and tests. */
export type StreamStatus = "connecting" | "open" | "retrying" | "stopped";

export interface Backoff {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export const defaultBackoff: Backoff = { initialMs: 250, maxMs: 10_000, factor: 2 };

/** Delay before retry number `attempt` (0-based), without jitter. */
export function backoffDelay(attempt: number, b: Backoff = defaultBackoff): number {
  return Math.min(b.maxMs, b.initialMs * b.factor ** Math.max(0, attempt));
}

export function isAbort(err: unknown): boolean {
  if (err instanceof ConnectError) return err.code === Code.Canceled;
  return err instanceof DOMException && err.name === "AbortError";
}

export function errorMessage(err: unknown): string {
  if (err instanceof ConnectError) return err.rawMessage || Code[err.code];
  return err instanceof Error ? err.message : String(err);
}

/** Errors after which retrying will not help (the stream is closed for good). */
export function isPermanent(err: unknown): boolean {
  return err instanceof ConnectError && (err.code === Code.NotFound || err.code === Code.InvalidArgument);
}

export interface StreamHandlers<T> {
  /** Opens one stream attempt. Must honour the signal. */
  open: (signal: AbortSignal) => AsyncIterable<T>;
  onEvent: (event: T) => void;
  /**
   * Called on every (re)connect, concurrently with the stream. Events that arrive
   * while it runs are buffered and delivered after it resolves, so a List-then-Watch
   * resync never applies a stale list over newer events.
   */
  onConnect?: (signal: AbortSignal) => Promise<void>;
  onStatus?: (status: StreamStatus, error?: string) => void;
  /** Return false to stop instead of reconnecting after the stream ends cleanly. */
  shouldReconnectOnEnd?: () => boolean;
  /** Called when the attempt fails; e.g. invalidate the cached endpoint. */
  onError?: (err: unknown) => void;
  backoff?: Backoff;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/**
 * Keeps a server stream open: reconnects with exponential backoff (plus jitter) after
 * errors or a clean end, until the returned stop function is called. Each attempt gets
 * its own AbortController, chained to the outer one.
 */
export function runStream<T>(h: StreamHandlers<T>): () => void {
  const outer = new AbortController();
  const backoff = h.backoff ?? defaultBackoff;
  const sleep = h.sleep ?? abortableSleep;
  const stopped = () => outer.signal.aborted;
  // Once stopped, a runner reports nothing: a replacement runner may own the status now.
  const status = (s: StreamStatus, err?: string) => {
    if (!stopped()) h.onStatus?.(s, err);
  };

  void (async () => {
    let attempt = 0;
    while (!outer.signal.aborted) {
      const ctl = new AbortController();
      const onAbort = () => {
        ctl.abort();
      };
      outer.signal.addEventListener("abort", onAbort);
      status(attempt === 0 ? "connecting" : "retrying");
      let failure: unknown = null;
      try {
        let buffering = h.onConnect !== undefined;
        const buffer: T[] = [];
        const connected = h.onConnect?.(ctl.signal).then(() => {
          buffering = false;
          for (const ev of buffer.splice(0)) h.onEvent(ev);
          status("open");
          attempt = 0;
        });
        // A failed resync fails the whole attempt.
        connected?.catch((err: unknown) => {
          ctl.abort(err);
        });
        if (!connected) status("open");
        for await (const ev of h.open(ctl.signal)) {
          if (!connected) attempt = 0;
          if (buffering) buffer.push(ev);
          else h.onEvent(ev);
        }
        await connected;
      } catch (err) {
        failure = ctl.signal.reason instanceof Error && !isAbort(ctl.signal.reason) ? ctl.signal.reason : err;
      } finally {
        outer.signal.removeEventListener("abort", onAbort);
      }
      if (stopped()) break;
      if (failure !== null) {
        h.onError?.(failure);
        if (isPermanent(failure)) {
          status("stopped", errorMessage(failure));
          return;
        }
        status("retrying", errorMessage(failure));
      } else if (h.shouldReconnectOnEnd && !h.shouldReconnectOnEnd()) {
        status("stopped");
        return;
      }
      const delay = backoffDelay(attempt, backoff) * (0.8 + Math.random() * 0.4);
      attempt++;
      await sleep(delay, outer.signal);
    }
  })();

  return () => {
    outer.abort();
  };
}
