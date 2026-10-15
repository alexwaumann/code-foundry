import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { tooltipText } from "@/test/tooltip";
import { Tip } from "./tooltip";

afterEach(cleanup);

/** Fakes the trigger's layout: jsdom has none, so nothing overflows unless told. */
function overflow(el: HTMLElement, cut: boolean) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: cut ? 180 : 100 });
}

describe("Tip", () => {
  it.each([
    ["a label opens on keyboard focus", "Close tab", "Close tab"],
    ["no label never opens", null, null],
    ["an empty label never opens", "", null],
  ])("%s", (_name, label, want) => {
    render(
      <Tip label={label}>
        <button type="button">x</button>
      </Tip>,
    );
    expect(tooltipText(screen.getByRole("button"))).toBe(want);
  });

  it("keeps line breaks and adds no title attribute", () => {
    render(
      <Tip label={"abc123\nAlex <alex@example.com>"} data-testid="tip">
        <button type="button">x</button>
      </Tip>,
    );
    const b = screen.getByRole("button");
    expect(tooltipText(b)).toBe("abc123\nAlex <alex@example.com>");
    expect(b.getAttribute("title")).toBeNull();
    expect(screen.getByTestId("tip").className).toContain("whitespace-pre-line");
  });

  it("focus handed back without a navigation key (a closing menu, a dialog's first button) does not open it", () => {
    render(
      <Tip label="More actions">
        <button type="button">x</button>
      </Tip>,
    );
    const b = screen.getByRole("button");
    fireEvent.keyDown(document, { key: "Enter" });
    act(() => {
      b.focus();
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("a press keeps it shut until the pointer leaves (a delayed open would cover the menu the press opened)", () => {
    render(
      <Tip label="More actions">
        <button type="button">x</button>
      </Tip>,
    );
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b);
    fireEvent.pointerUp(document);
    expect(tooltipText(b)).toBeNull();
    act(() => {
      b.blur();
    });
    fireEvent.pointerLeave(b);
    expect(tooltipText(b)).toBe("More actions");
  });

  it.each([
    ["cut short: opens", true, "a-very-long-name"],
    ["fits: stays closed (it would repeat the text)", false, null],
  ])("whenTruncated, %s", (_name, cut, want) => {
    render(
      <Tip label="a-very-long-name" whenTruncated>
        <button type="button" className="truncate">
          a-very-long-name
        </button>
      </Tip>,
    );
    const b = screen.getByRole("button");
    overflow(b, cut);
    expect(tooltipText(b)).toBe(want);
  });

  it("whenTruncated looks inside the trigger too (a truncated or sr-only child)", () => {
    render(
      <Tip label="main ← feat/long-branch" whenTruncated>
        <button type="button">
          <span data-testid="inner">feat/long-branch</span>
        </button>
      </Tip>,
    );
    overflow(screen.getByTestId("inner"), true);
    expect(tooltipText(screen.getByRole("button"))).toBe("main ← feat/long-branch");
  });
});
