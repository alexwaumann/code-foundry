import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationView } from "@/api/notifications";
import { note, noteEvent } from "@/test/notificationFakes";
import { tooltipText } from "@/test/tooltip";

const runCommandForResult = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ message: string; resultJson: string } | null>>(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
const selectThreadAndFlag = vi.hoisted(() => vi.fn());
vi.mock("@/stores/flagSurface", async (orig) => ({ ...(await orig<typeof import("@/stores/flagSurface")>()), selectThreadAndFlag }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, dismissNotice: vi.fn(), notifyProgress: vi.fn() }));

const { NotificationBell } = await import("./NotificationBell");
const { applyNotificationEvent, resetNotifications, useNotificationsStore } = await import("@/stores/notifications");
const { usePluginsStore } = await import("@/stores/plugins");
const { useThreadsStore } = await import("@/stores/threads");
const { thread } = await import("@/test/projectsWorld");

/**
 * The top bar's bell and its list (docs/notes/notifications-3-bell.md): the count and its tone,
 * the list in the daemon's order, and which command each control runs with which args.
 */

function show(...notes: NotificationView[]): void {
  act(() => {
    applyNotificationEvent(noteEvent(notes));
  });
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

async function openBell(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("notification-bell"));
  return screen.findByTestId("notification-popover");
}

const cards = () => screen.queryAllByTestId("notification-card");
const cardOf = (id: string) => cards().find((c) => c.dataset.notificationId === id) as HTMLElement;

