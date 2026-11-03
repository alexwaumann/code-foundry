import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixStalePrBadge, publishThread } from "@/test/threadWorld";
import { useSubagentViewStore } from "./subagentView";
import { useThreadStore } from "./thread";
import { closeThreadFind, getThreadFindMatches, openThreadFind, presentThreadFind, setThreadFindCurrent, setThreadFindQuery, stepThreadFind, useThreadFindStore } from "./threadFind";
import { useUiStore } from "./ui";

const T = "s-1";
const session = () => useThreadFindStore.getState().byThread[T];

beforeEach(() => {
  publishThread(T, fixStalePrBadge("idle"));
});

afterEach(() => {
  useThreadFindStore.setState({ byThread: {} });
  useThreadStore.setState({ logs: {} });
  useSubagentViewStore.setState({ viewing: null });
});

describe("the find session", () => {
  it("opens empty and focused; cmd+f again keeps the query and focuses again", () => {
    openThreadFind(T);
    expect(session()).toMatchObject({ query: "", current: null, focusSeq: 1, aim: { kind: "view" } });
    setThreadFindQuery(T, "head sha");
    setThreadFindCurrent(T, { itemId: "i14", nth: 0 });
    openThreadFind(T);
    expect(session()).toMatchObject({ query: "head sha", current: { itemId: "i14", nth: 0 }, focusSeq: 2, aim: null });
  });

  it("a hand-off opens on a query with an item's first match to become current", () => {
    openThreadFind(T, "fingerprint", { itemId: "i20" });
    expect(session()).toMatchObject({ query: "fingerprint", current: null, aim: { kind: "item", itemId: "i20" } });
  });

  it("an edited query searches on from the current match: its item and where it starts", () => {
    openThreadFind(T);
    setThreadFindQuery(T, "f");
    expect(session()?.aim).toEqual({ kind: "view" });
    const third = getThreadFindMatches(T).filter((m) => m.itemId === "i13")[2];
    expect(third?.start).toBeGreaterThan(0);
    setThreadFindCurrent(T, { itemId: "i13", nth: 2 });
    setThreadFindQuery(T, "fi");
    expect(session()).toMatchObject({ current: null, aim: { kind: "view", from: { itemId: "i13", start: third?.start } } });
    // Typed again before the layer picked one: still from there.
    setThreadFindQuery(T, "fin");
    expect(session()?.aim).toEqual({ kind: "view", from: { itemId: "i13", start: third?.start } });
  });

  it("a hand-off's item is where an edited query goes on from, before a match is picked", () => {
    openThreadFind(T, "fingerprint", { itemId: "i20" });
    setThreadFindQuery(T, "fingerprints");
    expect(session()?.aim).toEqual({ kind: "view", from: { itemId: "i20", start: 0 } });
  });

  it("the bar, the layer and a step share one count per log and query", () => {
    openThreadFind(T, "head sha");
    const a = getThreadFindMatches(T);
    expect(getThreadFindMatches(T)).toBe(a);
    publishThread(T, fixStalePrBadge("idle"));
    expect(getThreadFindMatches(T)).not.toBe(a);
    expect(getThreadFindMatches(T)).toEqual(a);
  });

  it("a pick that keeps a match in place does not bring it into view", () => {
    openThreadFind(T, "head sha");
    setThreadFindCurrent(T, { itemId: "i14", nth: 0 });
    const seq = session()?.revealSeq;
    setThreadFindCurrent(T, { itemId: "i14", nth: 1 }, { reveal: false });
    expect(session()?.revealSeq).toBe(seq);
  });

  it("steps through the matches from the items, wrapping, and bumps the reveal each time", () => {
    openThreadFind(T, "head sha");
    const ids = () => session()?.current;
    expect(stepThreadFind(T, 1)).toBe(true);
    const first = ids();
    stepThreadFind(T, 1);
    stepThreadFind(T, 1);
    stepThreadFind(T, 1);
    expect(ids()).toEqual(first);
    stepThreadFind(T, -1);
    expect(session()?.revealSeq).toBe(5);
  });

  it("a step with the bar closed opens it; with no match it does nothing", () => {
    expect(stepThreadFind(T, 1)).toBe(false);
    expect(session()).toBeDefined();
    setThreadFindQuery(T, "no such words");
    expect(stepThreadFind(T, 1)).toBe(false);
    expect(session()?.current).toBeNull();
  });

  it("closes and forgets the query", () => {
    openThreadFind(T, "x");
    closeThreadFind(T);
    expect(session()).toBeUndefined();
  });
});

describe("presentThreadFind", () => {
  it("acts on the thread in the content pane", () => {
    useUiStore.setState({ selection: { kind: "thread", id: T } });
    expect(presentThreadFind("open")).toBe(true);
    expect(session()).toBeDefined();
  });

  it("not on a page or a subagent run's view", () => {
    useUiStore.setState({ selection: { kind: "page", name: "projects" } as never });
    expect(presentThreadFind("open")).toBe(false);
    useUiStore.setState({ selection: { kind: "thread", id: T } });
    useSubagentViewStore.setState({ viewing: { threadId: T, runId: "r1" } });
    expect(presentThreadFind("next")).toBe(false);
    expect(session()).toBeUndefined();
  });
});
