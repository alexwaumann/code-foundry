import { afterEach, describe, expect, it, vi } from "vitest";
import type { DescService } from "@bufbuild/protobuf";
import { EmberService } from "@/gen/codefoundry/v1/ember_pb";
import { HealthService } from "@/gen/codefoundry/v1/health_pb";
import { TerminalService } from "@/gen/codefoundry/v1/terminal_pb";
import { DaemonConnection, jsonRequested } from "./endpoint";

/** Every server-streaming RPC in the generated code: its procedure, its service, its client method. */
function serverStreams(): [string, DescService, string][] {
  const modules = import.meta.glob<Record<string, unknown>>("/src/gen/codefoundry/v1/*_pb.ts", { eager: true });
  const services = Object.values(modules)
    .flatMap((m) => Object.values(m))
    .filter((v): v is DescService => (v as DescService | null)?.kind === "service");
  return services.flatMap((s) => s.methods.filter((m) => m.methodKind === "server_streaming").map((m): [string, DescService, string] => [`${s.typeName}/${m.name}`, s, m.localName]));
}

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

  // From the generated code, so a new service is checked the day it lands: a stream on fetch
  // would quietly hold one of WebKit's six connections, and no other test would notice.
  it.each(serverStreams())("is the socket for %s", async (procedure, service, method) => {
    const got = await reached(async (conn) => {
      const client = (await conn.client(service)) as unknown as Record<string, (req: object) => AsyncIterable<unknown>>;
      return client[method]?.({})[Symbol.asyncIterator]().next();
    });
    expect(got).toEqual({ socket: [`ws://127.0.0.1:1/stream/${procedure}`], fetch: [] });
  });

  it("finds the streams the GUI lives on", () => {
    const names = serverStreams().map(([procedure]) => procedure);
    expect(names).toEqual(expect.arrayContaining(["codefoundry.v1.EventService/Watch", "codefoundry.v1.ThreadService/WatchThread", "codefoundry.v1.TerminalService/Attach", "codefoundry.v1.PluginService/WatchSurface"]));
  });

  it("is built in one place: nothing else can open a stream on another transport", () => {
    const builders = Object.entries(import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }))
      .filter(([, text]) => text.includes('from "@connectrpc/connect-web"'))
      .map(([path]) => path);
    expect(builders).toEqual(["/src/api/endpoint.ts"]);
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
