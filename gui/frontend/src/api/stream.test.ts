import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { backoffDelay, errorMessage, isUnreachable, runStream, sendErrorMessage, type StreamStatus } from "./stream";

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

describe("transport failures", () => {
  // connect-web wraps a rejected fetch as Unknown with the TypeError as its cause.
  const fetchFailed = ConnectError.from(new TypeError("Load failed"));
  it.each<[string, unknown, boolean, string]>([
    ["a failed fetch (WebKit)", fetchFailed, true, "Code Foundry's daemon is not reachable."],
    ["a bare TypeError", new TypeError("Failed to fetch"), true, "Code Foundry's daemon is not reachable."],
    ["a bare HTTP 503", new ConnectError("HTTP 503", Code.Unavailable), true, "Code Foundry's daemon is not reachable."],
    ["the daemon's own Unavailable", new ConnectError("the daemon is stopping", Code.Unavailable), false, "the daemon is stopping"],
    ["an application error", new ConnectError("no such thread", Code.NotFound), false, "no such thread"],
    ["a plain error", new Error("boom"), false, "boom"],
  ])("%s", (_, err, unreachable, message) => {
    expect(isUnreachable(err)).toBe(unreachable);
    expect(errorMessage(err)).toBe(message);
    expect(sendErrorMessage(err)).toBe(unreachable ? "Code Foundry's daemon is not reachable; your message is kept. Retry when it is back." : message);
  });
});
