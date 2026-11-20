// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { useListSelection } from "./useListSelection";

/** FindSearch's and TextFinder's rule over plain keys: the same row for the same answer while listed, else the first. */
function keep(rows: readonly string[]) {
  return (cur: string, same: boolean) => (same && rows.includes(cur) ? cur : (rows[0] ?? ""));
}

function start(answer: string, rows: readonly string[]) {
  return renderHook(({ a, r }) => useListSelection(a, keep(r), ""), { initialProps: { a: answer, r: rows } });
}

describe("useListSelection", () => {
  it("starts on the rule's row", () => {
    expect(start("q", ["a", "b"]).result.current[0]).toBe("a");
    expect(start("q", []).result.current[0]).toBe("");
  });

  it.each([
    { name: "the same answer keeps the pick", answer: "q", rows: ["a", "b", "c"], want: "b" },
    { name: "a new answer takes its first row", answer: "r", rows: ["a", "b"], want: "a" },
    { name: "a pick that left gives way to the first", answer: "q", rows: ["a", "c"], want: "a" },
  ])("$name", ({ answer, rows, want }) => {
    const { result, rerender } = start("q", ["a", "b"]);
    act(() => {
      result.current[1]("b");
    });
    rerender({ a: answer, r: rows });
    expect(result.current[0]).toBe(want);
  });

  it("an answer that comes back does not bring back the pick made for it", () => {
    const { result, rerender } = start("q", ["a", "b"]);
    act(() => {
      result.current[1]("b");
    });
    rerender({ a: "r", r: ["x", "y"] });
    rerender({ a: "q", r: ["a", "b"] });
    expect(result.current[0]).toBe("a");
  });

  it("a row given up for the first stays given up when it comes back", () => {
    const { result, rerender } = start("q", ["a", "b"]);
    act(() => {
      result.current[1]("b");
    });
    rerender({ a: "q", r: [] });
    rerender({ a: "q", r: ["a", "b"] });
    expect(result.current[0]).toBe("a");
  });

  it("no commit shows the old answer's row: the selection is worked out before the paint", () => {
    const committed: string[] = [];
    function List({ answer, rows }: { answer: string; rows: readonly string[] }) {
      const [selected] = useListSelection(answer, keep(rows), "");
      useLayoutEffect(() => {
        committed.push(selected);
      });
      return null;
    }
    const { rerender } = render(<List answer="q" rows={["a", "b"]} />);
    rerender(<List answer="r" rows={["x", "y"]} />);
    rerender(<List answer="r" rows={[]} />);
    expect(committed).toEqual(["a", "x", ""]);
  });
});
