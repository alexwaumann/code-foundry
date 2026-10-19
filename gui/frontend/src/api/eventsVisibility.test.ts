import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientKind, EventSchema, type WatchEventsRequest } from "@/gen/codefoundry/v1/events_pb";
import type { DaemonConnection } from "./endpoint";
import { reportClientState, watchEvents } from "./events";
import { onVisibilityChange } from "./stream";

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

let focused = true;

function setFocus(f: boolean): void {
  focused = f;
}

/**
 * A connection whose Watch yields one heartbeat per `release()` and records the request,
 * and whose SetClientState records its calls (failing with NotFound while `joined` is false).
 */
function fakeDaemon() {
  const d = {
    requests: [] as Partial<WatchEventsRequest>[],
    sets: [] as { clientId: string; visible: boolean; focused: boolean }[],
    joined: true,
    release: (): void => undefined,
  };
  let pending: (() => void) | null = null;
  const client = {
    watch: async function* (req: Partial<WatchEventsRequest>, opts: { signal: AbortSignal }) {
      d.requests.push(req);
      // Through a function: TS would narrow a direct read across the await.
      const aborted = () => opts.signal.aborted;
      while (!aborted()) {
        await new Promise<void>((resolve) => {
          pending = resolve;
          opts.signal.addEventListener("abort", () => {
            resolve();
          });
        });
        if (aborted()) return;
        yield create(EventSchema, { event: { case: "heartbeat", value: {} } });
      }
    },
    setClientState: (req: { clientId: string; visible: boolean; focused: boolean }) => {
      if (!d.joined) return Promise.reject(new Error("not found"));
      d.sets.push({ clientId: req.clientId, visible: req.visible, focused: req.focused });
      return Promise.resolve({});
    },
  };
  d.release = () => {
    const p = pending;
    pending = null;
    p?.();
  };
  const conn = { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
  return { d, conn };
}

/** Starts watchEvents; its first item comes after `release`. */
function consume(conn: DaemonConnection) {
  const ctl = new AbortController();
  const it = watchEvents(ctl.signal, conn)[Symbol.asyncIterator]();
  return {
    next: () => it.next(),
    // As runStream's for-await does on its way out: the generator's finally runs.
    stop: () => {
      ctl.abort();
      void it.return(undefined);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setFocus(true);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});

afterEach(() => {
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("EventService.Watch client state", () => {
  it("opens as a GUI client with a fresh id and the page's visibility and focus", async () => {
    setVisibility("hidden");
    setFocus(false);
    const { d, conn } = fakeDaemon();
    const a = consume(conn);
    const first = a.next();
    await tick();
    d.release();
    await first;
    a.stop();
    const b = consume(conn);
    setVisibility("visible");
    setFocus(true);
    void b.next();
    await tick();
    b.stop();
    expect(d.requests).toHaveLength(2);
    expect(d.requests[0]).toMatchObject({ clientKind: ClientKind.GUI, visible: false, focused: false });
    expect(d.requests[1]).toMatchObject({ clientKind: ClientKind.GUI, visible: true, focused: true });
    expect(d.requests[0]?.clientId).toMatch(/^[0-9a-f]{24}$/);
    expect(d.requests[1]?.clientId).not.toBe(d.requests[0]?.clientId);
  });

  it("reports visibility changes, only when they differ from what the daemon has", async () => {
    setVisibility("visible");
    const { d, conn } = fakeDaemon();
    const s = consume(conn);
    const first = s.next();
    await tick();
    d.release();
    await first;
    await reportClientState(); // the first message's catch-up: nothing changed
    expect(d.sets).toEqual([]);
    const unwatch = onVisibilityChange(() => void reportClientState());
    setVisibility("hidden");
    await reportClientState();
    setVisibility("hidden"); // no change: no listener call, nothing sent
    await reportClientState();
    setVisibility("visible");
    await reportClientState();
    unwatch();
    s.stop();
    const id = d.requests[0]?.clientId ?? "";
    expect(d.sets).toEqual([
      { clientId: id, visible: false, focused: true },
      { clientId: id, visible: true, focused: true },
    ]);
  });

  it("reports focus changes too, each once; a flip back before the report sends nothing", async () => {
    setVisibility("visible");
    const { d, conn } = fakeDaemon();
    const s = consume(conn);
    const first = s.next();
    await tick();
    d.release();
    await first;
    await reportClientState();
    setFocus(false); // another app became active: the window still shows
    await reportClientState();
    await reportClientState(); // nothing changed since: nothing sent
    setVisibility("hidden"); // then covered
    await reportClientState();
    setVisibility("visible");
    setFocus(true); // back in front and key, both in one report
    await reportClientState();
    setFocus(false);
    setFocus(true); // a quick flip: the report reads the state it lands on
    await reportClientState();
    s.stop();
    const id = d.requests[0]?.clientId ?? "";
    expect(d.sets).toEqual([
      { clientId: id, visible: true, focused: false },
      { clientId: id, visible: false, focused: false },
      { clientId: id, visible: true, focused: true },
    ]);
  });

  it("a change made before the daemon joined the stream is sent on its first message", async () => {
    setVisibility("visible");
    const { d, conn } = fakeDaemon();
    d.joined = false;
    const s = consume(conn);
    const first = s.next();
    await tick();
    setVisibility("hidden");
    await reportClientState(); // NotFound: dropped
    expect(d.sets).toEqual([]);
    d.joined = true;
    d.release();
    await first;
    await reportClientState(); // chained after the catch-up the first message started
    s.stop();
    expect(d.sets).toEqual([{ clientId: d.requests[0]?.clientId, visible: false, focused: true }]);
  });

  it("sends nothing without an open stream", async () => {
    const { d } = fakeDaemon();
    setVisibility("hidden");
    await reportClientState();
    expect(d.sets).toEqual([]);
  });
});
