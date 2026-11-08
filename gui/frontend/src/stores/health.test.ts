import { beforeEach, describe, expect, it, vi } from "vitest";

const ping = vi.fn();
const wakeAllStreams = vi.fn();

vi.mock("@/api/health", () => ({ ping: () => ping() }));
vi.mock("@/api/stream", () => ({ wakeAllStreams: () => wakeAllStreams() }));

const { useHealthStore } = await import("./health");

const view = { pid: 1, version: "dev", uptimeSeconds: 1 };

describe("health store", () => {
  beforeEach(() => {
    useHealthStore.setState({ status: "connecting", health: null, error: null });
    ping.mockReset();
    wakeAllStreams.mockReset();
  });

  it.each<[string, Array<"ok" | "error">, number]>([
    ["the first answer after connecting", ["ok"], 1],
    ["the daemon answering again after an outage", ["ok", "error", "error", "ok"], 2],
    ["answers that keep coming", ["ok", "ok", "ok"], 1],
    ["a daemon that stops answering", ["ok", "error"], 1],
    ["a daemon that never answers", ["error", "error"], 0],
  ])("wakes the streams on %s", async (_name, pings, wakes) => {
    for (const p of pings) {
      if (p === "ok") ping.mockResolvedValueOnce(view);
      else ping.mockRejectedValueOnce(new TypeError("Load failed"));
      await useHealthStore.getState().refresh();
      expect(useHealthStore.getState().status).toBe(p);
    }
    expect(wakeAllStreams).toHaveBeenCalledTimes(wakes);
  });

  it("wakes the streams after the status says ok", async () => {
    ping.mockResolvedValueOnce(view);
    wakeAllStreams.mockImplementation(() => {
      expect(useHealthStore.getState().status).toBe("ok");
    });
    await useHealthStore.getState().refresh();
    expect(wakeAllStreams).toHaveBeenCalledTimes(1);
  });
});
