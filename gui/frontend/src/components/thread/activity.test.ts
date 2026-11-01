// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadActivity } from "./activity";

const setThread = (status: ThreadView["status"], state: ThreadView["state"] = "connected") => {
  act(() => {
    useThreadsStore.setState({ byId: { s: { id: "s", state, status } as ThreadView }, order: ["s"] });
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  useThreadStore.setState({ logs: {}, pending: {}, answering: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

// The timeline's strips are on while the thread is on a turn (rows.test.tsx "a live tool strip",
// threadTimeline.test.ts "live tool strip (stripRuns)"); ThreadPane and InlineThread pass this on.
describe("useThreadActivity: timelineStrips", () => {
  it("on while working; off 2 s after the turn ends (the header turns over in place)", () => {
    setThread("busy");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current.timelineStrips).toBe(true);
    setThread("idle");
    expect(result.current.timelineStrips).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.timelineStrips).toBe(false);
  });

  it("on while waiting on the user mid-turn; off for a stopped thread", () => {
    act(() => {
      useThreadStore.setState({ pending: { s: { threadId: "s", seq: 1, pending: [{ requestId: "r", itemId: "p", question: false, toolName: "Bash", summary: "Bash ls" }] } } });
    });
    setThread("attention");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current.working).toBe(false);
    expect(result.current.timelineStrips).toBe(true);
    setThread("busy", "disconnected");
    expect(result.current.timelineStrips).toBe(false);
  });
});
