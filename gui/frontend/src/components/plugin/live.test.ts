import { describe, expect, it } from "vitest";
import { drop, INLINE_LIVE_MAX, take, want, type InlineLiveState } from "./live";

const empty: InlineLiveState = { holders: [], waiting: [] };

function run(...steps: ((s: InlineLiveState) => InlineLiveState)[]): InlineLiveState {
  return steps.reduce((s, f) => f(s), empty);
}

describe("inline live budget", () => {
  it("is two", () => {
    expect(INLINE_LIVE_MAX).toBe(2);
  });

  it("grants the first two and makes the third wait", () => {
    const s = run(
      (x) => want(x, "a"),
      (x) => want(x, "b"),
      (x) => want(x, "c"),
    );
    expect(s).toEqual({ holders: ["a", "b"], waiting: ["c"] });
  });

  it("asking twice changes nothing", () => {
    const s = run(
      (x) => want(x, "a"),
      (x) => want(x, "b"),
      (x) => want(x, "c"),
    );
    expect(want(s, "a")).toBe(s);
    expect(want(s, "c")).toBe(s);
  });

  it("hands a freed slot to the first waiting node", () => {
    const s = run(
      (x) => want(x, "a"),
      (x) => want(x, "b"),
      (x) => want(x, "c"),
      (x) => want(x, "d"),
      (x) => drop(x, "a"),
    );
    expect(s).toEqual({ holders: ["b", "c"], waiting: ["d"] });
  });

  it("dropping a waiting node only takes it out of the queue", () => {
    const s = run(
      (x) => want(x, "a"),
      (x) => want(x, "b"),
      (x) => want(x, "c"),
      (x) => drop(x, "c"),
    );
    expect(s).toEqual({ holders: ["a", "b"], waiting: [] });
    expect(drop(s, "zzz")).toBe(s);
  });

  it("Attach takes the oldest holder's slot; the oldest waits and gets it back when the taker lets go", () => {
    let s = run(
      (x) => want(x, "a"),
      (x) => want(x, "b"),
      (x) => want(x, "c"),
      (x) => take(x, "c"),
    );
    expect(s).toEqual({ holders: ["b", "c"], waiting: ["a"] });
    // Attaching again evicts the next oldest, never the one that just attached.
    s = take(s, "a");
    expect(s).toEqual({ holders: ["c", "a"], waiting: ["b"] });
    s = drop(s, "c");
    expect(s).toEqual({ holders: ["a", "b"], waiting: [] });
  });

  it("Attach with room left just grants", () => {
    expect(take(want(empty, "a"), "b")).toEqual({ holders: ["a", "b"], waiting: [] });
    const s = want(empty, "a");
    expect(take(s, "a")).toBe(s);
  });
});
