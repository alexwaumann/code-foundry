import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineList } from "./Timeline";

afterEach(cleanup);

/** A scroller of 1000px over 3000px of rows, at `top`: jsdom lays nothing out. */
function place(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 1000, configurable: true });
  el.scrollTop = top;
}

it("ends at the bottom when two scrolls land before a render, the first away from it", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<TimelineList threadId="s-1" rows={[{ key: "a", type: "text" }]} bottomInset={0} renderRow={() => <div />} />);
  const list = screen.getByTestId("thread-timeline");
  // One batch, as the browser can deliver them: the second must not compare with the state
  // the first has replaced, or the Jump to bottom chip stays up at the bottom.
  act(() => {
    place(list, 1200);
    fireEvent.scroll(list);
    place(list, 2000);
    fireEvent.scroll(list);
  });
  expect(list.dataset.atBottom).toBe("true");
  vi.unstubAllGlobals();
});

it("a click on a row that did not move the list leaves the layout's next scroll to the layout: the list stays at its end", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<TimelineList threadId="s-1" rows={[{ key: "a", type: "text" }]} bottomInset={0} renderRow={() => <div />} />);
  const list = screen.getByTestId("thread-timeline");
  act(() => {
    place(list, 2000);
    fireEvent.scroll(list);
  });
  // Run in terminal on a row (jsdom virtualizes none: the rows' box): pressed and released, the list did not move.
  fireEvent.pointerDown(screen.getByRole("log"));
  fireEvent.pointerUp(window);
  // The pane narrows and the virtualizer keeps rows in place: a scroll away from the end nobody asked for.
  act(() => {
    place(list, 1500);
    fireEvent.scroll(list);
  });
  // Pinned, the list went back to its end.
  act(() => {
    fireEvent.scroll(list);
  });
  expect(list.dataset.atBottom).toBe("true");
  vi.unstubAllGlobals();
});

it("a press that moved the list (its scrollbar dragged) makes the next moment's scrolls the user's: the list leaves its end", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<TimelineList threadId="s-1" rows={[{ key: "a", type: "text" }]} bottomInset={0} renderRow={() => <div />} />);
  const list = screen.getByTestId("thread-timeline");
  act(() => {
    place(list, 2000);
    fireEvent.scroll(list);
  });
  fireEvent.pointerDown(list);
  act(() => {
    place(list, 1700);
    fireEvent.scroll(list);
  });
  fireEvent.pointerUp(window);
  act(() => {
    place(list, 1500);
    fireEvent.scroll(list);
    fireEvent.scroll(list);
  });
  expect(list.dataset.atBottom).toBeUndefined();
  vi.unstubAllGlobals();
});
