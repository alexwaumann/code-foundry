// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadPendingView } from "@/api/thread";
import { setAnswering, useOpenRequests, useThreadStore } from "./thread";

const pend = (requestId: string): ThreadPendingView => ({ requestId, itemId: `perm-${requestId}`, question: false, toolName: "Bash", summary: "Bash ls" });

beforeEach(() => {
  useThreadStore.setState({ answering: {}, pending: { s1: { threadId: "s1", seq: 1, pending: [pend("r1"), pend("r2")] } } });
});

// respondThread marks and unmarks (threadActions.test.ts "a failed answer brings the prompt back once…");
// this is what the composer's prompts read.
describe("useOpenRequests", () => {
  it("a request being answered leaves at once; a failed answer brings it back", () => {
    const { result } = renderHook(() => useOpenRequests("s1").map((p) => p.requestId));
    expect(result.current).toEqual(["r1", "r2"]);
    act(() => {
      setAnswering("s1", "r1", true);
    });
    expect(result.current).toEqual(["r2"]);
    act(() => {
      setAnswering("s1", "r1", false);
    });
    expect(result.current).toEqual(["r1", "r2"]);
  });
});
