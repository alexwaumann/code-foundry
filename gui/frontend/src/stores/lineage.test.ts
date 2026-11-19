import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { thread } from "@/test/projectsWorld";
import { useWorkers } from "./lineage";
import { useThreadStore } from "./thread";
import { useThreadsStore } from "./threads";

/**
 * The worker card's workers (docs/notes/worker-card.md) with a worker whose question this lead
 * passed up to the user reading "asks you" while it is open (docs/notes/pass-up-question.md),
 * from the lead's own pending list: no stream on the worker.
 */
describe("useWorkers", () => {
  beforeEach(() => {
    useThreadsStore.setState({
      byId: { L: thread("L", { name: "Lead" }), W: thread("W", { name: "Resize", createdBy: "L", status: "busy", statusReason: "working", state: "connected" }) },
      order: ["L", "W"],
      loaded: true,
    });
    useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
  });

  const passedUp = { requestId: "pu-1", itemId: "q-1", question: true, toolName: "AskUserQuestion", summary: "From Resize: ?", fromThreadId: "W" };

  it("asks you while the lead's passed-up question is open, then its own state again", () => {
    const { result } = renderHook(() => useWorkers("L"));
    expect(result.current.get("W")?.state).toBe("working");
    act(() => {
      useThreadStore.setState({ pending: { L: { threadId: "L", seq: 1, pending: [passedUp] } } });
    });
    expect(result.current.get("W")?.state).toBe("asks");
    act(() => {
      useThreadStore.setState({ answering: { L: { "pu-1": true } } });
    });
    expect(result.current.get("W")?.state).toBe("working");
    act(() => {
      useThreadStore.setState({ pending: {}, answering: {} });
    });
    expect(result.current.get("W")?.state).toBe("working");
  });

  it("the lead's own question changes no worker's line", () => {
    const { result } = renderHook(() => useWorkers("L"));
    act(() => {
      useThreadStore.setState({ pending: { L: { threadId: "L", seq: 1, pending: [{ ...passedUp, fromThreadId: undefined }] } } });
    });
    expect(result.current.get("W")?.state).toBe("working");
  });
});
