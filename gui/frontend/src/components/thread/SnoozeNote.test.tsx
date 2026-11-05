import { act, cleanup, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { SnoozeNote } = await import("./ThreadComposer");
const { useThreadsStore } = await import("@/stores/threads");
const { resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld } = await import("@/test/projectsWorld");

// The thread composer's line above the prompt: "Snooze ended · <ago>" in amber for a thread the
// daemon woke; nothing otherwise (a thread still snoozed has the dock's strip, SnoozeStrip.test.tsx).

beforeEach(() => {
  resetDaemon();
  seedWorld();
});
afterEach(cleanup);

function set(id: string, o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), ...o } } }));
  });
}

const woken = { snoozedUntilMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() } as const;

describe("SnoozeNote", () => {
  it("woken by the daemon: Snooze ended · just now, in amber", () => {
    set("s-8", woken);
    render(<SnoozeNote threadId="s-8" />);
    expect(screen.getByTestId("thread-snooze-note").textContent).toBe("Snooze ended · just now");
    expect(screen.getByTestId("thread-snooze-ended").className).toContain("text-cf-warning-text");
  });

  it.each([
    ["snoozed", { snoozedUntilMs: Date.now() + 3_600_000 }],
    ["saved for later", { savedAtMs: Date.now() }],
  ])("%s again, with the last wake's status not yet cleared: nothing, the strip has it", (_name, again) => {
    set("s-8", { ...woken, ...again });
    render(<SnoozeNote threadId="s-8" />);
    expect(screen.queryByTestId("thread-snooze-note")).toBeNull();
  });

  it("neither: nothing", () => {
    render(<SnoozeNote threadId="s-3" />);
    expect(screen.queryByTestId("thread-snooze-note")).toBeNull();
  });
});
