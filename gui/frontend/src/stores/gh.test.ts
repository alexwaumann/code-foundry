import { afterEach, describe, expect, it } from "vitest";
import { applyGhEvent, pollFreshness, usePollStore } from "./gh";

describe("gh poll freshness", () => {
  afterEach(() => {
    usePollStore.setState({ fetchedAtMs: null, lastError: "", known: false });
  });

  it("uses the data's own time until a polled event arrives", () => {
    expect(pollFreshness(usePollStore.getState(), 1000, "x")).toEqual({ fetchedAtMs: 1000, lastError: "x" });
  });

  it("a later poll confirms unchanged data; its error wins", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "" });
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "rate limited" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "rate limited" });
    // A failed poll keeps the last success's time.
    applyGhEvent({ kind: "polled", fetchedAtMs: 2000, lastError: "rate limited" });
    expect(pollFreshness(usePollStore.getState(), 5000, "").fetchedAtMs).toBe(2000);
  });

  it("a daemon that never polled successfully keeps the data's time", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: null, lastError: "offline" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 1000, lastError: "offline" });
  });
});
