import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS } from "@/api/stream";

type Gen = (signal: AbortSignal) => AsyncIterable<unknown>;
const watch = vi.hoisted(() => ({ open: null as unknown as Gen }));
vi.mock("@/api/events", async (orig) => ({ ...(await orig<typeof import("@/api/events")>()), watchEvents: (signal: AbortSignal) => watch.open(signal) }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listProjects: () => Promise.resolve([]) }));
vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), listThreads: () => Promise.resolve([]) }));
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), listTerminals: () => Promise.resolve([]) }));
vi.mock("./settings", async (orig) => ({ ...(await orig<typeof import("./settings")>()), loadSettingsSchema: () => Promise.resolve() }));

const { HEARTBEAT } = await import("@/api/stream");
const { SILENT_MS, startEventSync, useEventsStore } = await import("./events");

/** Runs until a message would come, which it never does. */
const hangs: Gen = (signal) =>
  (async function* () {
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    yield;
  })();

/** A socket refused at once: every attempt fails. */
const refused: Gen = () => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new TypeError("a WebSocket stream closed with 1006")) }),
});

/** One heartbeat, then nothing: a stream that delivered and stayed open (the mock, which sends none after its first message). */
const delivers: Gen = (signal) =>
  (async function* () {
    yield HEARTBEAT;
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  })();

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  useEventsStore.setState({ stream: "connecting", streamError: null, silent: false });
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("silent", () => {
  it.each([
    ["a socket that never answers", hangs],
    ["a socket refused every time", refused],
  ])("is set after SILENT_MS on %s, though onConnect's calls opened the stream", async (_name, open) => {
    watch.open = open;
    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(SILENT_MS - HEARTBEAT_MS);
    expect(useEventsStore.getState().silent).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(useEventsStore.getState().silent).toBe(true);
  });

  it("is not set by a stream that delivered and stays quiet", async () => {
    watch.open = delivers;
    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(SILENT_MS * 3);
    expect(useEventsStore.getState().silent).toBe(false);
  });

  it("clears at the first message", async () => {
    let live = false;
    watch.open = (signal) => (live ? delivers(signal) : refused(signal));
    stop = startEventSync();
    await vi.advanceTimersByTimeAsync(SILENT_MS);
    expect(useEventsStore.getState().silent).toBe(true);
    live = true;
    await vi.advanceTimersByTimeAsync(10_500); // the backoff's longest wait
    expect(useEventsStore.getState().silent).toBe(false);
  });
});
