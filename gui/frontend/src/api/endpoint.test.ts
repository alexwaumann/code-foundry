import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthService } from "@/gen/codefoundry/v1/health_pb";
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
