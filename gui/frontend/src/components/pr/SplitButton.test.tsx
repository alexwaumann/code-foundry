import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitButton } from "./SplitButton";

afterEach(cleanup);

/** Radix opens a dropdown on pointerdown (left button, no ctrl). */
function press(el: HTMLElement): void {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

function Split({ busy }: { busy: boolean }) {
  return (
    <SplitButton label="Merge" tone="success" reason={null} busy={busy} onRun={vi.fn()} menuLabel="Merge options" testId="split">
      {() => <span>menu body</span>}
    </SplitButton>
  );
}

describe("SplitButton", () => {
  it("a busy period it did not start shuts the open menu, and it stays shut once that settles", () => {
    const { rerender } = render(<Split busy={false} />);
    press(screen.getByTestId("split-menu-button"));
    expect(screen.queryByTestId("split-menu")).not.toBeNull();
    rerender(<Split busy />);
    expect(screen.queryByTestId("split-menu")).toBeNull();
    rerender(<Split busy={false} />);
    expect(screen.queryByTestId("split-menu")).toBeNull();
    expect(screen.getByTestId("split-menu-button").getAttribute("aria-expanded")).toBe("false");
  });
});
