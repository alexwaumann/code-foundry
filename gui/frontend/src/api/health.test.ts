import { create } from "@bufbuild/protobuf";
import { DurationSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import { PingResponseSchema } from "@/gen/codefoundry/v1/health_pb";
import type { DaemonConnection } from "./endpoint";
import { ping, PING_TIMEOUT_MS, toHealthView } from "./health";

describe("toHealthView", () => {
  it("maps a Ping response to the view model", () => {
    const res = create(PingResponseSchema, {
      pid: 4242,
      version: "1.2.3",
      uptime: create(DurationSchema, { seconds: 90n, nanos: 500_000_000 }),
    });
    expect(toHealthView(res)).toEqual({ pid: 4242, version: "1.2.3", uptimeSeconds: 90.5 });
  });

  it("treats a missing uptime as zero", () => {
    const res = create(PingResponseSchema, { pid: 1, version: "dev" });
    expect(toHealthView(res).uptimeSeconds).toBe(0);
  });
});

describe("ping", () => {
  const connection = (call: (req: object, opts: { timeoutMs: number }) => Promise<unknown>) => {
    const invalidate = vi.fn();
    return { conn: { client: () => Promise.resolve({ ping: call }), invalidate } as unknown as DaemonConnection, invalidate };
  };

  it("gives up on a daemon that accepts and never answers", async () => {
    const call = vi.fn(() => Promise.resolve(create(PingResponseSchema, { pid: 1, version: "dev" })));
    await ping(connection(call).conn);
    expect(call).toHaveBeenCalledWith({}, { timeoutMs: PING_TIMEOUT_MS });
  });

  it("drops the connection when the ping fails", async () => {
    const { conn, invalidate } = connection(() => Promise.reject(new Error("deadline exceeded")));
    await expect(ping(conn)).rejects.toThrow("deadline exceeded");
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
