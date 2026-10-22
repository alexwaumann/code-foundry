import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHealthStore } from "@/stores/health";
import { resizeHeight, usePreviewGrant } from "./previewGrant";

const previewFile = vi.fn();
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  previewFile: (...args: unknown[]) => previewFile(...args) as unknown,
}));

const up = (pid: number) => {
  useHealthStore.setState({ status: "ok", health: { pid, version: "dev", uptimeSeconds: 1 }, error: null });
};

afterEach(() => {
  cleanup();
  previewFile.mockReset();
  useHealthStore.setState({ status: "connecting", health: null, error: null });
});

describe("usePreviewGrant", () => {
  it("asks again when the daemon restarts (grants die with it), not while it is down", async () => {
    up(1);
    let n = 0;
    previewFile.mockImplementation(() => Promise.resolve({ url: `/preview/g${String(++n)}/a.html`, scope: "/Users/me", singleFile: true }));
    const { result } = renderHook(() => usePreviewGrant("/Users/me", "a.html"));
    await waitFor(() => {
      expect(result.current.preview?.url).toBe("/preview/g1/a.html");
    });
    act(() => {
      useHealthStore.setState({ status: "connecting", health: null, error: null });
    });
    expect(previewFile).toHaveBeenCalledTimes(1);
    expect(result.current.preview?.url).toBe("/preview/g1/a.html");
    act(() => {
      up(2);
    });
    await waitFor(() => {
      expect(result.current.preview?.url).toBe("/preview/g2/a.html");
    });
    expect(previewFile).toHaveBeenCalledTimes(2);
  });
});

describe("resizeHeight", () => {
  it.each([
    [{ type: "cf:resize", height: 240 }, 240],
    [{ type: "cf:resize", height: 0 }, null],
    [{ type: "cf:resize", height: "240" }, null],
    [{ type: "cf:theme", height: 240 }, null],
    [null, null],
  ])("%j -> %s", (data, want) => {
    expect(resizeHeight(data)).toBe(want);
  });
});
