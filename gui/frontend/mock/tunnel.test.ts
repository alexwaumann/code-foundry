import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { serveTunnel } from "./tunnel";

describe("the mock's tunnel", () => {
  let server: Server;
  let port: number;
  let drop: () => void;

  beforeEach(async () => {
    server = createServer((req, res) => {
      req.resume();
      res.end("answered");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    drop = serveTunnel(server, port);
  });
  afterEach(async () => {
    drop();
    await new Promise((r) => server.close(r));
  });

  /** Sends frames and resolves with the socket's close code. */
  function closeCode(frames: (string | Buffer)[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/stream/svc/method`);
      ws.on("error", reject);
      ws.on("close", resolve);
      ws.on("open", () => {
        for (const f of frames) ws.send(f);
      });
    });
  }

  const head = JSON.stringify({ headers: {} });

  it("answers a text head and a binary body", async () => {
    expect(await closeCode([head, Buffer.from([0])])).toBe(1000);
  });

  it.each([
    ["a head that is not JSON", ["{", Buffer.from([0])]],
    ["a null head", ["null", Buffer.from([0])]],
    ["a bad header name", [JSON.stringify({ headers: { "bad name": "x" } }), Buffer.from([0])]],
    ["a binary head", [Buffer.from(head), Buffer.from([0])]],
    ["a text body", [head, "body"]],
  ] as [string, (string | Buffer)[]][])("closes on %s, as the daemon does, and keeps running", async (_, frames) => {
    expect(await closeCode(frames)).toBe(1008);
    expect(await closeCode([head, Buffer.from([0])])).toBe(1000);
  });
});
