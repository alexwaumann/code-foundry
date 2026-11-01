import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { SnoozeNote } = await import("./ThreadComposer");
const { useThreadsStore } = await import("@/stores/threads");
const { lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld } = await import("@/test/projectsWorld");

// The thread composer's snooze line above the prompt (e2e snooze.spec.ts used to read it in the
// app): until when, with Unsnooze, for a snoozed thread; "Snooze ended · <ago>" in amber for one
// the daemon woke; nothing otherwise. A message unsnoozing is the daemon's rule
// (internal/store/thread snooze_test.go).

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

describe("SnoozeNote", () => {
  it("snoozed: until when, with Unsnooze, which runs thread.snooze --clear; unsnoozed, the note goes", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    set("s-1", { snoozedUntilMs: tomorrow.getTime() });
    render(<SnoozeNote threadId="s-1" />);
    expect(screen.getByTestId("thread-snooze-note").textContent).toMatch(/^Snoozed until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) 9:00 AMUnsnooze$/);
    fireEvent.click(screen.getByTestId("thread-unsnooze"));
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { clear: "true" }, context: { activeThreadId: "s-1" } });
    });
    set("s-1", { snoozedUntilMs: null });
    expect(screen.queryByTestId("thread-snooze-note")).toBeNull();
  });

  it("snoozed for a few hours today: the time alone", () => {
    set("s-8", { snoozedUntilMs: Date.now() + 3 * 3_600_000 });
    render(<SnoozeNote threadId="s-8" />);
    expect(screen.getByTestId("thread-snoozed").textContent).toMatch(/^Snoozed until (\w{3} )?\d{1,2}:\d\d [AP]M$/);
  });

  it("woken by the daemon: Snooze ended · just now, in amber, no Unsnooze", () => {
    set("s-8", { snoozedUntilMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() });
    render(<SnoozeNote threadId="s-8" />);
    expect(screen.getByTestId("thread-snooze-note").textContent).toBe("Snooze ended · just now");
    expect(screen.getByTestId("thread-snooze-ended").className).toContain("text-cf-warning-text");
    expect(screen.queryByTestId("thread-unsnooze")).toBeNull();
  });

  it("neither: nothing", () => {
    render(<SnoozeNote threadId="s-3" />);
    expect(screen.queryByTestId("thread-snooze-note")).toBeNull();
  });
});
