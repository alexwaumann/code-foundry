import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTurns, foldingTurn } from "@/lib/threadTimeline";
import { registerTimeline } from "@/stores/cite";
import { getThreadItems, setRowExpanded, setTurnFolded, structOf, useThreadStore } from "@/stores/thread";
import { fixStalePrBadge, publishThread } from "@/test/threadWorld";
import { openFor, putBack } from "./findDom";

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
let question = "";
let text = "";

beforeEach(() => {
  const w = fixStalePrBadge("idle");
  publishThread(T, w);
  question = w.items.find((it) => it.kind === "question")?.id ?? "";
  text = w.items.find((it) => it.kind === "text")?.id ?? "";
  fakeTimeline();
});

afterEach(() => {
  unregister();
  useThreadStore.setState({ logs: {}, folds: {}, expanded: {} });
});

describe("opening what hides a match, and putting it back", () => {
  it("a folded question: its turn unfolds and its row expands; put back, both are the defaults again", () => {
    const opened = openFor(T, question, "question", null);
    expect(view()).toEqual({ folds: { i1: false }, expanded: { [question]: true } });
    putBack(T, opened);
    expect(view()).toEqual({ folds: {}, expanded: {} });
  });

  it("a text needs nothing opened (a fold never hides Claude's text)", () => {
    const opened = openFor(T, text, "text", null);
    expect(opened).toEqual({ folds: {}, expanded: {} });
    expect(view()).toEqual({ folds: {}, expanded: {} });
  });

  it("the user's own choices come back as they were", () => {
    setTurnFolded(T, "i1", false);
    setRowExpanded(T, "other", true);
    const opened = openFor(T, question, "question", null);
    expect(opened).toEqual({ folds: {}, expanded: { [question]: undefined } });
    putBack(T, opened);
    expect(view()).toEqual({ folds: { i1: false }, expanded: { other: true } });
  });

  it("moving on to another item puts the last one back in the same step", () => {
    const first = openFor(T, question, "question", null);
    const next = openFor(T, text, "text", first);
    expect(view()).toEqual({ folds: {}, expanded: {} });
    expect(next).toEqual({ folds: {}, expanded: {} });
  });

  it("moving between two matches that need the same fold records the user's value once and leaves it open", () => {
    const first = openFor(T, question, "question", null);
    // Put back and opened again within one call (before React renders): the turn stays open.
    const again = openFor(T, question, "question", first);
    expect(view().folds).toEqual({ i1: false });
    expect(again.folds).toEqual({ i1: undefined });
    putBack(T, again);
    expect(view()).toEqual({ folds: {}, expanded: {} });
  });
});
