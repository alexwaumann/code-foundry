// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadActivity } from "./activity";

const setThread = (status: ThreadView["status"], state: ThreadView["state"] = "connected", over: Partial<ThreadView> = {}) => {
  act(() => {
    useThreadsStore.setState({ byId: { s: { id: "s", state, status, ...over } as ThreadView }, order: ["s"] });
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

  it("a worker's question passed up is no turn of the lead's own: not busy, no strips (docs/notes/pass-up-question.md)", () => {
    act(() => {
      useThreadStore.setState({ pending: { s: { threadId: "s", seq: 1, pending: [{ requestId: "pu-1", itemId: "q", question: true, toolName: "AskUserQuestion", summary: "From W: ?", fromThreadId: "w" }] } } });
    });
    setThread("attention");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current.busy).toBe(false);
    expect(result.current.timelineStrips).toBe(false);
    expect(result.current.open).toHaveLength(1);
  });
});

// The three cases a lead's composer (Interrupt: busy), the pill's Working segment and the live
// turn header (working, timelineWorking) read (docs/notes/pass-up-question.md).
describe("useThreadActivity: a passed-up question", () => {
  const passedUp = { requestId: "pu-1", itemId: "q", question: true, toolName: "AskUserQuestion", summary: "From W: ?", fromThreadId: "w" };
  const own = { requestId: "r", itemId: "p", question: true, toolName: "AskUserQuestion", summary: "Which?" };
  const pend = (...pending: (typeof passedUp | typeof own)[]) => {
    act(() => {
      useThreadStore.setState({ pending: { s: { threadId: "s", seq: 1, pending } } });
    });
  };

  it("its own blocking question: busy (Interrupt), not working (no Working, no live header)", () => {
    pend(own);
    setThread("attention");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current).toMatchObject({ busy: true, working: false, timelineWorking: false });
  });

  it("passed up while the lead works: busy (Interrupt) and working (Working, the live header)", () => {
    pend(passedUp);
    setThread("attention", "connected", { busyUnderPassUp: true });
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current).toMatchObject({ busy: true, working: true, timelineWorking: true, timelineStrips: true });
    expect(result.current.open).toHaveLength(1);
  });

  it("passed up while the lead is idle: neither", () => {
    pend(passedUp);
    setThread("attention");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current).toMatchObject({ busy: false, working: false, timelineWorking: false });
  });

  it("passed up, then the lead asks its own: it blocks, so no Working", () => {
    pend(passedUp, own);
    setThread("attention");
    const { result } = renderHook(() => useThreadActivity("s"));
    expect(result.current).toMatchObject({ busy: true, working: false });
  });

  it("the lead's turn ends under it: the header lingers 2 s, then not working", () => {
    pend(passedUp);
    setThread("attention", "connected", { busyUnderPassUp: true });
    const { result } = renderHook(() => useThreadActivity("s"));
    setThread("attention");
    expect(result.current).toMatchObject({ busy: false, working: false, timelineWorking: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.timelineWorking).toBe(false);
  });
});
