import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SETTLE_FRAMES, useOnScreen } from "./live";

/** One observer's callback, and the frames waiting to run. */
let report: (on: boolean) => void;
let frames = new Map<number, FrameRequestCallback>();

function runFrames(n: number) {
  act(() => {
    for (let i = 0; i < n; i++) {
      const due = [...frames.values()];
      frames = new Map();
      for (const f of due) f(0);
    }
  });
}

function Probe() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const on = useOnScreen(el);
  return <div ref={setEl} data-testid="probe" data-on={on} />;
}

const shown = () => screen.getByTestId("probe").getAttribute("data-on");

beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
    frames.set(++id, f);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (n: number) => {
    frames.delete(n);
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        report = (on) => {
          act(() => {
            cb([{ isIntersecting: on }]);
          });
        };
      }
      observe() {
        // Reported by the test.
      }
      disconnect() {
        // Nothing to stop.
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useOnScreen", () => {
  it("is on only once the node has stayed on screen while layout settles", () => {
    render(<Probe />);
    expect(shown()).toBe("false");
    report(true);
    runFrames(SETTLE_FRAMES - 1);
    expect(shown()).toBe("false");
    runFrames(1);
    expect(shown()).toBe("true");
  });

  it("never goes on for a first layout that moves the node off screen", () => {
    render(<Probe />);
    report(true);
    runFrames(1);
    report(false);
    runFrames(SETTLE_FRAMES * 2);
    expect(shown()).toBe("false");
    expect(frames.size).toBe(0);
  });

  it("starts the wait again when the node comes back", () => {
    render(<Probe />);
    report(true);
    runFrames(SETTLE_FRAMES - 1);
    report(false);
    report(true);
    runFrames(SETTLE_FRAMES - 1);
    expect(shown()).toBe("false");
    runFrames(1);
    expect(shown()).toBe("true");
  });

  it("goes off at once when the node leaves the screen", () => {
    render(<Probe />);
    report(true);
    runFrames(SETTLE_FRAMES);
    report(false);
    expect(shown()).toBe("false");
  });

  it("leaves no frame waiting when the node goes", () => {
    const { unmount } = render(<Probe />);
    report(true);
    unmount();
    expect(frames.size).toBe(0);
  });
});
