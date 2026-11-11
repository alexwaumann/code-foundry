import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../bindings/github.com/alexwaumann/code-foundry/gui/shotservice", () => ({
  PageReady: () => {
    calls.push(["PageReady"]);
    return Promise.resolve();
  },
  Rendered: (id: string, r: unknown) => {
    calls.push(["Rendered", id, r]);
    return Promise.resolve();
  },
  Failed: (id: string, failure: string, reason: string) => {
    calls.push(["Failed", id, failure, reason]);
    return Promise.reject(new Error("host gone"));
  },
}));

import { reportShotToHost, shotPageReady } from "./shot";

function inHost(on: boolean) {
  const w = window as { _wails?: unknown };
  if (on) w._wails = { environment: {} };
  else delete w._wails;
}

afterEach(() => {
  calls.length = 0;
  inHost(false);
  vi.restoreAllMocks();
});

describe("shot page to host", () => {
  it("calls nothing without a host", () => {
    shotPageReady();
    reportShotToHost({ id: "a", ok: true, contentHeight: 900 });
    reportShotToHost({ id: "b", ok: false, failure: "timeout", reason: "late" });
    expect(calls).toEqual([]);
  });

  it("says ready and reports each outcome to the host", async () => {
    inHost(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    shotPageReady();
    reportShotToHost({ id: "a", ok: true, contentHeight: 1640 });
    reportShotToHost({ id: "b", ok: false, failure: "plugin-down", reason: "hello crashed" });
    expect(calls).toEqual([
      ["PageReady"],
      ["Rendered", "a", { contentHeight: 1640 }],
      ["Failed", "b", "plugin-down", "hello crashed"],
    ]);
    // A host call that fails only warns.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith("shot report", expect.any(Error));
    });
  });
});
