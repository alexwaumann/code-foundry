import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { sentTime } from "@/lib/format";
import type { TimelineRow, WorkersRow } from "@/lib/threadTimeline";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";
import { cardTitle } from "@/lib/workerRuns";

const { openThread } = vi.hoisted(() => ({ openThread: vi.fn() }));
vi.mock("@/stores/openThread", () => ({ openThread }));

const NOW = new Date("2026-11-19T15:00:00Z").getTime();
const M = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = (id: string, name: string) => ({ id, name }) as ThreadView;
  useThreadsStore.setState({ byId: { W1: t("W1", "PR row project name"), W2: t("W2", "Resize across collapsed panes"), W3: t("W3", "Code block header"), W4: t("W4", "Docs") } });
});

afterEach(() => {
  cleanup();
  openThread.mockClear();
  vi.useRealTimers();
  useThreadStore.setState({ folds: {} });
});

function show(row: TimelineRow) {
  return render(
    <ThreadContext.Provider value={{ threadId: "L", cwd: "/w" }}>
      <TimelineRowView row={row} />
    </ThreadContext.Provider>,
  ).container;
}

const live: WorkersRow = {
  type: "workers",
  key: "w:u1",
  live: true,
  folded: false,
  start: NOW - 26 * M,
  end: null,
  lines: [
    { id: "W1", state: "finished", since: NOW - 25 * M, until: NOW - 17 * M },
    { id: "W2", state: "failed", since: NOW - 25 * M, until: NOW - 11 * M },
    { id: "W3", state: "working", since: NOW - 3 * M, until: null },
    { id: "W4", state: "needs", since: NOW - 20 * M, until: null },
    { id: "W9", state: "finished", since: NOW - 9 * M, until: NOW - 6 * M },
  ],
};

/** Each line: name, the state's word, its time, and its mark (the working circle or the dot's tone). */
function lines(c: HTMLElement) {
  return [...c.querySelectorAll<HTMLElement>('[data-testid="thread-worker"]')].map((l) => {
    const mark = l.querySelector("[data-status-circle]") ? "circle" : (l.querySelector(".dot")?.className.match(/bg-cf-[a-z-]+/)?.[0] ?? "");
    const word = l.querySelector('[data-testid="thread-worker-state"]');
    const toned = /text-cf-(warning|error)-text/.exec(word?.className ?? "")?.[1] ?? "";
    return [l.querySelector(".tx")?.textContent, word?.textContent, toned, l.querySelector(".tm")?.textContent, mark, l.tagName].join(" | ");
  });
}

describe("the worker card", () => {
  it("live: its title and elapsed time, then a line per worker with its state, how long it worked and its mark", () => {
    const c = show(live);
    expect(c.querySelector(".ttl")?.textContent).toBe("Working with 5 threads");
    expect(c.querySelector('[data-testid="thread-workers-time"]')?.textContent).toBe("26m");
    // The live card has no fold.
    expect(c.querySelector("button.wh")).toBeNull();
    expect(lines(c)).toEqual([
      "PR row project name | finished |  | 8m | bg-cf-success | BUTTON",
      "Resize across collapsed panes | failed | error | 14m | bg-cf-error | BUTTON",
      "Code block header | working |  | 3m | circle | BUTTON",
      "Docs | needs you | warning | 20m | bg-cf-warning | BUTTON",
      // Removed: not a link.
      "Removed thread | finished |  | 3m | bg-cf-success | DIV",
    ]);
  });

  it.each([
    ["any line live", true, ["working"], "Working with 1 thread"],
    ["none live", true, ["finished", "failed"], "Worked with 2 threads"],
    ["frozen with one working", false, ["working"], "Worked with 1 thread"],
  ] as const)("title: %s", (_n, isLive, states, want) => {
    expect(cardTitle({ live: isLive, lines: states.map((state, i) => ({ id: String(i), state, since: null, until: null })) })).toBe(want);
  });

  it("live with nothing running: the time from its start to its last worker's stop", () => {
    const c = show({ ...live, end: NOW - 6 * M, lines: [{ id: "W1", state: "finished", since: NOW - 25 * M, until: NOW - 6 * M }] });
    expect(c.querySelector(".ttl")?.textContent).toBe("Worked with 1 thread");
    expect(c.querySelector('[data-testid="thread-workers-time"]')?.textContent).toBe("20m");
  });

  it("frozen: its title line only, stamped with the time it froze; a click opens it (the thread's fold choice), and again folds it", () => {
    const row: WorkersRow = { ...live, live: false, folded: true, end: NOW - 5 * M };
    const c = show(row);
    const head = c.querySelector<HTMLButtonElement>("button.wh");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".ttl")?.textContent).toBe("Worked with 5 threads");
    expect(c.querySelector('[data-testid="thread-workers-time"]')?.textContent).toBe(sentTime(NOW - 5 * M));
    expect(lines(c)).toEqual([]);
    act(() => {
      if (head) fireEvent.click(head);
    });
    expect(useThreadStore.getState().folds.L?.["w:u1"]).toBe(false);
    cleanup();
    // Open (as the rows give it once folded is false): the lines, as they were.
    const open = show({ ...row, folded: false });
    expect(lines(open)).toHaveLength(5);
    act(() => {
      const b = open.querySelector<HTMLButtonElement>("button.wh");
      if (b) fireEvent.click(b);
    });
    expect(useThreadStore.getState().folds.L?.["w:u1"]).toBe(true);
  });

  it("a line opens its worker's thread, as from its lead", () => {
    const c = show(live);
    const line = c.querySelector<HTMLButtonElement>('[data-testid="thread-worker"][data-thread="W3"]');
    act(() => {
      if (line) fireEvent.click(line);
    });
    expect(openThread).toHaveBeenCalledWith("W3", { from: "L" });
  });
});

describe("a run turn's gutter", () => {
  const gutter = (fold: "folded" | "open" | "none", steps = 2): TimelineRow => ({ type: "gutter", key: "f:k1", id: "e1", turn: "k1", steps, reply: "", latest: true, fold });

  it("its steps count is the turn's fold toggle", () => {
    const c = show(gutter("folded"));
    const b = c.querySelector<HTMLButtonElement>('[data-testid="thread-gutter-steps"]');
    expect(b?.textContent).toBe("2 steps");
    expect(b?.getAttribute("aria-expanded")).toBe("false");
    // Not said twice.
    expect(c.querySelector(".info")?.textContent ?? "").not.toContain("steps");
    act(() => {
      if (b) fireEvent.click(b);
    });
    expect(useThreadStore.getState().folds.L?.k1).toBe(false);
    cleanup();
    const open = show(gutter("open"));
    act(() => {
      const x = open.querySelector<HTMLButtonElement>('[data-testid="thread-gutter-steps"]');
      if (x) fireEvent.click(x);
    });
    expect(useThreadStore.getState().folds.L?.k1).toBe(true);
  });

  it("with nothing to fold, no toggle", () => {
    expect(show(gutter("none", 0)).querySelector('[data-testid="thread-gutter-steps"]')).toBeNull();
  });
});
