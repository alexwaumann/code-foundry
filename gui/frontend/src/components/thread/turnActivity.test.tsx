import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTurnActivity, turnActivityHandlers } from "./turnActivity";

afterEach(cleanup);

/** Two turns' rows and a row of none, as the list marks them (data-turn), under the handlers. */
function list() {
  const a = createTurnActivity();
  render(
    <div role="log" {...turnActivityHandlers(a)}>
      <div data-turn="u1">
        <button type="button">fold u1</button>
      </div>
      <div data-turn="u2">
        <span>reply u2</span>
      </div>
      <div>
        <span>message</span>
      </div>
    </div>,
  );
  return a;
}

it("the pointer over a row makes its turn the hovered one; over a row of none, or out of the list, none", () => {
  const a = list();
  const seen = vi.fn();
  a.subscribe(seen);
  fireEvent.pointerOver(screen.getByText("reply u2"));
  expect(a.hovered()).toBe("u2");
  fireEvent.pointerOver(screen.getByText("reply u2"));
  // The same turn again tells nobody.
  expect(seen).toHaveBeenCalledTimes(1);
  fireEvent.pointerOver(screen.getByText("message"));
  expect(a.hovered()).toBe("");
  fireEvent.pointerOver(screen.getByText("fold u1"));
  expect(a.hovered()).toBe("u1");
  fireEvent.pointerLeave(screen.getByRole("log"));
  expect(a.hovered()).toBe("");
});

it("the keyboard focus on a turn's control makes it the focused one until it leaves; a click's focus does not", () => {
  const a = list();
  const button = screen.getByRole("button", { name: "fold u1" });
  const visible = vi.spyOn(button, "matches").mockImplementation((s) => s === ":focus-visible");
  fireEvent.focus(button);
  expect(a.focused()).toBe("u1");
  fireEvent.blur(button);
  expect(a.focused()).toBe("");
  visible.mockImplementation(() => false);
  fireEvent.focus(button);
  expect(a.focused()).toBe("");
});
