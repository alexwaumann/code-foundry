import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { ClientKind, EventSchema, type WatchEventsRequest } from "@/gen/codefoundry/v1/events_pb";
import type { DaemonConnection } from "./endpoint";
import { reportVisibility, watchEvents } from "./events";
import { onVisibilityChange } from "./stream";

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * A connection whose Watch yields one heartbeat per `release()` and records the request,
 * and whose SetClientState records its calls (failing with NotFound while `joined` is false).
 */
function fakeDaemon() {
  const d = {
    requests: [] as Partial<WatchEventsRequest>[],
    sets: [] as { clientId: string; visible: boolean }[],
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
    setClientState: (req: { clientId: string; visible: boolean }) => {
      if (!d.joined) return Promise.reject(new Error("not found"));
      d.sets.push({ clientId: req.clientId, visible: req.visible });
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

afterEach(() => {
  setVisibility("visible");
});

describe("EventService.Watch client state", () => {
  it("opens as a GUI client with a fresh id and the page's visibility", async () => {
    setVisibility("hidden");
    const { d, conn } = fakeDaemon();
    const a = consume(conn);
    const first = a.next();
    await tick();
    d.release();
    await first;
    a.stop();
    const b = consume(conn);
    setVisibility("visible");
    void b.next();
    await tick();
    b.stop();
    expect(d.requests).toHaveLength(2);
    expect(d.requests[0]).toMatchObject({ clientKind: ClientKind.GUI, visible: false });
    expect(d.requests[1]).toMatchObject({ clientKind: ClientKind.GUI, visible: true });
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
    await reportVisibility(); // the first message's catch-up: nothing changed
    expect(d.sets).toEqual([]);
    const unwatch = onVisibilityChange(() => void reportVisibility());
    setVisibility("hidden");
    await reportVisibility();
    setVisibility("hidden"); // no change: no listener call, nothing sent
    await reportVisibility();
    setVisibility("visible");
    await reportVisibility();
    unwatch();
    s.stop();
    const id = d.requests[0]?.clientId ?? "";
    expect(d.sets).toEqual([
      { clientId: id, visible: false },
      { clientId: id, visible: true },
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
    await reportVisibility(); // NotFound: dropped
    expect(d.sets).toEqual([]);
    d.joined = true;
    d.release();
    await first;
    await reportVisibility(); // chained after the catch-up the first message started
    s.stop();
    expect(d.sets).toEqual([{ clientId: d.requests[0]?.clientId, visible: false }]);
  });

  it("sends nothing without an open stream", async () => {
    const { d } = fakeDaemon();
    setVisibility("hidden");
    await reportVisibility();
    expect(d.sets).toEqual([]);
  });
});