beforeEach(() => {
  resetNotifications();
  usePluginsStore.setState({ byName: { hello: { name: "hello", displayName: "Hello" } as never }, order: ["hello"] });
  useThreadsStore.setState({ byId: { "s-4": thread("s-4", { name: "Investigate flaky e2e" }), "s-7": thread("s-7", { name: "Old one", archivedAtMs: 5 }) }, order: ["s-4", "s-7"], loaded: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the bell", () => {
  it("is quiet with none: the icon only, no count, named Notifications", () => {
    show();
    render(<NotificationBell />);
    const bell = screen.getByTestId("notification-bell");
    expect(screen.queryByTestId("notification-bell-count")).toBeNull();
    expect(bell.getAttribute("aria-label")).toBe("Notifications");
    expect(tooltipText(bell)).toBe("Notifications");
  });

  it("counts the shown ones (snoozed ones wait outside), in the plain tone", () => {
    show(note("a"), note("b"), note("s", { status: "snoozed", timeSensitive: true }));
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-bell-count").textContent).toBe("2");
    expect(screen.getByTestId("notification-bell").dataset.urgent).toBeUndefined();
    expect(screen.getByTestId("notification-bell").getAttribute("aria-label")).toBe("2 notifications");
  });

  it("takes the attention tone while a shown one is time-sensitive", () => {
    show(note("u", { timeSensitive: true }), note("a"));
    render(<NotificationBell />);
    const bell = screen.getByTestId("notification-bell");
    expect(bell.dataset.urgent).toBe("true");
    expect(bell.className).toContain("text-cf-warning-text");
  });

  it("opens the list in the daemon's order with the count, and Clear all runs notification.clear", async () => {
    show(note("n-u", { timeSensitive: true }), note("n-b"), note("n-a"));
    render(<NotificationBell />);
    const pop = await openBell();
    expect(useNotificationsStore.getState().open).toBe(true);
    expect(within(pop).getByTestId("notification-popover-count").textContent).toBe("3");
    expect(cards().map((c) => c.dataset.notificationId)).toEqual(["n-u", "n-b", "n-a"]);
    expect(cardOf("n-u").dataset.timeSensitive).toBe("true");
    expect(cardOf("n-u").className).toContain("bg-cf-warning-surface");
    expect(cardOf("n-b").dataset.timeSensitive).toBeUndefined();
    fireEvent.click(within(pop).getByTestId("notification-clear"));
    expect(runCommandForResult).toHaveBeenCalledWith("notification.clear", {}, { inView: true });
  });

  it("says so when there are none, with no Clear all", async () => {
    show();
    render(<NotificationBell />);
    const pop = await openBell();
    expect(within(pop).getByTestId("notification-empty").textContent).toBe("No notifications.");
    expect(within(pop).queryByTestId("notification-clear")).toBeNull();
  });
});

describe("a card", () => {
  it("heads with the level's icon and the source's display name in the level's tone, then the title and body", async () => {
    show(note("n-1", { level: "error", source: "hello", title: "Stage failed", body: "3 of 212 tests failed" }), note("n-2", { source: "command" }), note("n-3", { source: "gone-plugin" }));
    render(<NotificationBell />);
    await openBell();
    const c = cardOf("n-1");
    expect(c.dataset.level).toBe("error");
    expect(within(c).getByTestId("notification-source").textContent).toBe("Hello");
    expect(within(c).getByTestId("notification-source").parentElement?.className).toContain("text-cf-error-text");
    expect(within(c).getByLabelText("Error")).toBeTruthy();
    expect(within(c).getByTestId("notification-title").textContent).toBe("Stage failed");
    expect(within(c).getByTestId("notification-body").textContent).toBe("3 of 212 tests failed");
    expect(within(cardOf("n-2")).getByTestId("notification-source").textContent).toBe("Code Foundry");
    expect(within(cardOf("n-3")).getByTestId("notification-source").textContent).toBe("gone-plugin");
    expect(within(cardOf("n-2")).queryByTestId("notification-body")).toBeNull();
  });

  it("shows its age since it arrived", async () => {
    show(note("n-1", { arrivedAtMs: Date.now() - 4 * 60_000 }));
    render(<NotificationBell />);
    await openBell();
    expect(within(cardOf("n-1")).getByTestId("notification-age").textContent).toBe("4m");
  });

  it("Dismiss runs notification.dismiss with its id; Snooze and Dismiss are named by tooltips", async () => {
    show(note("n-1"));
    render(<NotificationBell />);
    await openBell();
    const c = cardOf("n-1");
    expect(tooltipText(within(c).getByTestId("notification-dismiss"))).toBe("Dismiss");
    expect(tooltipText(within(c).getByTestId("notification-snooze"))).toBe("Snooze");
    fireEvent.click(within(c).getByTestId("notification-dismiss"));
    expect(runCommandForResult).toHaveBeenCalledWith("notification.dismiss", { id: "n-1" }, { inView: true });
  });

  it("Snooze offers the thread snooze's four presets and runs notification.snooze until the picked time", async () => {
    show(note("n-1"));
    render(<NotificationBell />);
    await openBell();
    fireEvent.pointerDown(within(cardOf("n-1")).getByTestId("notification-snooze"), { button: 0, ctrlKey: false });
    const presets = await screen.findAllByTestId("notification-snooze-preset");
    expect(presets.map((p) => p.dataset.preset)).toEqual(["1h", "3h", "tomorrow", "next-week"]);
    const before = Date.now();
    fireEvent.click(presets[0] as HTMLElement);
    await settle();
    const [name, args, opts] = (runCommandForResult.mock.calls[0] ?? []) as [string?, { id: string; until: string }?, unknown?];
    expect([name, args?.id, opts]).toEqual(["notification.snooze", "n-1", { inView: true }]);
    const until = Date.parse(args?.until ?? "");
    expect(until - before).toBeGreaterThan(3_590_000);
    expect(until - before).toBeLessThan(3_610_000);
  });

  it("draws the plugin's buttons in order, the first the primary, each running notification.act with its number", async () => {
    show(note("n-1", { actions: [{ label: "Continue", kind: "command", resolves: true, url: "" }, { label: "Abort", kind: "command", resolves: true, url: "" }, { label: "Open build", kind: "open", resolves: false, url: "https://x" }] }));
    render(<NotificationBell />);
    await openBell();
    const buttons = within(cardOf("n-1")).getAllByTestId("notification-action");
    expect(buttons.map((b) => b.textContent)).toEqual(["Continue", "Abort", "Open build"]);
    expect(buttons.map((b) => b.dataset.primary)).toEqual(["true", undefined, undefined]);
    fireEvent.click(buttons[2] as HTMLElement);
    expect(runCommandForResult).toHaveBeenCalledWith("notification.act", { id: "n-1", action: "3" }, expect.objectContaining({ quiet: true }));
  });

  it("a card without actions has no button row", async () => {
    show(note("n-1"));
    render(<NotificationBell />);
    await openBell();
    expect(within(cardOf("n-1")).queryByTestId("notification-actions")).toBeNull();
  });

  it("a failed action toasts at level error with the button's name and the reason", async () => {
    runCommandForResult.mockImplementationOnce((...args: unknown[]) => {
      (args[2] as { onError: (m: string) => void }).onError("no such command");
      return Promise.resolve(null);
    });
    show(note("n-1", { actions: [{ label: "Continue", kind: "command", resolves: true, url: "" }] }));
    render(<NotificationBell />);
    await openBell();
    fireEvent.click(within(cardOf("n-1")).getByTestId("notification-action"));
    await settle();
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "Continue failed", description: "no such command" });
  });

  it("names its thread as a link to the thread's tab, and the bell shuts behind it", async () => {
    show(note("n-1", { threadId: "s-4" }), note("n-2", { threadId: "s-7" }), note("n-3", { threadId: "s-gone" }));
    render(<NotificationBell />);
    await openBell();
    // A thread the daemon removed has no link (its notifications are withdrawn with it).
    expect(within(cardOf("n-3")).queryByTestId("notification-thread")).toBeNull();
    const link = within(cardOf("n-1")).getByTestId("notification-thread");
    expect(link.textContent).toBe("Investigate flaky e2e");
    fireEvent.click(link);
    expect(selectThreadAndFlag).toHaveBeenCalledWith("s-4", { preview: false });
    expect(useNotificationsStore.getState().open).toBe(false);
  });

  it("an archived thread's link opens it as a preview, as the sidebar does", async () => {
    show(note("n-2", { threadId: "s-7" }));
    render(<NotificationBell />);
    await openBell();
    fireEvent.click(within(cardOf("n-2")).getByTestId("notification-thread"));
    expect(selectThreadAndFlag).toHaveBeenCalledWith("s-7", { preview: true });
  });
});
