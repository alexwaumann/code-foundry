import { Code, ConnectError } from "@connectrpc/connect";
import { claimStreamSlot, type StreamPriority } from "./streamSlots";

/** Lifecycle of a long-lived server stream, for the daemon status row and tests. */
export type StreamStatus = "connecting" | "open" | "retrying" | "stopped";

export interface Backoff {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export const defaultBackoff: Backoff = { initialMs: 250, maxMs: 10_000, factor: 2 };

/**
 * How often the daemon sends a StreamHeartbeat on a quiet ThreadService.WatchThread,
 * TerminalService.Attach or EventService.Watch. Mirrors api.HeartbeatInterval
 * (internal/api/heartbeat.go): keep them equal.
 */
export const HEARTBEAT_MS = 5_000;

/** A stream that has sent heartbeats and then nothing for this long is treated as dead. */
export const LIVENESS_MS = 3 * HEARTBEAT_MS;

/**
 * What a stream's `open` yields for a StreamHeartbeat. runStream consumes it (it arms
 * and feeds the liveness watchdog); it never reaches `onEvent`.
 */
export const HEARTBEAT: unique symbol = Symbol("heartbeat");
export type Heartbeat = typeof HEARTBEAT;

/** The liveness watchdog's reason for aborting an attempt. */
export class StreamSilentError extends Error {
  constructor(ms: number) {
    super(`no data for ${String(Math.round(ms / 1000))} s`);
    this.name = "StreamSilentError";
  }
}

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

/** Whether the page is visible now (true outside a browser). */
export function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Whether the page's window is key now, so keystrokes go to it (true outside a
 * browser). In WKWebView the document has focus while the window is key: an in-app
 * dialog keeps it, another app (or its window) takes it.
 */
export function isPageFocused(): boolean {
  return typeof document === "undefined" || document.hasFocus();
}

/**
 * Whether the user is looking at the page now: it is visible and its window is key. A
 * covered or minimized WKWebView reports hidden even while its app is active, and
 * another app being active takes the focus while the window may still show. The
 * daemon's presence uses the same rule over every GUI client
 * (docs/notes/alerts-foreground.md).
 */
export function isPageAttended(): boolean {
  return typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
}

/** How long onPageStateChange waits for the page's visibility and focus to settle. */
export const PAGE_STATE_SETTLE_MS = 100;

/**
 * Calls `cb` once the page's visibility or focus changed and then held still for
 * `settleMs` (visibilitychange on the document, focus and blur on the window), so a
 * quick flip (a blur and focus in a row as a native menu or sheet opens and closes)
 * becomes one call or none worth acting on. `cb` reads the state itself. Returns the
 * unsubscribe function.
 */
export function onPageStateChange(cb: () => void, settleMs = PAGE_STATE_SETTLE_MS): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onChange = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      cb();
    }, settleMs);
  };
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/**
 * Calls `cb` with the page's visibility each time it changes (the Wails window was
 * hidden, minimized or fully covered, or came back). Returns the unsubscribe function.
 */
