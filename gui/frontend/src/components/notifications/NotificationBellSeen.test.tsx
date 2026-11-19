import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationView } from "@/api/notifications";
import { note, noteEvent } from "@/test/notificationFakes";
import { tooltipText } from "@/test/tooltip";

const runCommandForResult = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ message: string; resultJson: string } | null>>(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(), dismissNotice: vi.fn(), notifyProgress: vi.fn() }));

const { NotificationBell } = await import("./NotificationBell");
const { applyNotificationEvent, resetNotifications } = await import("@/stores/notifications");

/**
 * The bell's seen state (docs/notes/notification-seen.md): its four looks, and notification.seen
 * run on opening the list and for an arrival while it is open.
 */

function show(notes: NotificationView[], arrived: string[] = []): void {
  act(() => {
    applyNotificationEvent(noteEvent(notes, arrived));
  });
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const bell = () => screen.getByTestId("notification-bell");
const seenCalls = () => runCommandForResult.mock.calls.filter((c) => c[0] === "notification.seen");

beforeEach(() => {
  resetNotifications();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the bell's looks", () => {
  const many = (k: number, o: Partial<NotificationView> = {}) => Array.from({ length: k }, (_, i) => note(`n-${String(i)}`, o));
  it.each([
    { name: "nothing shown: the icon alone", notes: [] as NotificationView[], unseen: false, count: null, tone: null, button: "text-cf-text-secondary", label: "Notifications" },
    { name: "one unseen: the total in an accent corner badge", notes: [note("a", { seen: false }), note("b")], unseen: true, count: "2", tone: "accent", button: "text-cf-text", label: "2 notifications" },
    {
      name: "an unseen time-sensitive one: the warning badge",
      notes: [note("u", { seen: false, timeSensitive: true }), note("a")],
      unseen: true,
      count: "2",
      tone: "warning",
      button: "text-cf-text",
      label: "2 notifications",
    },
    {
      name: "a seen time-sensitive one and an unseen plain one: the accent badge",
      notes: [note("u", { timeSensitive: true }), note("a", { seen: false })],
      unseen: true,
      count: "2",
      tone: "accent",
      button: "text-cf-text",
      label: "2 notifications",
    },
    { name: "all seen: the number beside the bell, secondary", notes: [note("a"), note("b"), note("c")], unseen: false, count: "3", tone: null, button: "text-cf-text-secondary", label: "3 notifications" },
    { name: "all seen with a time-sensitive one: the number in the warning text", notes: [note("u", { timeSensitive: true }), note("a")], unseen: false, count: "2", tone: null, button: "text-cf-warning-text", label: "2 notifications" },
    { name: "two digits in the badge", notes: [note("x", { seen: false }), ...many(11)], unseen: true, count: "12", tone: "accent", button: "text-cf-text", label: "12 notifications" },
    { name: "three digits in the badge", notes: [note("x", { seen: false }), ...many(99)], unseen: true, count: "100", tone: "accent", button: "text-cf-text", label: "100 notifications" },
    { name: "an unseen snoozed one lights nothing", notes: [note("a"), note("s", { seen: false, status: "snoozed" })], unseen: false, count: "1", tone: null, button: "text-cf-text-secondary", label: "1 notification" },
  ])("$name", ({ notes, unseen, count, tone, button, label }) => {
    show(notes);
    render(<NotificationBell />);
    const b = bell();
    expect(b.dataset.unseen).toBe(unseen ? "true" : undefined);
    expect(b.className).toContain(button);
    expect(b.getAttribute("aria-label")).toBe(label);
    expect(tooltipText(b)).toBe(label);
    const c = screen.queryByTestId("notification-bell-count");
    expect(c?.textContent ?? null).toBe(count);
    expect(c?.dataset.tone ?? null).toBe(tone);
    if (tone) {
      expect(c?.className).toContain(tone === "warning" ? "bg-cf-warning" : "bg-cf-accent");
      expect(c?.className).toContain("ring-cf-chrome");
    }
  });

  it("a daemon that does not keep seen (no unseen count) never lights the badge", () => {
    const ev = noteEvent([note("a", { seen: false })]);
    act(() => {
      applyNotificationEvent({ ...ev, snapshot: { ...ev.snapshot, unseen: 0 } });
    });
    render(<NotificationBell />);
    expect(bell().dataset.unseen).toBeUndefined();
    expect(screen.getByTestId("notification-bell-count").textContent).toBe("1");
  });
});

describe("seeing them", () => {
  it("opening the list runs notification.seen for every shown one, quietly", async () => {
    show([note("a", { seen: false }), note("b")]);
    render(<NotificationBell />);
    expect(seenCalls()).toHaveLength(0);
    fireEvent.click(bell());
    await screen.findByTestId("notification-popover");
    await settle();
    expect(seenCalls()).toEqual([["notification.seen", {}, expect.objectContaining({ quiet: true })]]);
  });

  it("opening with nothing unseen runs nothing", async () => {
    show([note("a")]);
    render(<NotificationBell />);
    fireEvent.click(bell());
    await screen.findByTestId("notification-popover");
    await settle();
    expect(seenCalls()).toHaveLength(0);
  });

  it("an arrival while the list is open is seen at once; one while it is shut is not", async () => {
    show([note("a", { seen: false })]);
    render(<NotificationBell />);
    fireEvent.click(bell());
    await screen.findByTestId("notification-popover");
    await settle();
    // The daemon's answer: a seen.
    show([note("a")]);
    await settle();
    expect(seenCalls()).toHaveLength(1);
    show([note("b", { seen: false }), note("a")], ["b"]);
    await settle();
    expect(seenCalls()).toHaveLength(2);
    // Two events in one render (the seen and a new arrival) still run it for the new one.
    act(() => {
      applyNotificationEvent(noteEvent([note("b"), note("a")]));
      applyNotificationEvent(noteEvent([note("c", { seen: false }), note("b"), note("a")], ["c"]));
    });
    await settle();
    expect(seenCalls()).toHaveLength(3);
    fireEvent.keyDown(screen.getByTestId("notification-popover"), { key: "Escape" });
    await settle();
    show([note("d", { seen: false }), note("c"), note("b"), note("a")], ["d"]);
    await settle();
    expect(seenCalls()).toHaveLength(3);
    expect(bell().dataset.unseen).toBe("true");
  });

  it("a failed seen does not run again until something new arrives", async () => {
    runCommandForResult.mockResolvedValue(null);
    show([note("a", { seen: false })]);
    render(<NotificationBell />);
    fireEvent.click(bell());
    await screen.findByTestId("notification-popover");
    await settle();
    await settle();
    expect(seenCalls()).toHaveLength(1);
  });
});
