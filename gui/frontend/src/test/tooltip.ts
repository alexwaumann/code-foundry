import { act, fireEvent, screen } from "@testing-library/react";

/**
 * Opens the Tip on `el` the way a keyboard user does (Tab, then focus: Tip opens at once
 * on focus reached by a navigation key) and returns its text, or null when none opened.
 * Radix renders the label twice (the visible bubble and a visually hidden role="tooltip"
 * copy for aria-describedby); this reads the latter.
 */
export function tooltipText(el: HTMLElement): string | null {
  fireEvent.keyDown(document, { key: "Tab" });
  act(() => {
    el.focus();
  });
  return screen.queryByRole("tooltip")?.textContent ?? null;
}
