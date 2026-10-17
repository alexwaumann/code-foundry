// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLinger } from "./linger";

afterEach(() => {
  vi.useRealTimers();
});

describe("useLinger", () => {
  it.each([
    // [what, ms, after (ms since it turned false), want]
    ["held right after it turns false", 2000, 0, true],
    ["still held just before ms", 2000, 1999, true],
    ["false once ms passed", 2000, 2000, false],
    ["ms 0 follows at once", 0, 0, false],
  ])("%s", (_what, ms, after, want) => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v, ms }: { v: boolean; ms: number }) => useLinger(v, ms), { initialProps: { v: true, ms } });
    expect(result.current).toBe(true);
    rerender({ v: false, ms });
    act(() => {
      vi.advanceTimersByTime(after);
    });
    expect(result.current).toBe(want);
  });

  it("true again restarts the hold; false from the start is false", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => useLinger(v, 1000), { initialProps: { v: false } });
    expect(result.current).toBe(false);
    rerender({ v: true });
    rerender({ v: false });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    rerender({ v: true });
    rerender({ v: false });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(false);
  });

  it("a hold ends at once when ms drops to 0 (a request docks)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v, ms }: { v: boolean; ms: number }) => useLinger(v, ms), { initialProps: { v: true, ms: 1000 } });
    rerender({ v: false, ms: 1000 });
    expect(result.current).toBe(true);
    rerender({ v: false, ms: 0 });
    expect(result.current).toBe(false);
  });
});
