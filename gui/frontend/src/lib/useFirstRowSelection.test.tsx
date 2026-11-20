// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { useFirstRowSelection } from "./useFirstRowSelection";

function start(keys: readonly string[]) {
  return renderHook(({ k }) => useFirstRowSelection(k), { initialProps: { k: keys } });
}

describe("useFirstRowSelection", () => {
  it("starts on the first row, and on nothing without rows", () => {
    expect(start(["a", "b"]).result.current[0]).toBe("a");
    expect(start([]).result.current[0]).toBe("");
  });

  it.each([
    { name: "a new first row takes over a row that stayed", picked: "b", next: ["z", "a", "b"], want: "z" },
    { name: "a row that left the list gives way to the first", picked: "b", next: ["a", "c"], want: "a" },
    { name: "the same first row keeps the picked row", picked: "b", next: ["a", "b", "c"], want: "b" },
    { name: "an empty list clears it", picked: "b", next: [], want: "" },
  ])("$name", ({ picked, next, want }) => {
    const { result, rerender } = start(["a", "b"]);
    act(() => {
      result.current[1](picked);
    });
    rerender({ k: next });
    expect(result.current[0]).toBe(want);
  });

  it("takes the first row of the list that arrives after an empty one", () => {
    const { result, rerender } = start([]);
    rerender({ k: ["a", "b"] });
    expect(result.current[0]).toBe("a");
  });

  it("a first row that comes back starts on it again, not on the row picked before", () => {
    const { result, rerender } = start(["a", "b"]);
    act(() => {
      result.current[1]("b");
    });
    rerender({ k: ["z", "b"] });
    rerender({ k: ["a", "b"] });
    expect(result.current[0]).toBe("a");
  });

  it("no commit shows the old list's row (the controlled value cmdk reads in a layout effect)", () => {
    const committed: string[] = [];
    function List({ keys }: { keys: readonly string[] }) {
      const [selected] = useFirstRowSelection(keys);
      useLayoutEffect(() => {
        committed.push(selected);
      });
      return null;
    }
    const { rerender } = render(<List keys={["a", "b"]} />);
    rerender(<List keys={["z", "a"]} />);
    rerender(<List keys={[]} />);
    expect(committed).toEqual(["a", "z", ""]);
  });
});
