// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Command, CommandInput, CommandItem, CommandList } from "./command";

const selected = () => document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-value");
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

function Rows() {
  return (
    <>
      <CommandItem value="one">one</CommandItem>
      <CommandItem value="two">two</CommandItem>
      <CommandItem value="three">three</CommandItem>
    </>
  );
}

function Controlled({ nested = false }: { nested?: boolean }) {
  const [query, setQuery] = useState("");
  return (
    <Command shouldFilter={false}>
      <CommandInput value={query} onValueChange={setQuery} data-testid="input" />
      <CommandList data-testid="list">
        {nested ? (
          <div data-testid="inner" data-command-scroll>
            <Rows />
          </div>
        ) : (
          <Rows />
        )}
      </CommandList>
    </Command>
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe("the pointer guard", () => {
  it("a row under a pointer at rest is not selected; a real move selects it", async () => {
    render(<Controlled />);
    await flush();
    const two = screen.getByText("two");
    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 300 });
    expect(selected()).toBe("one");

    fireEvent.pointerMove(two, { clientX: 300, clientY: 300 });
    await flush();
    expect(selected()).toBe("one");

    fireEvent.pointerMove(two, { clientX: 301, clientY: 300 });
    await flush();
    expect(selected()).toBe("two");
  });

  it("still calls the caller's capture handler", () => {
    const seen: number[] = [];
    render(
      <Command
        onPointerMoveCapture={(e) => {
          seen.push(e.clientX);
        }}
      >
        <CommandList>
          <Rows />
        </CommandList>
      </Command>,
    );
    fireEvent.pointerMove(screen.getByText("two"), { clientX: 400, clientY: 400 });
    fireEvent.pointerMove(screen.getByText("two"), { clientX: 400, clientY: 400 });
    expect(seen).toEqual([400, 400]);
  });
});

describe("a new search", () => {
  it.each([
    { name: "scrolls the list to the top", nested: false, scroller: "list" },
    { name: "scrolls a marked region inside the list to the top", nested: true, scroller: "inner" },
  ])("$name", async ({ nested, scroller }) => {
    render(<Controlled nested={nested} />);
    await flush();
    const el = screen.getByTestId(scroller);
    el.scrollTop = 500;
    fireEvent.change(screen.getByTestId("input"), { target: { value: "t" } });
    await flush();
    expect(el.scrollTop).toBe(0);
  });

  it("scrolls an uncontrolled input's list too", async () => {
    render(
      <Command>
        <CommandInput data-testid="input" />
        <CommandList data-testid="list">
          <Rows />
        </CommandList>
      </Command>,
    );
    await flush();
    const list = screen.getByTestId("list");
    list.scrollTop = 500;
    fireEvent.change(screen.getByTestId("input"), { target: { value: "t" } });
    await flush();
    expect(list.scrollTop).toBe(0);
  });

  it("leaves the scroll alone when only the selection moves", async () => {
    render(<Controlled />);
    await flush();
    const list = screen.getByTestId("list");
    list.scrollTop = 500;
    fireEvent.keyDown(screen.getByTestId("input"), { key: "ArrowDown" });
    await flush();
    expect(selected()).toBe("two");
    expect(list.scrollTop).toBe(500);
  });
});
