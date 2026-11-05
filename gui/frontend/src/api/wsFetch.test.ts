import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmberService } from "@/gen/codefoundry/v1/ember_pb";
import { isUnreachable } from "./stream";
import { OPEN_SOCKETS_WARNING, openSocketCount, wsFetch } from "./wsFetch";

/** What a browser's WebSocket does, driven by the test. */
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  closeCalls = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
  }
  head(status = 200, headers: Record<string, string> = { "content-type": "application/connect+proto" }) {
    this.onmessage?.({ data: JSON.stringify({ status, headers }) });
  }
  frame(...bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  /** The close event, which fires once. */
  closed(code: number) {
    const onclose = this.onclose;
    this.onclose = null;
    onclose?.({ code });
  }
}

const URL_ = "http://127.0.0.1:4567/codefoundry.v1.EmberService/WatchBoard";
const BODY = new Uint8Array([0, 0, 0, 0, 0]);

function open(init: RequestInit = {}): { res: Promise<Response>; ws: FakeSocket } {
  const res = wsFetch(URL_, { body: BODY, ...init });
  // Not every test reads the outcome, and afterEach closes every socket.
  res.catch(() => undefined);
  const ws = FakeSocket.all.at(-1);
  if (!ws) throw new Error("no socket opened");
  return { res, ws };
}

/** A stream past its head. */
async function opened(init: RequestInit = {}) {
  const { res, ws } = open(init);
  ws.head();
  const body = (await res).body;
  if (!body) throw new Error("no body");
  return { ws, reader: body.getReader() };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  for (const ws of FakeSocket.all) ws.closed(1006);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the request", () => {
  it("opens one socket at /stream/<procedure> and sends the head, then the body", () => {
    const { ws } = open({ headers: new Headers({ Authorization: "Bearer secret", "Content-Type": "application/connect+proto" }) });
    expect(ws.url).toBe("ws://127.0.0.1:4567/stream/codefoundry.v1.EmberService/WatchBoard");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(ws.sent).toEqual([]);
    ws.onopen?.();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ headers: { authorization: "Bearer secret", "content-type": "application/connect+proto" } });
    expect(ws.sent[1]).toBe(BODY);
    expect(ws.sent).toHaveLength(2);
  });

  it("refuses a body that is not bytes, which the wire could only send as text", async () => {
    await expect(wsFetch(URL_, { body: "text" })).rejects.toBeInstanceOf(TypeError);
    expect(FakeSocket.all).toEqual([]);
  });

  it("rejects with a TypeError when the socket cannot be constructed", async () => {
    vi.stubGlobal(
      "WebSocket",
      vi.fn(() => {
        throw new DOMException("bad url", "SyntaxError");
      }),
    );
    await expect(wsFetch(URL_, { body: BODY })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the head", () => {
  it("becomes the Response's status and headers", async () => {
    const { res, ws } = open();
    ws.head(401, { "content-type": "application/json", "x-a": "1, 2" });
    const r = await res;
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("x-a")).toBe("1, 2");
  });

  it.each([
    ["is not JSON", "{"],
    ["has a status a Response cannot have", JSON.stringify({ status: 99, headers: {} })],
    ["has a null-body status", JSON.stringify({ status: 204, headers: {} })],
  ])("rejects with a TypeError and closes when it %s", async (_, head) => {
    const { res, ws } = open();
    ws.onmessage?.({ data: head });
    await expect(res).rejects.toBeInstanceOf(TypeError);
    expect(ws.closeCalls).toBe(1);
  });
});

describe("the body", () => {
  it("cannot come before the head", async () => {
    const { res, ws } = open();
    ws.frame(1);
    await expect(res).rejects.toBeInstanceOf(TypeError);
    expect(ws.closeCalls).toBe(1);
  });

  it("is each binary message in order, ended by a close of 1000", async () => {
    const { ws, reader } = await opened();
    ws.frame(1, 2);
    ws.frame(3);
    ws.closed(1000);
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    expect((await reader.read()).value).toEqual(new Uint8Array([3]));
    expect((await reader.read()).done).toBe(true);
  });

  it.each([1006, 1001, 1011])("errors with a TypeError on a close of %i, after the frames before it", async (code) => {
    const { ws, reader } = await opened();
    ws.frame(1);
    ws.closed(code);
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects a socket that errors and never closes, and stops counting it", async () => {
    const before = openSocketCount();
    const { res, ws } = open();
    ws.readyState = 3;
    ws.onerror?.();
    await expect(res).rejects.toBeInstanceOf(TypeError);
    expect(openSocketCount()).toBe(before);
    ws.closed(1006); // and counts it once if close follows after all
    expect(openSocketCount()).toBe(before);
  });

  it("errors the body when a socket errors mid-stream, and counts it until it closes", async () => {
    const before = openSocketCount();
    const { res, ws } = open();
    ws.head();
    const reader = (await res).body?.getReader();
    ws.onerror?.();
    await expect(reader?.read()).rejects.toBeInstanceOf(TypeError);
    expect(openSocketCount()).toBe(before + 1);
    ws.closed(1006);
    expect(openSocketCount()).toBe(before);
  });

  it("errors on a second head", async () => {
    const { ws, reader } = await opened();
    ws.head();
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
    expect(ws.closeCalls).toBe(1);
  });

  it("closes the socket when cancelled, and the close that follows changes nothing", async () => {
    const { ws, reader } = await opened();
    await reader.cancel();
    expect(ws.closeCalls).toBe(1);
    ws.frame(1);
    ws.closed(1006);
    expect((await reader.read()).done).toBe(true);
  });
});