export function onVisibilityChange(cb: (visible: boolean) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  let visible = isPageVisible();
  const onChange = () => {
    const now = isPageVisible();
    if (now === visible) return;
    visible = now;
    cb(now);
  };
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Calls `cb` each time the page becomes visible after having been hidden. Returns the
 * unsubscribe function.
 */
export function onBecameVisible(cb: () => void): () => void {
  return onVisibilityChange((visible) => {
    if (visible) cb();
  });
}

export interface StreamHandlers<T> {
  /** Opens one stream attempt. Must honour the signal. Yields HEARTBEAT for heartbeats. */
  open: (signal: AbortSignal) => AsyncIterable<T | Heartbeat>;
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
  /**
   * Liveness watchdog: once an attempt has delivered a heartbeat, it is aborted and
   * reconnected (with backoff) after this long without any message. Default LIVENESS_MS;
   * 0 turns it off. An attempt that never sends a heartbeat (a fake, the mock daemon)
   * is never watched.
   */
  livenessMs?: number;
  /**
   * Reconnect at once (no backoff; status "connecting") when the page becomes visible
   * after being hidden, so the new attempt starts from a fresh snapshot. For streams
   * whose first message is a snapshot that replaces the client's state.
   */
  resyncOnVisible?: boolean;
  /**
   * The stream's slot (api/streamSlots.ts): every attempt claims one before it opens and
   * waits while MAX_OPEN_STREAMS are open. Default: label "stream", priority "core". An
   * inline attempt whose slot a core stream takes reconnects at once (and waits again).
   */
  slot?: { label: string; priority: StreamPriority | (() => StreamPriority) };
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
 * errors, a clean end or a silent stream (livenessMs), until the returned stop function
 * is called. Each attempt gets its own AbortController, chained to the outer one.
 */
export function runStream<T>(h: StreamHandlers<T>): () => void {
  const outer = new AbortController();
  const backoff = h.backoff ?? defaultBackoff;
  const sleep = h.sleep ?? abortableSleep;
  const liveness = h.livenessMs ?? LIVENESS_MS;
  const stopped = () => outer.signal.aborted;
  // Once stopped, a runner reports nothing: a replacement runner may own the status now.
  const status = (s: StreamStatus, err?: string) => {
    if (!stopped()) h.onStatus?.(s, err);
  };
  // A resync aborts the current attempt (or the backoff sleep) and starts a new one at once.
  let resyncPending = false;
  let wake = new AbortController();
  const resync = () => {
    resyncPending = true;
    wake.abort();
  };
  // Read and clear through a function: TS would narrow a direct read across the awaits
  // during which resync() can run.
  const takeResync = () => {
    const p = resyncPending;
    resyncPending = false;
    return p;
  };
  const unwatchVisibility = h.resyncOnVisible ? onBecameVisible(resync) : () => undefined;

  void (async () => {
    let attempt = 0;
    while (!outer.signal.aborted) {
      const ctl = new AbortController();
      // This attempt is itself the fresh start a pending resync asked for (one during the
      // backoff sleep cut it short), and it starts over the backoff.
      if (takeResync()) attempt = 0;
      wake = new AbortController();
      const onAbort = () => {
        ctl.abort();
      };
      outer.signal.addEventListener("abort", onAbort);
      wake.signal.addEventListener("abort", onAbort);
      status(attempt === 0 ? "connecting" : "retrying");
      let failure: unknown = null;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let armed = false;
      const feed = () => {
        if (!armed) return;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          ctl.abort(new StreamSilentError(liveness));
        }, liveness);
      };
      const ticket = claimStreamSlot(h.slot?.label ?? "stream", h.slot?.priority ?? "core", resync);
      try {
        if (!ticket.granted()) {
          // Wait for a slot; a stop or resync gives up the wait.
          const giveUp = () => {
            ticket.release();
          };
          ctl.signal.addEventListener("abort", giveUp);
          try {
            await ticket.ready;
          } finally {
            ctl.signal.removeEventListener("abort", giveUp);
          }
          if (ctl.signal.aborted) throw ctl.signal.reason;
        }
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
        // Without onConnect the attempt is open once its first message arrives: a request
        // that hangs (a stopped daemon) keeps reporting connecting or retrying.
        let first = !connected;
        for await (const ev of h.open(ctl.signal)) {
          // A stopped or resynced attempt's late events must not reach the client.
          if (ctl.signal.aborted) break;
          if (first) {
            first = false;
            status("open");
          }
          if (ev === HEARTBEAT) {
            armed ||= liveness > 0;
            feed();
            continue;
          }
          feed();
          if (!connected) attempt = 0;
          if (buffering) buffer.push(ev);
          else h.onEvent(ev);
        }
        // An abort can end the iteration cleanly (the break above): treat it as one.
        if (ctl.signal.aborted) throw ctl.signal.reason;
        await connected;
      } catch (err) {
        failure = ctl.signal.reason instanceof Error && !isAbort(ctl.signal.reason) ? ctl.signal.reason : err;
      } finally {
        ticket.release();
        clearTimeout(watchdog);
        outer.signal.removeEventListener("abort", onAbort);
        wake.signal.removeEventListener("abort", onAbort);
      }
      if (stopped()) break;
      if (takeResync()) {
        attempt = 0;
        continue;
      }
      if (failure !== null) {
        h.onError?.(failure);
        if (isPermanent(failure)) {
          status("stopped", errorMessage(failure));
          unwatchVisibility();
          return;
        }
        status("retrying", errorMessage(failure));
      } else if (h.shouldReconnectOnEnd && !h.shouldReconnectOnEnd()) {
        status("stopped");
        unwatchVisibility();
        return;
      }
      const delay = backoffDelay(attempt, backoff) * (0.8 + Math.random() * 0.4);
      attempt++;
      const nap = new AbortController();
      const cut = () => {
        nap.abort();
      };
      outer.signal.addEventListener("abort", cut);
      wake.signal.addEventListener("abort", cut);
      await sleep(delay, nap.signal);
      outer.signal.removeEventListener("abort", cut);
      wake.signal.removeEventListener("abort", cut);
    }
    unwatchVisibility();
  })();

  return () => {
    outer.abort();
    unwatchVisibility();
  };
}
