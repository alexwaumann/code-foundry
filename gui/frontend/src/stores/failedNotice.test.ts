import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadSetupView, ThreadView } from "@/api/threads";
import { useFailedPrompt } from "./failedNotice";
import { useThreadStore, type ThreadLog } from "./thread";
import { useThreadsStore } from "./threads";

/**
 * useFailedPrompt's wiring: what it reads from the thread reaches lib/failedPrompt's rule
 * (whose cases are its own test). A failed setup's turn end looks like a stopped Claude, so
 * the setup has to reach it for the composer's slot to stay the setup's note's.
 */

const base = { parentToolUseId: "", createdAtMs: 100, updatedAtMs: 100, streaming: false };
const user: ThreadItemView = { ...base, id: "u1", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" };
const setup = (phase: ThreadSetupView["phase"]): ThreadSetupView => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });

const put = (o: Partial<ThreadView>) => {
  useThreadsStore.setState({ byId: { s: { id: "s", state: "disconnected", status: "error", statusReason: "interrupted", statusChangedAtMs: 200, transcriptMissing: false, setup: null, ...o } as ThreadView }, order: ["s"] });
};

beforeEach(() => {
  useThreadStore.setState({ logs: { s: { order: ["u1"], byId: { u1: user } } as unknown as ThreadLog } });
});

afterEach(() => {
  useThreadStore.setState({ logs: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("useFailedPrompt", () => {
  it("offers the message of a turn that failed", () => {
    put({});
    expect(renderHook(() => useFailedPrompt("s", 0)).result.current).toEqual({ itemId: "u1", line: "Claude stopped before replying, so your message was not sent." });
  });

  it.each(["failed", "cancelled", "running"] as const)("stays silent on a setup that is %s: the setup's note has the slot", (phase) => {
    put({ setup: setup(phase) });
    expect(renderHook(() => useFailedPrompt("s", 0)).result.current).toBeNull();
  });

  it("speaks again once the setup finished, and follows the thread's state", () => {
    put({ setup: setup("failed") });
    const { result } = renderHook(() => useFailedPrompt("s", 0));
    expect(result.current).toBeNull();
    act(() => {
      put({ setup: setup("done") });
    });
    expect(result.current?.itemId).toBe("u1");
  });

  it("takes the prompts docked in the composer", () => {
    put({});
    expect(renderHook(() => useFailedPrompt("s", 1)).result.current).toBeNull();
  });
});
