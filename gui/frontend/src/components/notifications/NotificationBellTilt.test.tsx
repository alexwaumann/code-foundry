import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note, noteEvent } from "@/test/notificationFakes";

vi.mock("@/lib/notify", () => ({ notify: vi.fn(), dismissNotice: vi.fn(), notifyProgress: vi.fn() }));

const { NotificationBell } = await import("./NotificationBell");
const { applyNotificationEvent, resetNotifications } = await import("@/stores/notifications");
const { noteNotificationArrivals, resetArrivals } = await import("@/stores/arrivals");

/** The bell's arrival tilt (docs/notes/arrival-tilt.md): only the glyph tilts, swinging from its top. */

function arrive(ev: ReturnType<typeof noteEvent>): void {
  act(() => {
    applyNotificationEvent(ev);
    noteNotificationArrivals(ev);
  });
}

beforeEach(() => {
  resetNotifications();
  resetArrivals();
});

afterEach(() => {
  cleanup();
});

describe("the bell's tilt", () => {
  it("does not tilt for what was there on connect", () => {
    arrive(noteEvent([note("n-1")]));
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-bell-icon").getAttribute("class")).not.toContain("animate-arrival-tilt");
  });

  it("an arrival tilts the glyph from its top; the count and the button stay still", () => {
    arrive(noteEvent([note("n-1")]));
    render(<NotificationBell />);
    arrive(noteEvent([note("n-2"), note("n-1")], ["n-2"]));
    const glyph = screen.getByTestId("notification-bell-icon");
    expect(glyph.getAttribute("class")).toContain("animate-arrival-tilt");
    expect(glyph.getAttribute("class")).toContain("origin-[50%_12%]");
    expect(screen.getByTestId("notification-bell-count").className).not.toContain("animate-");
    expect(screen.getByTestId("notification-bell").className).not.toContain("animate-");
  });
});
