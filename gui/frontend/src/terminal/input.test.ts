import { describe, expect, it, vi } from "vitest";
import { TerminalInput } from "./input";

const enc = (s: string) => new TextEncoder().encode(s);
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A TerminalInput whose Writes wait for the test: settle(id) ends the oldest one to that terminal. */
function scripted() {
  const writes: string[] = [];
  const open: { id: string; done: () => void; fail: (err: Error) => void }[] = [];
  const input = new TerminalInput((id, data) => {
    writes.push(`${id}:${new TextDecoder().decode(data)}`);
    return new Promise<void>((done, fail) => open.push({ id, done, fail }));
  });
  const take = (id: string) => {
    const i = open.findIndex((w) => w.id === id);
    const [write] = open.splice(i, 1);
    if (!write) throw new Error(`no write in flight to ${id}`);
    return write;
  };
  return {
    input,
    writes,
    settle: async (id: string) => {
      take(id).done();
      await flush();
    },
    reject: async (id: string, err: Error) => {
      take(id).fail(err);
      await flush();
    },
  };
}

const ignore = () => undefined;

describe("TerminalInput", () => {
  it("keeps one Write in flight per terminal and coalesces what waits, in order", async () => {
    const { input, writes, settle } = scripted();
    for (const key of ["a", "b", "c"]) input.send("t1", enc(key), ignore);
    expect(writes).toEqual(["t1:a"]);
    await settle("t1");
    expect(writes).toEqual(["t1:a", "t1:bc"]);
  });

  it("does not hold one terminal behind another's Write, or mix their keys", async () => {
    const { input, writes, settle } = scripted();
    input.send("t1", enc("a"), ignore);
    input.send("t1", enc("b"), ignore);
    input.send("t2", enc("x"), ignore);
    input.send("t2", enc("y"), ignore);
    expect(writes).toEqual(["t1:a", "t2:x"]);
    await settle("t2");
    await settle("t1");
    expect(writes).toEqual(["t1:a", "t2:x", "t2:y", "t1:b"]);
  });

  it("sends each key once", async () => {
    const { input, writes, settle } = scripted();
    input.send("t1", enc("a"), ignore);
    input.send("t1", enc("b"), ignore);
    await settle("t1");
    await settle("t1");
    input.send("t1", enc("c"), ignore);
    await settle("t1");
    expect(writes).toEqual(["t1:a", "t1:b", "t1:c"]);
  });

  it("drops what waits behind a failed Write, tells each sender once, and starts clean", async () => {
    const { input, writes, reject, settle } = scripted();
    const first = vi.fn();
    const second = vi.fn();
    const err = new Error("no such terminal");
    input.send("t1", enc("a"), first);
    input.send("t1", enc("b"), first);
    input.send("t1", enc("c"), second);
    await reject("t1", err);
    expect(writes).toEqual(["t1:a"]);
    expect(first.mock.calls).toEqual([[err]]);
    expect(second.mock.calls).toEqual([[err]]);
    input.send("t1", enc("d"), ignore);
    await settle("t1");
    expect(writes).toEqual(["t1:a", "t1:d"]);
  });

  it("leaves other terminals' keys alone when a Write fails", async () => {
    const { input, writes, reject, settle } = scripted();
    input.send("t1", enc("a"), ignore);
    input.send("t2", enc("x"), ignore);
    input.send("t2", enc("y"), ignore);
    await reject("t1", new Error("gone"));
    await settle("t2");
    expect(writes).toEqual(["t1:a", "t2:x", "t2:y"]);
  });

  it("holds nothing for a terminal once its keys are written or refused", async () => {
    const { input, reject, settle } = scripted();
    const queues = (input as unknown as { queues: Map<string, unknown> }).queues;
    input.send("t1", enc("a"), ignore);
    await settle("t1");
    expect(queues.size).toBe(0);
    input.send("closed", enc("b"), ignore);
    input.send("closed", enc("c"), ignore);
    await reject("closed", new Error("no such terminal"));
    expect(queues.size).toBe(0);
  });
});
