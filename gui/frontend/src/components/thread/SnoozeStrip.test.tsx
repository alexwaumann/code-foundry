import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { SnoozeStrip } = await import("./SnoozeStrip");
const { useThreadsStore } = await import("@/stores/threads");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld } = await import("@/test/projectsWorld");

// The strip above the composer of a snoozed or saved thread: until when, and Dismiss snooze, which
// runs what the title menu's Unsnooze runs. Sending a message waking it is the daemon's rule
// (internal/store/thread snooze_test.go). Where it sits in the dock: e2e snooze.spec.ts.

beforeEach(() => {
  resetDaemon();
  seedWorld();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

function set(id: string, o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), ...o } } }));
  });
}

const show = (id: string) =>
  render(
    <TooltipProvider>
      <SnoozeStrip threadId={id} />
    </TooltipProvider>,
  );
const button = () => screen.getByTestId<HTMLButtonElement>("snooze-dismiss");
const sentence = () => screen.getByTestId("snooze-sentence").textContent;

describe("SnoozeStrip", () => {
  it("snoozed: until when, with Dismiss snooze, which runs thread.snooze --clear; unsnoozed, the strip goes", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    set("s-1", { snoozedUntilMs: tomorrow.getTime() });
    show("s-1");
    expect(sentence()).toMatch(/^Snoozed until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) 9:00 AM$/);
    expect(button().textContent).toBe("Dismiss snooze");
    fireEvent.click(button());
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { clear: "true" }, context: { activeThreadId: "s-1" } });
    });
    set("s-1", { snoozedUntilMs: null });
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
  });

  it("snoozed for a few hours today: the time alone", () => {
    set("s-8", { snoozedUntilMs: Date.now() + 3 * 3_600_000 });
    show("s-8");
    expect(sentence()).toMatch(/^Snoozed until (\w{3} )?\d{1,2}:\d\d [AP]M$/);
  });

  it("saved for later: says so with no time, with Dismiss snooze, which runs thread.snooze --clear", async () => {
    set("s-1", { savedAtMs: Date.now() });
    show("s-1");
    expect(sentence()).toBe("Saved for later");
    fireEvent.click(button());
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { clear: "true" }, context: { activeThreadId: "s-1" } });
    });
    set("s-1", { savedAtMs: null });
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
  });

  it("the button holds while the command runs, once", async () => {
    set("s-1", { savedAtMs: Date.now() });
    let finish = (): void => undefined;
    daemon.handlers.set("thread.snooze", () => new Promise((resolve) => (finish = () => {
      resolve({ message: "", resultJson: "" });
    })));
    show("s-1");
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(daemon.invocations.filter((i) => i.name === "thread.snooze")).toHaveLength(1);
    finish();
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
  });

  it("a failure toasts, the strip stays, and it can be pressed again", async () => {
    set("s-1", { savedAtMs: Date.now() });
    daemon.handlers.set("thread.snooze", () => {
      throw new Error("no such thread");
    });
    show("s-1");
    fireEvent.click(button());
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.objectContaining({ description: expect.stringContaining("no such thread") as string }));
    });
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(screen.getByTestId("snooze-strip")).toBeTruthy();
  });

  it("a woken thread, or one never snoozed: nothing", () => {
    set("s-8", { snoozedUntilMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() });
    show("s-8");
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
    cleanup();
    show("s-3");
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
  });
});
