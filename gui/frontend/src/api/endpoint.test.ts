import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationService } from "@/gen/codefoundry/v1/dictation_pb";
import { EmberService } from "@/gen/codefoundry/v1/ember_pb";
import { EventService } from "@/gen/codefoundry/v1/events_pb";
import { HealthService } from "@/gen/codefoundry/v1/health_pb";
import { PluginService } from "@/gen/codefoundry/v1/plugin_pb";
import { ProjectService } from "@/gen/codefoundry/v1/project_pb";
import { SearchService } from "@/gen/codefoundry/v1/search_pb";
import { TerminalService } from "@/gen/codefoundry/v1/terminal_pb";
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { DaemonConnection, jsonRequested } from "./endpoint";

describe("jsonRequested", () => {
  it.each([
    ["", false],
    ["?daemon=http%3A%2F%2F127.0.0.1%3A1&token=t", false],
    ["?json=0", false],
    ["?json=true", false],
    ["?json=1", true],
    ["?daemon=x&token=t&json=1", true],
  ])("%s -> %s", (search, want) => {
    expect(jsonRequested(search)).toBe(want);
  });
});

describe("the wire format", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  /** The Content-Type of one call made through a new connection. */
  async function sentType(): Promise<string> {
    const fetchStub = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("no network in a test")));
    vi.stubGlobal("fetch", fetchStub);
    const conn = new DaemonConnection(() => Promise.resolve({ baseUrl: "http://127.0.0.1:1", token: "t" }));
    const client = await conn.client(HealthService);
    await client.ping({}).catch(() => undefined);
    return new Headers(fetchStub.mock.calls[0]?.[1]?.headers).get("Content-Type") ?? "";
  }

  // Connect-Web's default is JSON, which nothing else would notice: the app works, only slower.
  it("is binary protobuf", async () => {
    expect(await sentType()).toBe("application/proto");
  });

  it("is JSON with ?json=1 in a development build", async () => {
    window.history.replaceState(null, "", "/?json=1");
    expect(await sentType()).toBe("application/json");
  });
});

describe("which transport a call takes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs one call on stubs that fail at once, and says which of them it reached. */
  async function reached(call: (conn: DaemonConnection) => Promise<unknown>): Promise<{ socket: string[]; fetch: string[] }> {
    const socket: string[] = [];
    class StubSocket {
      onclose: ((e: { code: number }) => void) | null = null;
      constructor(url: string) {
        socket.push(url);
        queueMicrotask(() => this.onclose?.({ code: 1006 }));
      }
      close() {
        // The stub is already closed.
      }
    }
    vi.stubGlobal("WebSocket", StubSocket);
    const fetchStub = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("no network in a test")));
    vi.stubGlobal("fetch", fetchStub);
    await call(new DaemonConnection(() => Promise.resolve({ baseUrl: "http://127.0.0.1:1", token: "t" }))).catch(() => undefined);
    return { socket, fetch: fetchStub.mock.calls.map(([url]) => url as string) };
  }

  it.each<[string, (conn: DaemonConnection) => Promise<unknown>]>([
    ["EmberService/WatchBoard", async (conn) => (await conn.client(EmberService)).watchBoard({})[Symbol.asyncIterator]().next()],
    ["ThreadService/WatchThread", async (conn) => (await conn.client(ThreadService)).watchThread({})[Symbol.asyncIterator]().next()],
    ["TerminalService/Attach", async (conn) => (await conn.client(TerminalService)).attach({})[Symbol.asyncIterator]().next()],
    ["PluginService/WatchSurface", async (conn) => (await conn.client(PluginService)).watchSurface({})[Symbol.asyncIterator]().next()],
    ["EventService/Watch", async (conn) => (await conn.client(EventService)).watch({})[Symbol.asyncIterator]().next()],
    ["DictationService/Watch", async (conn) => (await conn.client(DictationService)).watch({})[Symbol.asyncIterator]().next()],
    ["DictationService/Session", async (conn) => (await conn.client(DictationService)).session({})[Symbol.asyncIterator]().next()],
    ["SearchService/Watch", async (conn) => (await conn.client(SearchService)).watch({})[Symbol.asyncIterator]().next()],
    ["SearchService/WatchRecent", async (conn) => (await conn.client(SearchService)).watchRecent({})[Symbol.asyncIterator]().next()],
    ["ProjectService/Clone", async (conn) => (await conn.client(ProjectService)).clone({})[Symbol.asyncIterator]().next()],
  ])("is the socket for %s", async (procedure, call) => {
    const got = await reached(call);
    expect(got).toEqual({ socket: [`ws://127.0.0.1:1/stream/codefoundry.v1.${procedure}`], fetch: [] });
  });

  it("is fetch for a unary call of a service with a stream", async () => {
    const got = await reached(async (conn) => (await conn.client(EmberService)).getStatus({}));
    expect(got).toEqual({ socket: [], fetch: ["http://127.0.0.1:1/codefoundry.v1.EmberService/GetStatus"] });
  });

  it("is fetch for a terminal's input, which never waits on a stream", async () => {
    const got = await reached(async (conn) => (await conn.client(TerminalService)).write({ id: "t", data: new Uint8Array([1]) }));
    expect(got).toEqual({ socket: [], fetch: ["http://127.0.0.1:1/codefoundry.v1.TerminalService/Write"] });
  });
});
