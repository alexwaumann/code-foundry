import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "./sonner";
import { dismissNotice, notify } from "@/lib/notify";
import { dismissUndo, showUndo } from "@/stores/putAwayUndo";

// The put-away Undo toast on the app's real card (docs/notes/put-away-undo.md): the logic is
// stores/putAwayUndo.test.ts's; here what sonner draws of it.
const p = { kind: "archive" as const, ids: ["s-1"], untilMs: null, names: ["Fix the login bug"], focused: "", places: {} };

beforeEach(() => {
  vi.useFakeTimers();
  render(<Toaster position="bottom-right" offset={{ bottom: 20, right: 20, left: 20 }} />);
});

afterEach(() => {
  dismissUndo();
  dismissNotice();
  act(() => {
    vi.runAllTimers();
  });
  cleanup();
  vi.useRealTimers();
});

function list(el: HTMLElement): HTMLElement {
  const ol = el.closest<HTMLElement>("[data-sonner-toaster]");
  if (!ol) throw new Error("not in a toaster list");
  return ol;
}

describe("the undo toast", () => {
  it("shows bottom left, apart from the other toasts, with the chord inside Undo and a close button", () => {
    act(() => {
      notify({ level: "info", title: "Copied" });
      showUndo(p);
      vi.advanceTimersByTime(1); // sonner draws a new toast on its next tick
    });
    const undo = list(screen.getByText("Archived"));
    expect(undo.dataset.yPosition).toBe("bottom");
    expect(undo.dataset.xPosition).toBe("left");
    expect(undo.style.getPropertyValue("--offset-left")).toBe("20px");
    expect(list(screen.getByText("Copied")).dataset.xPosition).toBe("right");
    expect(screen.getByText("Fix the login bug").className).toContain("truncate");
    const button = screen.getByRole("button", { name: /^Undo/ });
    expect(button.querySelector("[data-chord]")?.textContent).toBe("⌘Z");
    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
  });

  it("closes after 5 seconds, and not while the pointer is over it", () => {
    act(() => {
      showUndo(p);
      vi.advanceTimersByTime(1);
    });
    const ol = list(screen.getByText("Archived"));
    act(() => {
      fireEvent.mouseEnter(ol);
    });
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByText("Archived")).not.toBeNull();
    act(() => {
      fireEvent.mouseLeave(ol);
    });
    act(() => {
      vi.advanceTimersByTime(5500);
    });
    expect(screen.queryByText("Archived")).toBeNull();
  });
});
