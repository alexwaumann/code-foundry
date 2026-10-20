// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_MS, useCopied } from "./useCopied";

const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockReset();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCopied", () => {
  it.each([
    // [what, ms, after (ms since the copy), want]
    ["copied right after the copy", COPIED_MS, 0, true],
    ["still copied just before ms", COPIED_MS, COPIED_MS - 1, true],
    ["back once ms passed", COPIED_MS, COPIED_MS, false],
    ["a custom ms", 300, 300, false],
  ])("%s", async (_what, ms, after, want) => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopied(ms));
    expect(result.current.copied).toBe(false);
    let ok = false;
    await act(async () => {
      ok = await result.current.copy("hello");
    });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    act(() => {
      vi.advanceTimersByTime(after);
    });
    expect(result.current.copied).toBe(want);
  });

  it("a second copy while copied restarts the wait", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopied(1000));
    await act(async () => {
      await result.current.copy("a");
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    await act(async () => {
      await result.current.copy("b");
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.copied).toBe(false);
  });

  it("a failed copy shows nothing and resolves false", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    // The textarea fallback (execCommand) fails too.
    Object.defineProperty(document, "execCommand", {
      value: () => {
        throw new Error("no");
      },
      configurable: true,
    });
    const { result } = renderHook(() => useCopied());
    let ok = true;
    await act(async () => {
      ok = await result.current.copy("x");
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });

  it("unmounting while copied clears the timer", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useCopied());
    await act(async () => {
      await result.current.copy("x");
    });
    expect(result.current.copied).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
