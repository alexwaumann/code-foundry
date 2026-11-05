import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSetupView, ThreadView } from "@/api/threads";

vi.mock("./Timeline", () => ({ Timeline: () => <div data-testid="thread-timeline" /> }));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => <div data-testid="thread-composer" /> }));
vi.mock("@/stores/thread", async (orig) => ({ ...(await orig<typeof import("@/stores/thread")>()), startThreadWatch: () => () => undefined }));

const { ThreadPane } = await import("./ThreadPane");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { thread } = await import("@/test/projectsWorld");

/** A thread made with no prompt has its setup's row: "No messages yet" must not sit over it. */

const setup = (phase: ThreadSetupView["phase"], steps: ThreadSetupView["steps"] = []): ThreadSetupView => ({ phase, startedAtMs: 1, endedAtMs: 2, steps, error: "", background: true });

const worktree = { kind: "worktree", projectId: "p", projectName: "p", ref: "", branch: "", status: "failed", startedAtMs: 1, endedAtMs: 2, error: "no", warning: "", refAtMs: null, existing: false } as const;

function show(o: Partial<ThreadView>): void {
  useThreadsStore.setState({ byId: { s: thread("s", { state: "disconnected", status: "idle", statusReason: "", backgroundShells: [], agentRuns: [], flags: [], ...o }) }, order: ["s"] });
  render(<ThreadPane threadId="s" />);
}

beforeEach(() => {
  useThreadStore.setState({ logs: { s: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: [], wakes: [] } }, synced: { s: true } });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, synced: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("No messages yet", () => {
  it("shows on a thread with nothing to show", () => {
    show({ setup: null });
    expect(screen.getByTestId("thread-empty")).toBeTruthy();
  });

  it.each<[string, ThreadSetupView]>([
    ["failed", setup("failed", [worktree])],
    ["cancelled", setup("cancelled", [worktree])],
  ])("stays off a setup that %s, whose row is there", (_n, s) => {
    show({ setup: s });
    expect(screen.queryByTestId("thread-empty")).toBeNull();
  });
});
