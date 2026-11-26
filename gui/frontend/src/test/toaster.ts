import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { dismissNotice } from "@/lib/notify";

/**
 * For a test file that mounts the real Toaster (components/ui/sonner). Call it at the top of
 * the file, before the file's own hooks.
 *
 * sonner updates the Toaster from timers of its own: a dismiss goes through a
 * requestAnimationFrame, a closed toast leaves 200ms later, a new one lands on a 0ms timeout.
 * Whatever is still pending when the file ends fires into React after the file's jsdom is
 * gone, as "ReferenceError: window is not defined" (react-dom's resolveUpdatePriority), an
 * unhandled error that fails the run with every test passed. Here the forked worker exits
 * within milliseconds of the file, so it never shows; on a slow CI runner it lived past the
 * 200ms (docs/notes/testing-gotchas.md).
 *
 * So every test runs on fake timers that advance with the real clock (waitFor, sonner's own
 * animations and durations behave as with real ones), and after each test the toasts are
 * dismissed, the tree unmounted and the timers dropped: nothing sonner scheduled outlives
 * the test. The afterEach does all three itself, so its order against the file's own
 * afterEach (which may dismiss and clean up too) does not matter.
 */
export function dropToasterTimers(): void {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    act(() => {
      dismissNotice();
    });
    cleanup();
    vi.useRealTimers(); // drops what is still pending
  });
}
