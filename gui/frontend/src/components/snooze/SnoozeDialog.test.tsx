import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@/api/session";

const snoozeSession = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/sessionActions", async (orig) => ({ ...(await orig<typeof import("@/stores/sessionActions")>()), snoozeSession }));

const { SnoozeDialog } = await import("./SnoozeDialog");
const { useSessionsStore } = await import("@/stores/sessions");
const { openSnoozeDialog, useSnoozeDialogStore } = await import("@/stores/snoozeDialog");

// Wed Oct 14 2026, 1:12 PM local.
const NOW = new Date(2026, 9, 14, 13, 12).getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask"] });
  useSessionsStore.setState({ byId: { "s-1": { id: "s-1", name: "Bump wails to v3.1" } as SessionView }, order: ["s-1"] });
  useSnoozeDialogStore.setState({ open: false, sessionId: "", seq: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function open(): void {
  render(<SnoozeDialog />);
  act(() => {
    openSnoozeDialog("s-1");
    vi.runAllTicks();
  });
}

const day = (iso: string) => document.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`);

describe("SnoozeDialog", () => {
  it("titles the thread, shows this month with tomorrow selected, today outlined, past days disabled, 9:00 AM", () => {
    open();
    expect(screen.getByRole("heading", { name: "Snooze “Bump wails to v3.1”" })).toBeTruthy();
    expect(screen.getByTestId("snooze-month").textContent).toBe("October 2026");
    expect(day("2026-10-15")?.getAttribute("aria-selected")).toBe("true");
    expect(day("2026-10-14")?.dataset.today).toBe("true");
    expect(day("2026-10-14")?.disabled).toBe(false);
    expect(day("2026-10-13")?.disabled).toBe(true);
    expect(day("2026-09-27")?.disabled).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>("snooze-time").value).toBe("09:00");
    expect(screen.getByTestId("snooze-summary").textContent).toBe("Thu, Oct 15");
    expect(screen.getByTestId<HTMLButtonElement>("snooze-prev-month").disabled).toBe(true);
  });

  it("snoozes until the picked day and time (local), and closes", () => {
    open();
    fireEvent.click(day("2026-10-16") as HTMLButtonElement);
    fireEvent.change(screen.getByTestId("snooze-time"), { target: { value: "14:30" } });
    expect(screen.getByTestId("snooze-summary").textContent).toBe("Fri, Oct 16");
    fireEvent.click(screen.getByTestId("snooze-submit"));
    expect(snoozeSession).toHaveBeenCalledWith("s-1", new Date(2026, 9, 16, 14, 30).getTime());
    expect(useSnoozeDialogStore.getState().open).toBe(false);
  });

  it("a time already past today disables Snooze; a later one today enables it", () => {
    open();
    fireEvent.click(day("2026-10-14") as HTMLButtonElement);
    const submit = screen.getByTestId<HTMLButtonElement>("snooze-submit");
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId("snooze-summary").textContent).toBe("In the past");
    fireEvent.change(screen.getByTestId("snooze-time"), { target: { value: "17:00" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByTestId("snooze-time"), { target: { value: "" } });
    expect(submit.disabled).toBe(true);
  });

  it("steps months; a day of the next month shows that month", () => {
    open();
    fireEvent.click(screen.getByTestId("snooze-next-month"));
    expect(screen.getByTestId("snooze-month").textContent).toBe("November 2026");
    expect(screen.getByTestId<HTMLButtonElement>("snooze-prev-month").disabled).toBe(false);
    fireEvent.click(day("2026-12-03") as HTMLButtonElement); // a trailing day of November's last week
    expect(screen.getByTestId("snooze-month").textContent).toBe("December 2026");
    expect(screen.getByTestId("snooze-summary").textContent).toBe("Thu, Dec 3");
    fireEvent.click(screen.getByTestId("snooze-prev-month"));
    fireEvent.click(screen.getByTestId("snooze-prev-month"));
    expect(screen.getByTestId("snooze-month").textContent).toBe("October 2026");
  });

  it("Cancel closes without snoozing", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useSnoozeDialogStore.getState().open).toBe(false);
    expect(snoozeSession).not.toHaveBeenCalled();
  });
});
