import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNav } from "./nav";
import { NavProvider, NavRow } from "./NavRow";

/** Three rows of which `mounted` are on screen, as a virtualized list has them. */
function List() {
  const items = ["a", "b", "c"].map((key) => ({ key }));
  const [mounted, setMounted] = useState(["a", "b", "c"]);
  const nav = useNav(items);
  return (
    <NavProvider value={nav.ctx}>
      <div data-testid="list" tabIndex={0} onKeyDown={nav.onKeyDown}>
        {mounted.map((k) => (
          <NavRow key={k} navKey={k}>
            {k}
          </NavRow>
        ))}
      </div>
      {["a", "ab", "abc"].map((set) => (
        <button
          key={set}
          data-testid={`mount-${set}`}
          onClick={() => {
            setMounted(set.split(""));
          }}
        />
      ))}
    </NavProvider>
  );
}

const intoView = vi.fn<(this: Element) => void>();
const scrolled = () => intoView.mock.contexts.map((e) => e.getAttribute("data-nav-key"));
const press = (key: string) => {
  fireEvent.keyDown(screen.getByTestId("list"), { key });
};
const mount = (set: string) => {
  fireEvent.click(screen.getByTestId(`mount-${set}`));
};

describe("NavRow's scroll into view", () => {
  beforeEach(() => {
    intoView.mockClear();
    Element.prototype.scrollIntoView = intoView;
    render(<List />);
  });
  afterEach(cleanup);

  it("a moved cursor brings its row into view", () => {
    press("End");
    expect(scrolled()).toEqual(["c"]);
  });

  it("a move to a row not mounted yet waits for it: End on a virtualized list", () => {
    mount("a");
    press("End");
    expect(scrolled()).toEqual([]);
    mount("abc");
    expect(scrolled()).toEqual(["c"]);
  });

  it("a row that mounts already selected, with no move owed, leaves the list alone", () => {
    press("End");
    intoView.mockClear();
    mount("a");
    mount("abc");
    expect(scrolled()).toEqual([]);
  });

  it("the cursor going nowhere owes nothing", () => {
    press("End");
    press("End");
    intoView.mockClear();
    mount("a");
    press("End");
    mount("abc");
    expect(scrolled()).toEqual([]);
  });
});
