import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note, noteEvent } from "@/test/notificationFakes";

const notify = vi.hoisted(() => vi.fn());
const dismissNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, dismissNotice, notifyProgress: vi.fn() }));
const runCommandForResult = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ message: string; resultJson: string } | null>>(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { applyNotificationEvent, resetNotifications, setBellOpen, useNotificationsStore } = await import("./notifications");
const { ARRIVAL_TOAST_MS, arrivalToastId, MORE_TOAST_ID, raiseArrivalToasts, resetArrivalToasts } = await import("./notificationToasts");
import type { Notice } from "@/lib/notify";
import type { NotificationEventView } from "@/api/notifications";

/** The notification source's handler, as stores/events.ts runs it. */
function deliver(ev: NotificationEventView, at = 0): void {
  applyNotificationEvent(ev);
  raiseArrivalToasts(ev, at);
}

const notices = () => notify.mock.calls.map((c) => c[0] as Notice);

beforeEach(() => {
  resetNotifications();
  resetArrivalToasts();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("arrival toasts", () => {
  it("a connect's snapshot sets the baseline and toasts nothing, a reconnect's too", () => {
    deliver(noteEvent([note("a"), note("b")]));
    deliver(noteEvent([note("a"), note("b"), note("c")]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("an arrival toasts with its level, title, body and buttons; a normal one times out, with the ×", () => {
    const n = note("a", { level: "warning", title: "Waiting to deploy", body: "Stage Promote", actions: [{ label: "Continue", kind: "command", resolves: true, url: "" }, { label: "Open build", kind: "open", resolves: false, url: "https://x" }] });
    deliver(noteEvent([n], ["a"]));
    const [t] = notices();
    expect(t).toMatchObject({ id: arrivalToastId("a"), level: "warning", title: "Waiting to deploy", description: "Stage Promote", sticky: false, closable: true, duration: ARRIVAL_TOAST_MS });
    expect(t?.buttons?.map((b) => b.label)).toEqual(["Continue", "Open build"]);
  });

  it("a time-sensitive arrival stays until closed; no body is no description", () => {
    deliver(noteEvent([note("a", { timeSensitive: true })], ["a"]));
    expect(notices()[0]).toMatchObject({ sticky: true, description: undefined, duration: undefined });
  });

  it("a button runs notification.act with its number", async () => {
    const n = note("n-1", { actions: [{ label: "Continue", kind: "command", resolves: true, url: "" }, { label: "Abort", kind: "command", resolves: true, url: "" }] });
    deliver(noteEvent([n], ["n-1"]));
    notices()[0]?.buttons?.[1]?.onClick();
    await Promise.resolve();
    expect(runCommandForResult).toHaveBeenCalledWith("notification.act", { id: "n-1", action: "2" }, expect.objectContaining({ quiet: true }));
  });

  it("a failed action toasts at level error with the button's name and the reason", async () => {
    runCommandForResult.mockImplementationOnce((...args: unknown[]) => {
      (args[2] as { onError: (m: string) => void }).onError("the plugin is not running");
      return Promise.resolve(null);
    });
    deliver(noteEvent([note("n-1", { actions: [{ label: "Continue", kind: "command", resolves: true, url: "" }] })], ["n-1"]));
    notices()[0]?.buttons?.[0]?.onClick();
    await vi.waitFor(() => {
      expect(notify).toHaveBeenLastCalledWith({ level: "error", title: "Continue failed", description: "the plugin is not running" });
    });
  });

  it("an update never toasts", () => {
    deliver(noteEvent([note("a")]));
    deliver(noteEvent([note("a", { title: "Changed" })], [], ["a"]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("nothing while the bell is open", () => {
    setBellOpen(true);
    deliver(noteEvent([note("a")], ["a"]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("past the cap: two toasts, then one 'N more' toast whose Open opens the bell", () => {
    deliver(noteEvent([note("a"), note("b"), note("c"), note("d")], ["a", "b", "c", "d"]));
    expect(notices().map((t) => t.id)).toEqual([arrivalToastId("a"), arrivalToastId("b"), MORE_TOAST_ID]);
    const more = notices()[2];
    expect(more?.title).toBe("2 more notifications");
    more?.action?.onClick();
    expect(useNotificationsStore.getState().open).toBe(true);
  });

  it("a toast goes when its notification leaves the bell", () => {
    deliver(noteEvent([note("a"), note("b")], ["a", "b"]));
    deliver(noteEvent([note("b")]));
    expect(dismissNotice).toHaveBeenCalledWith(arrivalToastId("a"));
    expect(dismissNotice).not.toHaveBeenCalledWith(arrivalToastId("b"));
  });
});

describe("the store", () => {
  it("keeps the snapshot and the event's time-sensitive arrivals, and counts events", () => {
    deliver(noteEvent([note("u", { timeSensitive: true }), note("n")], ["u", "n"]));
    const s = useNotificationsStore.getState();
    expect(s.seq).toBe(1);
    expect(s.timeSensitiveArrived).toEqual(["u"]);
    expect(s.snapshot?.timeSensitive).toBe(1);
  });
});
