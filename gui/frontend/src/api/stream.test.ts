import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { backoffDelay, errorMessage, HEARTBEAT, isUnreachable, runStream, sendErrorMessage, wakeAllStreams, type StreamStatus } from "./stream";

/** A controllable server stream: push events, end, or fail it from the test. */
function fakeStream<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  const st: { ended: boolean; error: Error | null } = { ended: false, error: null };
  // Read through a function so TS does not narrow across awaits.
  const current = () => st;
  async function* open(signal: AbortSignal): AsyncGenerator<T> {
    st.ended = false;
    st.error = null;
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (signal.aborted) throw new ConnectError("aborted", Code.Canceled);
        const err = current().error;
        if (err) throw err;
        const v = queue.shift();
        if (v !== undefined) {
          yield v;
          continue;
        }
        if (current().ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  return {
    open,
    push(v: T) {
      queue.push(v);
      wake?.();
    },
    end() {
      st.ended = true;
      wake?.();
    },
    fail(err: Error) {
      st.error = err;
      wake?.();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const noSleep = () => Promise.resolve();

describe("backoffDelay", () => {
  it.each([
    [0, 250],
    [1, 500],
    [3, 2000],
    [10, 10_000],
  ])("attempt %d -> %d ms", (attempt, want) => {
    expect(backoffDelay(attempt)).toBe(want);
  });
});

describe("runStream", () => {
  it("delivers events and reports open", async () => {
    const s = fakeStream<number>();
    const got: number[] = [];
    const statuses: StreamStatus[] = [];
    const stop = runStream({ open: s.open, onEvent: (v) => got.push(v), onStatus: (st) => statuses.push(st), sleep: noSleep });
    s.push(1);
    s.push(2);
    await tick();
    expect(got).toEqual([1, 2]);
    expect(statuses).toEqual(["connecting", "open"]);
    stop();
  });

  it("buffers events until onConnect resolves, then replays them in order", async () => {
    const s = fakeStream<string>();
    const log: string[] = [];
    let resolveList: () => void = () => undefined;
    const stop = runStream({
      open: s.open,
      onConnect: () =>
        new Promise<void>((r) => {
          resolveList = () => {
            log.push("list");
            r();
          };
        }),
      onEvent: (v) => log.push(v),
      sleep: noSleep,
    });
    await tick();
    s.push("a");
    s.push("b");
    await tick();
    expect(log).toEqual([]);
    resolveList();
    await tick();
    s.push("c");
    await tick();
    expect(log).toEqual(["list", "a", "b", "c"]);
    stop();
  });

  it("reconnects after an error and re-runs onConnect", async () => {
    const s = fakeStream<number>();
    const onConnect = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    const statuses: StreamStatus[] = [];
    const stop = runStream({ open: s.open, onConnect, onEvent: () => undefined, onError, onStatus: (st) => statuses.push(st), sleep: noSleep });
    await tick();
    s.fail(new ConnectError("down", Code.Unavailable));
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["connecting", "open", "retrying", "retrying", "open"]);
    stop();
  });

  it("stops for good on permanent errors", async () => {
    const s = fakeStream<number>();
    const statuses: [StreamStatus, string | undefined][] = [];
    runStream({ open: s.open, onEvent: () => undefined, onStatus: (st, e) => statuses.push([st, e]), sleep: noSleep });
    await tick();
    s.fail(new ConnectError("no such terminal", Code.NotFound));
    await tick();
    await tick();
    expect(statuses.at(-1)).toEqual(["stopped", "no such terminal"]);
  });

  it("does not reconnect after a clean end when told not to", async () => {
    const s = fakeStream<number>();
    const open = vi.fn(s.open);
    runStream({ open, onEvent: () => undefined, shouldReconnectOnEnd: () => false, sleep: noSleep });
    await tick();
    s.end();
    await tick();
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reports nothing after stop", async () => {
    const s = fakeStream<number>();
    const statuses: StreamStatus[] = [];
    const stop = runStream({ open: s.open, onEvent: () => undefined, onStatus: (st) => statuses.push(st), sleep: noSleep });
    await tick();
    const before = statuses.length;
    stop();
    await tick();
    await tick();
    expect(statuses.length).toBe(before);
  });
});

describe("backoff with onConnect", () => {
  it("grows while the calls pass and the stream never brings a message", async () => {
    const delays: number[] = [];
    let opens = 0;
    const stop = runStream({
      // eslint-disable-next-line require-yield
      open: async function* () {
        opens++;
        await Promise.resolve(); // onConnect's calls get there first
        await Promise.resolve();
        throw new TypeError("a WebSocket stream closed with 1006");
      },
      onConnect: () => Promise.resolve(),
      onEvent: () => undefined,
      // A macrotask: a sleep that resolves at once would never let the test's own timers run.
      sleep: (ms) => {
        delays.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await vi.waitFor(() => {
      expect(opens).toBeGreaterThan(4);
    });
    stop();
    // Jitter is 20% either way: the third wait is past anything the first can be.
    expect(delays[2]).toBeGreaterThan((delays[0] ?? 0) * 2);
  });

  it("grows while the stream delivers and the resync keeps failing", async () => {
    const delays: number[] = [];
    let opens = 0;
    const stop = runStream<string>({
      open: async function* (signal) {
        opens++;
        yield "snapshot";
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
      onConnect: async () => {
        await Promise.resolve(); // the snapshot gets there first
        await Promise.resolve();
        throw new Error("a resync failed");
      },
      onEvent: () => undefined,
      sleep: (ms) => {
        delays.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await vi.waitFor(() => {
      expect(opens).toBeGreaterThan(4);
    });
    stop();
    expect(delays[2]).toBeGreaterThan((delays[0] ?? 0) * 2);
  });

  it.each([
    ["before the resync passes", 0],
    ["after the resync passes", 4],
  ])("resets once a message came %s", async (_name, resyncTicks) => {
    const delays: number[] = [];
    let opens = 0;
    const stop = runStream<string>({
      open: async function* () {
        opens++;
        if (opens <= 4) throw new TypeError("a WebSocket stream closed with 1006");
        for (let i = 0; i < 4 - resyncTicks; i++) await Promise.resolve();
        yield "snapshot";
        for (let i = 0; i < 8; i++) await Promise.resolve();
        throw new TypeError("a WebSocket stream closed with 1006");
      },
      onConnect: async () => {
        for (let i = 0; i < resyncTicks; i++) await Promise.resolve();
      },
      onEvent: () => undefined,
      sleep: (ms) => {
        delays.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await vi.waitFor(() => {
      expect(opens).toBeGreaterThan(5);
    });
    stop();
    // The fifth attempt delivered, so the wait after it is back to the first one's size.
    expect(delays[4]).toBeLessThan((delays[3] ?? 0) / 2);
  });

  it("calls onMessage for heartbeats too", async () => {
    const onMessage = vi.fn();
    const stop = runStream<string>({
      open: async function* () {
        yield HEARTBEAT;
        yield "event";
        await new Promise(() => undefined);
      },
      onEvent: () => undefined,
      onMessage,
    });
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(2);
    });
    stop();
  });
});

describe("an attempt's end", () => {
  it("aborts its stream when the consumer throws, so the retry does not leave it open", async () => {
    const signals: AbortSignal[] = [];
    async function* open(signal: AbortSignal) {
      signals.push(signal);
      yield 1;
      await new Promise(() => undefined);
    }
    const onError = vi.fn();
    const stop = runStream({
      open,
      onEvent: () => {
        throw new Error("a bad event");
      },
      onError,
      sleep: () => new Promise(() => undefined),
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(signals[0]?.aborted).toBe(true);
    stop();
  });
});

describe("transport failures", () => {
  // connect-web wraps a rejected fetch as Unknown with the TypeError as its cause.
  const fetchFailed = ConnectError.from(new TypeError("Load failed"));
  it.each<[string, unknown, boolean, string]>([
    ["a failed fetch (WebKit)", fetchFailed, true, "Code Foundry's daemon is not reachable."],
    ["a bare TypeError", new TypeError("Failed to fetch"), true, "Code Foundry's daemon is not reachable."],
    ["a bare HTTP 503", new ConnectError("HTTP 503", Code.Unavailable), true, "Code Foundry's daemon is not reachable."],
    ["the daemon's own Unavailable", new ConnectError("the daemon is stopping", Code.Unavailable), false, "the daemon is stopping"],
    ["an application error", new ConnectError("no such thread", Code.NotFound), false, "no such thread"],
    ["a store's refusal", new ConnectError("failed precondition: pull request #9 is merged", Code.FailedPrecondition), false, "pull request #9 is merged"],
    ["a store's bad input", new ConnectError("invalid argument: name is required", Code.InvalidArgument), false, "name is required"],
    ["the words inside a message", new ConnectError("gh said failed precondition: no", Code.Unknown), false, "gh said failed precondition: no"],
    ["a plain error", new Error("boom"), false, "boom"],
  ])("%s", (_, err, unreachable, message) => {
    expect(isUnreachable(err)).toBe(unreachable);
    expect(errorMessage(err)).toBe(message);
    expect(sendErrorMessage(err)).toBe(unreachable ? "Code Foundry's daemon is not reachable; your message is kept. Retry when it is back." : message);
  });
});

describe("wakeAllStreams", () => {
  /** A sleep that only an abort ends, as a 10 s backoff would look to the test; it records each delay. */
  function longSleep(delays: number[]) {
    return (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        delays.push(ms);
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
  }

  it("starts a runner sleeping out its backoff on a new attempt at once", async () => {
    const delays: number[] = [];
    let opens = 0;
    const statuses: StreamStatus[] = [];
    const stop = runStream<string>({
      open: async function* () {
        opens++;
        if (opens <= 3) throw new TypeError("Load failed");
        yield "snapshot";
        await new Promise(() => undefined);
      },
      onEvent: () => undefined,
      onStatus: (st) => statuses.push(st),
      backoff: { initialMs: 10_000, maxMs: 10_000, factor: 2 },
      sleep: longSleep(delays),
    });
    await vi.waitFor(() => {
      expect(delays).toHaveLength(1);
    });
    expect(opens).toBe(1);
    expect(delays[0]).toBeGreaterThanOrEqual(8_000);

    wakeAllStreams();
    await vi.waitFor(() => {
      expect(opens).toBe(2);
    });
    // That attempt failed too: the runner sleeps again, and another wake cuts that sleep short as well.
    await vi.waitFor(() => {
      expect(delays).toHaveLength(2);
    });
    wakeAllStreams();
    await vi.waitFor(() => {
      expect(opens).toBe(3);
    });
    wakeAllStreams();
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toBe("open");
    });
    expect(opens).toBe(4);
    stop();
  });

  it("leaves an open runner and a connecting one alone", async () => {
    const live = fakeStream<string>();
    const openSignals: AbortSignal[] = [];
    const stopOpen = runStream<string>({
      open: (signal) => {
        openSignals.push(signal);
        return live.open(signal);
      },
      onEvent: () => undefined,
      sleep: longSleep([]),
    });
    live.push("snapshot");
    // A request that hangs: the attempt is connecting, not sleeping.
    const hangingSignals: AbortSignal[] = [];
    const stopHanging = runStream<string>({
      open: async function* (signal) {
        hangingSignals.push(signal);
        await new Promise(() => undefined);
      },
      onEvent: () => undefined,
      sleep: longSleep([]),
    });
    await tick();
    expect(openSignals).toHaveLength(1);
    expect(hangingSignals).toHaveLength(1);

    wakeAllStreams();
    await tick();
    expect(openSignals).toHaveLength(1);
    expect(openSignals[0]?.aborted).toBe(false);
    expect(hangingSignals).toHaveLength(1);
    expect(hangingSignals[0]?.aborted).toBe(false);
    stopOpen();
    stopHanging();
  });

  it("does not wake a stopped runner", async () => {
    let opens = 0;
    const delays: number[] = [];
    const stop = runStream<string>({
      open: async function* () {
        opens++;
        await Promise.resolve();
        throw new TypeError("Load failed");
      },
      onEvent: () => undefined,
      sleep: longSleep(delays),
    });
    await vi.waitFor(() => {
      expect(delays).toHaveLength(1);
    });
    stop();
    wakeAllStreams();
    await tick();
    expect(opens).toBe(1);
  });
});
