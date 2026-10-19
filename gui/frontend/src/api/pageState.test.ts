import { afterEach, describe, expect, it, vi } from "vitest";
import { isPageAttended, isPageFocused, onPageStateChange, PAGE_STATE_SETTLE_MS } from "./stream";

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function setFocus(focused: boolean): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("isPageAttended", () => {
  // The dock alerts' predicate and the daemon's attended rule for one client.
  it.each([
    { name: "visible and key: attended", visibility: "visible", focused: true, want: true },
    { name: "visible, another app active: not attended", visibility: "visible", focused: false, want: false },
    { name: "covered or minimized while key: not attended", visibility: "hidden", focused: true, want: false },
    { name: "hidden and another app active: not attended", visibility: "hidden", focused: false, want: false },
  ] as const)("$name", ({ visibility, focused, want }) => {
    setVisibility(visibility);
    setFocus(focused);
    expect(isPageAttended()).toBe(want);
    expect(isPageFocused()).toBe(focused);
  });
});

describe("onPageStateChange", () => {
  it("calls back once the state settles after visibilitychange, focus and blur", () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const stop = onPageStateChange(cb);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS);
    expect(cb).toHaveBeenCalledTimes(3);
    stop();
  });

  it("coalesces a quick flip into one call", () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const stop = onPageStateChange(cb);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS / 2);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it("calls nothing after it stopped, even for a change already pending", () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const stop = onPageStateChange(cb);
    window.dispatchEvent(new Event("blur"));
    stop();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(PAGE_STATE_SETTLE_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });
});
