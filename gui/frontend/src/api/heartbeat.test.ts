import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { EmberBoardSchema } from "@/gen/codefoundry/v1/ember_pb";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { AttachEventSchema } from "@/gen/codefoundry/v1/terminal_pb";
import { ThreadEventSchema } from "@/gen/codefoundry/v1/thread_pb";
import { watchEmberBoard } from "./ember";
import type { DaemonConnection } from "./endpoint";
import { watchEvents } from "./events";
import { HEARTBEAT } from "./stream";
import { attachTerminal } from "./terminal";
import { watchThread } from "./thread";

/** A connection whose client's server-streaming methods yield `msgs`. */
function fakeConn(method: string, msgs: unknown[]): DaemonConnection {
  const client = {
    [method]: async function* () {
      for (const m of msgs) yield await Promise.resolve(m);
    },
  };
  return { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const signal = new AbortController().signal;

describe("stream openers map a StreamHeartbeat to HEARTBEAT", () => {
  it("ThreadService.WatchThread", async () => {
    const conn = fakeConn("watchThread", [
      create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 3n } } }),
      create(ThreadEventSchema, { event: { case: "heartbeat", value: {} } }),
    ]);
    const got = await collect(watchThread("s", signal, conn));
    expect(got.map((v) => (v === HEARTBEAT ? "heartbeat" : v.kind))).toEqual(["snapshot", "heartbeat"]);
  });

  it("TerminalService.Attach", async () => {
    const conn = fakeConn("attach", [
      create(AttachEventSchema, { event: { case: "heartbeat", value: {} } }),
      create(AttachEventSchema, { event: { case: "output", value: { data: new Uint8Array([104]) } } }),
    ]);
    const got = await collect(attachTerminal("t", signal, conn));
    expect(got.map((v) => (v === HEARTBEAT ? "heartbeat" : v.kind))).toEqual(["heartbeat", "output"]);
  });

  it("EventService.Watch", async () => {
    const conn = fakeConn("watch", [create(EventSchema, { event: { case: "heartbeat", value: {} } })]);
    expect(await collect(watchEvents(signal, conn))).toEqual([HEARTBEAT]);
  });

  it("EmberService.WatchBoard", async () => {
    const conn = fakeConn("watchBoard", [
      create(EmberBoardSchema, { status: { enabled: true, epoch: 2 } }),
      create(EmberBoardSchema, { heartbeat: {} }),
    ]);
    const got = await collect(watchEmberBoard(signal, conn));
    expect(got.map((v) => (v === HEARTBEAT ? "heartbeat" : `epoch ${String(v.status.epoch)}`))).toEqual(["epoch 2", "heartbeat"]);
  });
});
