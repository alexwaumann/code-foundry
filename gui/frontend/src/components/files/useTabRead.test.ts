import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadLog } from "@/stores/thread";
import { editsOf, useDebounced, useTabRead } from "./useTabRead";

function tool(id: string, name: string, input: Record<string, unknown>, status: "running" | "done" | "error" = "done", isError = false): ThreadItemView {
  return { id, ordinal: 0, kind: "tool", toolUseId: id, name, inputJson: JSON.stringify(input), status, output: "", isError, resultJson: "" } as unknown as ThreadItemView;
}

function log(items: ThreadItemView[]): ThreadLog {
  return { seq: 1, byId: Object.fromEntries(items.map((i) => [i.id, i])), order: items.map((i) => i.id), pending: [], mcp: null, commands: [], agents: [] };
}

describe("editsOf", () => {
  it("counts finished edits of the path, nothing else", () => {
    const l = log([
      tool("1", "Edit", { file_path: "/w/a.ts" }),
      tool("2", "Write", { file_path: "/w/a.ts" }),
      tool("3", "Read", { file_path: "/w/a.ts" }),
      tool("4", "Edit", { file_path: "/w/b.ts" }),
      tool("5", "Edit", { file_path: "/w/a.ts" }, "running"),
      tool("6", "MultiEdit", { file_path: "/w/a.ts" }, "done", true),
      tool("7", "NotebookEdit", { notebook_path: "/w/a.ts" }),
    ]);
    expect(editsOf(l, "/w/a.ts")).toBe(3);
    expect(editsOf(l, "")).toBe(0);
    expect(editsOf(undefined, "/w/a.ts")).toBe(0);
  });
});

describe("useTabRead", () => {
  it("reads on mount and on reload, keeping the data while a reload runs", async () => {
    let n = 0;
    const read = vi.fn(() => Promise.resolve(++n));
    const { result } = renderHook(() => useTabRead("k", read));
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.data).toBe(1);
    });
    expect(result.current.loading).toBe(false);
    act(() => {
      result.current.reload();
    });
    expect(result.current).toMatchObject({ data: 1, loading: true });
    await waitFor(() => {
      expect(result.current.data).toBe(2);
    });
  });

  it("keeps the last data with the error of a failed re-read; a new key starts empty", async () => {
    let fail = false;
    const read = () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve("ok"));
    const { result, rerender } = renderHook(({ k }) => useTabRead(k, read), { initialProps: { k: "a" } });
    await waitFor(() => {
      expect(result.current.data).toBe("ok");
    });
    fail = true;
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });
    expect(result.current.data).toBe("ok");
    rerender({ k: "b" });
    expect(result.current).toMatchObject({ data: null, error: null, loading: true });
  });
});

describe("useDebounced", () => {
  it("runs once after the last call", () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn();
      const { result } = renderHook(() => useDebounced(f, 100));
      result.current();
      result.current();
      vi.advanceTimersByTime(99);
      expect(f).not.toHaveBeenCalled();
      result.current();
      vi.advanceTimersByTime(100);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