describe("a failure before the head", () => {
  it.each([1006, 1008, 1000])("rejects with a TypeError on a close of %i", async (code) => {
    const { res, ws } = open();
    ws.closed(code);
    await expect(res).rejects.toBeInstanceOf(TypeError);
  });
});

describe("an abort", () => {
  it("opens no socket when the signal has already aborted, and rejects with its reason", async () => {
    const reason = new DOMException("gone", "AbortError");
    await expect(wsFetch(URL_, { body: BODY, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(FakeSocket.all).toEqual([]);
  });

  it("rejects with the reason and closes the socket before the head", async () => {
    const ctl = new AbortController();
    const { res, ws } = open({ signal: ctl.signal });
    const reason = new Error("stream silent");
    ctl.abort(reason);
    await expect(res).rejects.toBe(reason);
    expect(ws.closeCalls).toBe(1);
  });

  it("errors the body with the reason and closes the socket mid-stream", async () => {
    const ctl = new AbortController();
    const { ws, reader } = await opened({ signal: ctl.signal });
    ctl.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(ws.closeCalls).toBe(1);
    ws.closed(1006);
  });

  it("does nothing once the stream has ended", async () => {
    const ctl = new AbortController();
    const { ws, reader } = await opened({ signal: ctl.signal });
    ws.closed(1000);
    ctl.abort();
    expect((await reader.read()).done).toBe(true);
    expect(ws.closeCalls).toBe(0);
  });
});

describe("the open-socket count", () => {
  it("follows the sockets, from opening until their close event", async () => {
    const before = openSocketCount();
    const ctl = new AbortController();
    const { res, ws } = open({ signal: ctl.signal });
    expect(openSocketCount()).toBe(before + 1);
    ctl.abort();
    await res.catch(() => undefined);
    expect(openSocketCount()).toBe(before + 1);
    ws.closed(1006);
    expect(openSocketCount()).toBe(before);
  });

  it("warns once on passing the limit and refuses nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const start = openSocketCount();
    for (let i = start; i < OPEN_SOCKETS_WARNING; i++) open();
    expect(warn).not.toHaveBeenCalled();
    open();
    open();
    expect(warn).toHaveBeenCalledOnce();
    expect(openSocketCount()).toBe(OPEN_SOCKETS_WARNING + 2);
  });
});

describe("through connect-web", () => {
  const client = () => createClient(EmberService, createConnectTransport({ baseUrl: "http://127.0.0.1:4567", useBinaryFormat: true, fetch: wsFetch }));

  /** Reads the stream to its end and returns how it failed. */
  async function failure(script: (ws: FakeSocket) => void): Promise<unknown> {
    const reading = (async () => {
      const it = client().watchBoard({})[Symbol.asyncIterator]();
      while (!(await it.next()).done);
    })().then(
      () => null,
      (err: unknown) => err,
    );
    await vi.waitFor(() => {
      expect(FakeSocket.all).toHaveLength(1);
    });
    const ws = FakeSocket.all[0] as FakeSocket;
    script(ws);
    return reading;
  }

  // Connect's end of stream: flag 2, a four-byte length, then the JSON.
  const endStream = (json: string): number[] => {
    const bytes = new TextEncoder().encode(json);
    return [2, 0, 0, 0, bytes.length, ...bytes];
  };

  it("sees a dead socket before the head as the daemon being unreachable", async () => {
    const err = await failure((ws) => {
      ws.closed(1006);
    });
    expect(isUnreachable(err)).toBe(true);
  });

  it("sees a dead socket mid-stream as the daemon being unreachable", async () => {
    const err = await failure((ws) => {
      ws.head();
      ws.closed(1006);
    });
    expect(isUnreachable(err)).toBe(true);
  });

  it("maps the daemon's 401 head to Unauthenticated", async () => {
    const err = await failure((ws) => {
      ws.head(401, { "content-type": "application/json" });
      ws.closed(1000);
    });
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unauthenticated);
  });

  it("ends cleanly on the end of stream and a close of 1000", async () => {
    const err = await failure((ws) => {
      ws.head();
      ws.frame(...endStream("{}"));
      ws.closed(1000);
    });
    expect(err).toBeNull();
  });

  it("reports the end of stream's error, not the close", async () => {
    const err = await failure((ws) => {
      ws.head();
      ws.frame(...endStream('{"error":{"code":"canceled","message":"shutting down"}}'));
      ws.closed(1000);
    });
    expect((err as ConnectError).code).toBe(Code.Canceled);
    expect(isUnreachable(err)).toBe(false);
  });

  it("fails a stream that closes 1000 with no end of stream", async () => {
    const err = await failure((ws) => {
      ws.head();
      ws.closed(1000);
    });
    expect(err).not.toBeNull();
  });
});
