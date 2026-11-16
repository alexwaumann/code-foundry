import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const { SnoozeStrip } = await import("./SnoozeStrip");
const { useThreadsStore } = await import("@/stores/threads");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld } = await import("@/test/projectsWorld");

// The strip above the composer of a snoozed, saved or woken thread: until when, and Dismiss snooze, which
// runs what the title menu's Unsnooze runs. Sending a message waking it is the daemon's rule
// (internal/store/thread snooze_test.go). Where it sits in the dock: e2e snooze.spec.ts.

beforeEach(() => {
  resetDaemon();
  seedWorld();
  notify.mockClear();
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
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: expect.stringContaining("failed") as string, description: expect.stringContaining("no such thread") as string }));
    });
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    expect(screen.getByTestId("snooze-strip")).toBeTruthy();
  });

  it("a thread never snoozed: nothing", () => {
    show("s-3");
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
    expect(screen.queryByTestId("woken-strip")).toBeNull();
  });
});

// A woken thread (docs/notes/clear-woken-thread.md): the strip in the snooze strip's place, with
// Snooze again and Clear. Opening the thread does not clear it: only those, a send or an archive.
describe("SnoozeStrip, woken", () => {
  const wake = (id: string, at = Date.now() - 2 * 60_000) => {
    set(id, { snoozedUntilMs: null, savedAtMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: at });
  };
  const clear = () => screen.getByTestId<HTMLButtonElement>("woken-clear");

  it("says when it woke in the warning tone, with Snooze again and Clear", () => {
    wake("s-8");
    show("s-8");
    expect(screen.queryByTestId("snooze-strip")).toBeNull();
    const line = screen.getByTestId("woken-sentence");
    expect(line.textContent).toBe("Snooze ended · 2m ago");
    expect(line.className).toContain("text-cf-warning-text");
    expect(screen.getByTestId("woken-snooze").textContent).toBe("Snooze again");
    expect(clear().textContent).toBe("Clear");
  });

  it("Clear runs thread.snooze.clear for its thread, with no toast; cleared, the strip goes", async () => {
    wake("s-8");
    show("s-8");
    fireEvent.click(clear());
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze.clear")).toMatchObject({ args: {}, context: { activeThreadId: "s-8" } });
    });
    expect(notify).not.toHaveBeenCalled();
    set("s-8", { status: "idle", statusReason: "at prompt" });
    expect(screen.queryByTestId("woken-strip")).toBeNull();
  });

  it("Clear holds while the command runs, once", async () => {
    wake("s-8");
    let finish = (): void => undefined;
    daemon.handlers.set("thread.snooze.clear", () => new Promise((resolve) => (finish = () => {
      resolve({ message: "", resultJson: "" });
    })));
    show("s-8");
    fireEvent.click(clear());
    expect(clear().disabled).toBe(true);
    fireEvent.click(clear());
    expect(daemon.invocations.filter((i) => i.name === "thread.snooze.clear")).toHaveLength(1);
    finish();
    await waitFor(() => {
      expect(clear().disabled).toBe(false);
    });
  });

  it("Snooze again opens the snooze presets; a preset snoozes the thread, and the strip turns to the snooze's", async () => {
    wake("s-8");
    show("s-8");
    fireEvent.pointerDown(screen.getByTestId("woken-snooze"), { button: 0, ctrlKey: false });
    const presets = await screen.findAllByTestId("snooze-preset");
    expect(presets.length).toBeGreaterThan(0);
    expect(screen.getByTestId("snooze-pick")).toBeTruthy();
    fireEvent.click(presets[0] as HTMLElement);
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ context: { activeThreadId: "s-8" } });
    });
    expect(lastInvocation("thread.snooze")?.args.until).toBeTruthy();
    set("s-8", { snoozedUntilMs: Date.now() + 3_600_000, status: "idle", statusReason: "snoozed" });
    expect(screen.queryByTestId("woken-strip")).toBeNull();
    expect(screen.getByTestId("snooze-strip")).toBeTruthy();
  });
});
