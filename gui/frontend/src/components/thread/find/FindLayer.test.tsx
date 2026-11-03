import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildTurns, foldingTurn } from "@/lib/threadTimeline";
import { registerTimeline } from "@/stores/cite";
import { getThreadItems, setTurnFolded, structOf, useThreadStore } from "@/stores/thread";
import { closeThreadFind, getThreadFindMatches, holdThreadPane, openThreadFind, setThreadFindCurrent, useThreadFindStore } from "@/stores/threadFind";
import { fixStalePrBadge, publishThread } from "@/test/threadWorld";
import { FindLayer } from "./FindLayer";

/**
 * The find layer's picking and putting back over the store (no list renders here: what
 * paints and scrolls is e2e, thread-find.spec.ts).
 */

const T = "s-1";
const session = () => useThreadFindStore.getState().byThread[T];
let unregister: () => void = () => undefined;

function Pane() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <FindLayer threadId={T} paneRef={ref} />
    </div>
  );
}

/** ThreadPane's WatchedThread: holds the thread in the pane; leaving it closes its find, then its fold choices go. */
function Watched() {
  useEffect(() => holdThreadPane(T), []);
  return null;
}

let items: ThreadItemView[] = [];
const idOf = (kind: ThreadItemView["kind"], n = 0) => items.filter((it) => it.kind === kind)[n]?.id ?? "";

beforeEach(() => {
  items = fixStalePrBadge("idle").items;
  unregister = registerTimeline(T, {
    scroller: document.createElement("div"),
    showRow: () => false,
    unpin: () => undefined,
    unfold: (itemId) => {
      const turn = foldingTurn(buildTurns(getThreadItems(T).map(structOf)), itemId);
      if (turn === "") return false;
      setTurnFolded(T, turn, false);
      return true;
    },
    // A row per item, the list scrolled to the top.
    rowKeys: () => getThreadItems(T).map((it) => it.id),
    rowStart: () => undefined,
    topRow: () => 0,
  });
});

afterEach(() => {
  cleanup();
  unregister();
  useThreadFindStore.setState({ byThread: {} });
  useThreadStore.setState({ logs: {}, folds: {}, expanded: {} });
});

describe("FindLayer picks the current match", () => {
  it("a hand-off before the thread's log loaded keeps its item until the log comes, then picks in it", () => {
    const w = fixStalePrBadge("idle");
    const later = w.items.filter((it) => it.kind === "text")[1]?.id ?? "";
    openThreadFind(T, "f", { itemId: later });
    render(<Pane />);
    expect(session()).toMatchObject({ current: null, aim: { kind: "item", itemId: later } });
    act(() => {
      publishThread(T, w);
    });
    expect(session()?.current).toEqual({ itemId: later, nth: 0 });
    expect(session()?.aim).toBeNull();
  });

  it("a new query starts at the first match at or below the list's top", () => {
    publishThread(T, fixStalePrBadge("idle"));
    openThreadFind(T, "head sha");
    render(<Pane />);
    const first = getThreadFindMatches(T)[0];
    expect(session()?.current).toEqual({ itemId: first?.itemId, nth: 0 });
  });

  it("a query with no match: no current match, and nothing waits", () => {
    publishThread(T, fixStalePrBadge("idle"));
    openThreadFind(T, "no such words anywhere");
    render(<Pane />);
    expect(session()).toMatchObject({ current: null, aim: null });
  });

  it("a current match its text lost (a streaming answer) moves to the nearest in the same item, without a reveal", () => {
    publishThread(T, fixStalePrBadge("idle"));
    openThreadFind(T, "f");
    render(<Pane />);
    const text = idOf("text");
    const inText = getThreadFindMatches(T).filter((m) => m.itemId === text);
    expect(inText.length).toBeGreaterThan(2);
    act(() => {
      setThreadFindCurrent(T, { itemId: text, nth: inText.length - 1 });
    });
    const seq = session()?.revealSeq;
    // The answer's text changes: one "f" fewer at its end.
    act(() => {
      const log = useThreadStore.getState().logs[T];
      const it = log?.byId[text];
      if (!log || it?.kind !== "text") return;
      const cut = it.text.lastIndexOf("f");
      const next = { ...it, text: it.text.slice(0, cut) + it.text.slice(cut + 1) };
      useThreadStore.setState((s) => ({ logs: { ...s.logs, [T]: { ...log, byId: { ...log.byId, [text]: next } } } }));
    });
    expect(session()?.current).toEqual({ itemId: text, nth: inText.length - 2 });
    expect(session()?.revealSeq).toBe(seq);
  });

  it("a current match whose item lost every match goes on to the next item's, not back to the top", () => {
    publishThread(T, fixStalePrBadge("idle"));
    openThreadFind(T, "f");
    render(<Pane />);
    const ms = getThreadFindMatches(T);
    const ids = [...new Set(ms.map((m) => m.itemId))];
    const mid = ids[2] ?? "";
    act(() => {
      setThreadFindCurrent(T, { itemId: mid, nth: 0 });
    });
    act(() => {
      const log = useThreadStore.getState().logs[T];
      const it = log?.byId[mid];
      if (!log || it?.kind !== "text") return;
      useThreadStore.setState((s) => ({ logs: { ...s.logs, [T]: { ...log, byId: { ...log.byId, [mid]: { ...it, text: "nothing here" } } } } }));
    });
    expect(session()?.current).toEqual({ itemId: ids[3], nth: 0 });
  });
});

describe("FindLayer opens and puts back", () => {
  it("leaving the thread (WatchedThread's cleanup, then the layer's) leaves no fold choice behind", () => {
    publishThread(T, fixStalePrBadge("idle"));
    const question = idOf("question");
    openThreadFind(T, "f", { itemId: question });
    const view = render(
      <>
        <Watched />
        <Pane />
      </>,
    );
    expect(session()?.current?.itemId).toBe(question);
    expect(useThreadStore.getState().expanded[T]).toEqual({ [question]: true });
    vi.useFakeTimers();
    try {
      view.unmount();
      // A tick later (StrictMode's replay of the cleanup is not a leave).
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(session()).toBeUndefined();
    expect(useThreadStore.getState().folds[T]).toBeUndefined();
    expect(useThreadStore.getState().expanded[T]).toBeUndefined();
  });

  it("a hand-off made before the thread mounts survives StrictMode's effect replay", async () => {
    publishThread(T, fixStalePrBadge("idle"));
    const question = idOf("question");
    openThreadFind(T, "f", { itemId: question });
    // As main.tsx renders the app: effects run, their cleanups run, and they run again.
    render(
      <>
        <Watched />
        <Pane />
      </>,
      { reactStrictMode: true },
    );
    // The replayed cleanup's deferred leave finds the thread held again and does nothing.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(session()?.query).toBe("f");
    expect(session()?.current?.itemId).toBe(question);
    expect(useThreadStore.getState().expanded[T]).toEqual({ [question]: true });
  });

  it("closing the bar puts back what the current match opened", () => {
    publishThread(T, fixStalePrBadge("idle"));
    const question = idOf("question");
    openThreadFind(T, "f", { itemId: question });
    render(<Pane />);
    expect(useThreadStore.getState().folds[T]).toEqual({ i1: false });
    act(() => {
      closeThreadFind(T);
    });
    expect(useThreadStore.getState().folds[T]).toEqual({});
    expect(useThreadStore.getState().expanded[T]).toEqual({});
  });
});
