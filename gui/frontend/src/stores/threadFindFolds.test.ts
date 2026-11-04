import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTurns, foldingTurn } from "@/lib/threadTimeline";
import { registerTimeline } from "@/stores/cite";
import { forgetTurnView, getThreadItems, messageFoldKey, setRowExpanded, setTurnFolded, structOf, useThreadStore } from "@/stores/thread";
import { fixStalePrBadge, publishThread } from "@/test/threadWorld";
import { closeThreadFind, openThreadFind, openThreadFindItem, openThreadFindMessage, putBackThreadFind, useThreadFindStore } from "./threadFind";

const T = "s-1";
let unregister: () => void = () => undefined;

/** The thread timeline's unfold (Timeline unfoldTurnOf): the turn whose fold hides the item opens. */
function fakeTimeline() {
  unregister = registerTimeline(T, {
    scroller: document.createElement("div"),
    showRow: () => true,
    unpin: () => undefined,
    unfold: (itemId) => {
      const turn = foldingTurn(buildTurns(getThreadItems(T).map(structOf)), itemId);
      if (turn === "") return false;
      setTurnFolded(T, turn, false);
      return true;
    },
    rowKeys: () => [],
    rowStart: () => undefined,
    topRow: () => 0,
  });
}

const view = () => ({ folds: useThreadStore.getState().folds[T] ?? {}, expanded: useThreadStore.getState().expanded[T] ?? {} });
const opened = () => useThreadFindStore.getState().byThread[T]?.opened ?? null;
let question = "";
let text = "";

beforeEach(() => {
  const w = fixStalePrBadge("idle");
  publishThread(T, w);
  question = w.items.find((it) => it.kind === "question")?.id ?? "";
  text = w.items.find((it) => it.kind === "text")?.id ?? "";
  fakeTimeline();
  openThreadFind(T, "head sha");
});

afterEach(() => {
  unregister();
  useThreadFindStore.setState({ byThread: {} });
  useThreadStore.setState({ logs: {}, synced: {}, folds: {}, expanded: {} });
});

describe("a long message whose fold hides the current match", () => {
  const M = "m-1";
  const key = messageFoldKey(M);

  it("opens, and folds again when the match leaves its item or the bar closes", () => {
    openThreadFindItem(T, M);
    openThreadFindMessage(T, M);
    expect(view().expanded[key]).toBe(true);
    openThreadFindItem(T, text);
    expect(view().expanded[key]).toBeUndefined();
    openThreadFindItem(T, M);
    openThreadFindMessage(T, M);
    closeThreadFind(T);
    expect(view().expanded[key]).toBeUndefined();
  });

  it("stays open for the next match in it", () => {
    openThreadFindItem(T, M);
    openThreadFindMessage(T, M);
    openThreadFindItem(T, M);
    expect(view().expanded[key]).toBe(true);
  });

  it("a message the user opened stays open", () => {
    setRowExpanded(T, key, true);
    openThreadFindItem(T, M);
    openThreadFindMessage(T, M);
    closeThreadFind(T);
    expect(view().expanded[key]).toBe(true);
  });

  it("the user's own Show less, then the match's next step: their later choice is not undone by the put back", () => {
    openThreadFindItem(T, M);
    openThreadFindMessage(T, M);
    setRowExpanded(T, key, false);
    closeThreadFind(T);
    expect(view().expanded[key]).toBe(false);
  });

  it("nothing for a message that is no longer the current match's", () => {
    openThreadFindItem(T, text);
    openThreadFindMessage(T, M);
    expect(view().expanded[key]).toBeUndefined();
  });
});

describe("opening what hides a match, and putting it back", () => {
  it("a folded question: its turn unfolds and its row expands; put back, both are the defaults again", () => {
    openThreadFindItem(T, question);
    expect(view()).toEqual({ folds: { i1: false }, expanded: { [question]: true } });
    expect(opened()).toEqual({ itemId: question, folds: { i1: { before: undefined, set: false } }, expanded: { [question]: { before: undefined, set: true } } });
    putBackThreadFind(T);
    expect(view()).toEqual({ folds: {}, expanded: {} });
    expect(opened()).toBeNull();
  });

  it("a text needs nothing opened (a fold never hides Claude's text)", () => {
    openThreadFindItem(T, text);
    expect(opened()).toEqual({ itemId: text, folds: {}, expanded: {} });
    expect(view()).toEqual({ folds: {}, expanded: {} });
  });

  it("the user's own choices from before come back as they were", () => {
    setTurnFolded(T, "i1", false);
    setRowExpanded(T, "other", true);
    openThreadFindItem(T, question);
    expect(opened()?.folds).toEqual({});
    putBackThreadFind(T);
    expect(view()).toEqual({ folds: { i1: false }, expanded: { other: true } });
  });

  it("moving on to another item puts the last one back in the same step", () => {
    openThreadFindItem(T, question);
    openThreadFindItem(T, text);
    expect(view()).toEqual({ folds: {}, expanded: {} });
    expect(opened()).toEqual({ itemId: text, folds: {}, expanded: {} });
  });

  it("the same item again opens nothing more", () => {
    openThreadFindItem(T, question);
    const first = opened();
    openThreadFindItem(T, question);
    expect(opened()).toBe(first);
  });

  it("a user change to any choice the find opened for an item makes the whole item theirs, the turn's fold included", () => {
    openThreadFindItem(T, question);
    // Collapsed by hand and expanded again: the item is the user's now, even holding the find's value again.
    setRowExpanded(T, question, false);
    setRowExpanded(T, question, true);
    expect(opened()).toEqual({ itemId: question, folds: {}, expanded: {} });
    // Nothing of it goes back: the turn stays open, so the question does not vanish under a fold.
    openThreadFindItem(T, text);
    expect(view()).toEqual({ folds: { i1: false }, expanded: { [question]: true } });
  });

  it("a choice set to another value is not overwritten, and the item's other choices stay too", () => {
    openThreadFindItem(T, question);
    setTurnFolded(T, "i1", true);
    closeThreadFind(T);
    expect(view()).toEqual({ folds: { i1: true }, expanded: { [question]: true } });
  });

  it("the same item after a user change opens nothing again", () => {
    openThreadFindItem(T, question);
    setRowExpanded(T, question, false);
    openThreadFindItem(T, question);
    expect(view().expanded).toEqual({ [question]: false });
  });

  it("closing puts back at once, so leaving the thread (close, then forget its choices) leaves nothing behind", () => {
    openThreadFindItem(T, question);
    // WatchedThread's cleanup, in its order.
    closeThreadFind(T);
    forgetTurnView(T);
    expect(useThreadStore.getState().folds[T]).toBeUndefined();
    expect(useThreadStore.getState().expanded[T]).toBeUndefined();
    // The layer unmounting after it writes nothing again.
    putBackThreadFind(T);
    expect(useThreadStore.getState().folds[T]).toBeUndefined();
    expect(useThreadStore.getState().expanded[T]).toBeUndefined();
  });
});
