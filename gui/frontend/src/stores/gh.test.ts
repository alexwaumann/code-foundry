import { afterEach, describe, expect, it } from "vitest";
import { applyGhEvent, pollFreshness, usePollStore } from "./gh";

describe("gh poll freshness", () => {
  afterEach(() => {
    usePollStore.setState({ fetchedAtMs: null, lastError: "", known: false, projectsFetchedAtMs: null, projectsLastError: "" });
  });

  it("uses the data's own time until a polled event arrives", () => {
    expect(pollFreshness(usePollStore.getState(), 1000, "x")).toEqual({ fetchedAtMs: 1000, lastError: "x" });
  });

  it("a later poll confirms unchanged data; its error wins", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "" });
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "rate limited", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "rate limited" });
    // A failed poll keeps the last success's time.
    applyGhEvent({ kind: "polled", fetchedAtMs: 2000, lastError: "rate limited", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 5000, "").fetchedAtMs).toBe(2000);
  });

  it("the polled event carries the project lists' fetch time and error too", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "", projectsFetchedAtMs: 4000, projectsLastError: "search timed out" });
    expect(usePollStore.getState()).toMatchObject({ fetchedAtMs: 5000, projectsFetchedAtMs: 4000, projectsLastError: "search timed out" });
  });

  it("a daemon that never polled successfully keeps the data's time", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: null, lastError: "offline", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 1000, lastError: "offline" });
  });
});
