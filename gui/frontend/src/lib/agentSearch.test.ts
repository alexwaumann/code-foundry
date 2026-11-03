import { describe, expect, it } from "vitest";
import type { AgentHitView, AgentStepView, SearchEntryView, SearchWatchEventView } from "@/api/search";
import {
  answerPieces,
  endedNote,
  findHitCount,
  footerModel,
  moveHit,
  recentMeta,
  reduceSearch,
  RESTORE_MS,
  restoreSelection,
  sessionToRestore,
  summaryLine,
  unseenToRestore,
  type SearchSession,
} from "./agentSearch";

const step = (index: number, over: Partial<AgentStepView> = {}): AgentStepView => ({ index, kind: "search", done: false, failed: false, text: `Searching q${String(index)}…`, query: `q${String(index)}`, threadName: "", ...over });
const hit = (n: number, over: Partial<AgentHitView> = {}): AgentHitView => ({
  n,
  threadId: "s-a",
  threadName: "Poller",
  archived: false,
  itemId: `i-${String(n)}`,
  ordinal: n,
  speaker: "assistant",
  itemAtMs: null,
  quote: `quote ${String(n)}`,
  why: "why",
  opened: false,
  ...over,
});
function entry(over: Partial<SearchEntryView> = {}): SearchEntryView {
  return {
    id: "q-1",
    mode: "agent",
    query: "where?",
    createdAtMs: 0,
    finishedAtMs: null,
    status: "running",
    error: "",
    answer: "",
    hits: [],
    steps: [],
    searches: 0,
    threadsRead: 0,
    model: "claude-sonnet-5-5[1m]",
    costUsd: 0,
    durationMs: 0,
    unseen: false,
    version: 1,
    promotedThreadId: "",
    findHits: 0,
    ...over,
  };
}

describe("reduceSearch", () => {
  it("folds Watch's documented order: snapshot, steps (upserts), hits, answer, status", () => {
    const evs: SearchWatchEventView[] = [
      { kind: "snapshot", version: 1, entry: entry() },
      { kind: "step", version: 2, step: step(0) },
      { kind: "step", version: 3, step: step(1) },
      // Steps may complete out of order.
      { kind: "step", version: 4, step: step(1, { done: true, text: "Searched q1 · 2 hits" }) },
      { kind: "step", version: 5, step: step(0, { done: true, text: "Searched q0 · no hits" }) },
      { kind: "step", version: 6, step: step(2, { kind: "read", query: "", threadName: "Poller", text: "Reading Poller…" }) },
      { kind: "step", version: 7, step: step(2, { kind: "read", query: "", threadName: "Poller", done: true, text: "Read Poller · #1–#3" }) },
      { kind: "hit", version: 8, hit: hit(1) },
      { kind: "hit", version: 9, hit: hit(2) },
      { kind: "answer", version: 10, text: "It skips reruns [1][2]." },
      { kind: "status", version: 11, status: "done", error: "", finishedAtMs: 21_000, costUsd: 0.02, durationMs: 21_000, unseen: true },
    ];
    const e = evs.reduce<SearchEntryView | null>(reduceSearch, null);
    expect(e).toMatchObject({ version: 11, status: "done", answer: "It skips reruns [1][2].", searches: 2, threadsRead: 1, durationMs: 21_000, unseen: true });
    expect(e?.steps.map((s) => [s.index, s.done, s.text])).toEqual([
      [0, true, "Searched q0 · no hits"],
      [1, true, "Searched q1 · 2 hits"],
      [2, true, "Read Poller · #1–#3"],
    ]);
    expect(e?.hits.map((h) => h.n)).toEqual([1, 2]);
  });

  it("drops changes before the snapshot and changes it already has (an old version)", () => {
    expect(reduceSearch(null, { kind: "hit", version: 2, hit: hit(1) })).toBeNull();
    const e = entry({ version: 5, hits: [hit(1)] });
    expect(reduceSearch(e, { kind: "hit", version: 5, hit: hit(2) })).toBe(e);
    expect(reduceSearch(e, { kind: "answer", version: 3, text: "old" })).toBe(e);
  });

  it("a hit it has already is not added twice", () => {
    const e = reduceSearch(entry({ version: 2, hits: [hit(1)] }), { kind: "hit", version: 3, hit: hit(1) });
    expect(e?.hits).toHaveLength(1);
    expect(e?.version).toBe(3);
  });

  it("a resync snapshot replaces the entry (a dropped event, opened or seen); an older snapshot does not", () => {
    const shown = entry({ version: 6, hits: [hit(1)] });
    const resync = entry({ version: 9, hits: [hit(1, { opened: true }), hit(2)], unseen: false });
    expect(reduceSearch(shown, { kind: "snapshot", version: 9, entry: resync })).toBe(resync);
    expect(reduceSearch(resync, { kind: "snapshot", version: 4, entry: shown })).toBe(resync);
  });
});

describe("the restore rules", () => {
  const session = (closedAtMs: number): SearchSession => ({ mode: "agent", query: "q", entryId: "q-1", selectedN: 2, openedN: 1, scrollTop: 40, closedAtMs });
  it.each([
    ["just closed", 0, true],
    ["a moment before the limit", RESTORE_MS - 1, true],
    ["at the limit", RESTORE_MS, false],
    ["an hour later", 3_600_000, false],
    ["a clock that went back", -5_000, false],
  ])("%s", (_name, age, restores) => {
    const now = 10_000_000;
    expect(sessionToRestore(session(now - age), now) !== null).toBe(restores);
  });
  it("nothing kept restores nothing", () => {
    expect(sessionToRestore(null, 0)).toBeNull();
  });

  it("an unseen finished agent search restores whatever the timer: the newest; a running one or a Find entry does not", () => {
    const list = [entry({ id: "q-run", unseen: true, status: "running" }), entry({ id: "q-find", mode: "find", unseen: true, status: "done" }), entry({ id: "q-new", unseen: true, status: "failed" }), entry({ id: "q-old", unseen: true, status: "done" })];
    expect(unseenToRestore(list)?.id).toBe("q-new");
    expect(unseenToRestore([entry({ status: "done" })])).toBeNull();
  });
});

describe("restoreSelection", () => {
  const hits = (opened: number[]) => [1, 2, 3, 4].map((n) => ({ n, opened: opened.includes(n) }));
  it.each<[string, { n: number; opened: boolean }[], number | null, number | null, number | null]>([
    ["the next unopened after the one opened", hits([1]), 1, null, 2],
    ["skips opened ones after it", hits([2, 3]), 2, null, 4],
    ["wraps to the first unopened", hits([2, 4]), 4, null, 1],
    ["the one opened is still unopened in a stale entry: the next", hits([]), 2, null, 3],
    ["every hit opened: the one after", hits([1, 2, 3, 4]), 2, null, 3],
    ["every hit opened, the last opened: the first", hits([1, 2, 3, 4]), 4, null, 1],
    ["nothing opened: the one selected before", hits([]), null, 3, 3],
    ["nothing opened, the selected one gone: the first unopened", hits([1]), null, 9, 2],
    ["no hits", [], 1, 1, null],
  ])("%s", (_name, h, openedN, selectedN, want) => {
    expect(restoreSelection(h, openedN, selectedN)).toBe(want);
  });

  it("moveHit wraps both ways and starts at an end", () => {
    const h = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(moveHit(h, 3, 1)).toBe(1);
    expect(moveHit(h, 1, -1)).toBe(3);
    expect(moveHit(h, null, 1)).toBe(1);
    expect(moveHit(h, null, -1)).toBe(3);
    expect(moveHit([], 1, 1)).toBeNull();
  });
});

describe("texts", () => {
  it("answerPieces: [n], [1][2] and [1, 2] become references; the rest stays text, markdown and all", () => {
    expect(answerPieces("Kept **check-count** [1]. Again in [2][3], see [1, 4].")).toEqual([
      { kind: "text", text: "Kept **check-count** " },
      { kind: "ref", n: 1 },
      { kind: "text", text: ". Again in " },
      { kind: "ref", n: 2 },
      { kind: "ref", n: 3 },
      { kind: "text", text: ", see " },
      { kind: "ref", n: 1 },
      { kind: "ref", n: 4 },
      { kind: "text", text: "." },
    ]);
    expect(answerPieces("[link](http://x) [a]")).toEqual([{ kind: "text", text: "[link](http://x) [a]" }]);
  });

  it("summaryLine", () => {
    expect(summaryLine({ searches: 2, threadsRead: 3, durationMs: 21_400 })).toBe("2 searches · read 3 threads · 21s");
    expect(summaryLine({ searches: 1, threadsRead: 1, durationMs: 64_000 })).toBe("1 search · read 1 thread · 1m 4s");
    expect(summaryLine({ searches: 0, threadsRead: 0, durationMs: 0 })).toBe("0 searches · read 0 threads");
  });

  it("recentMeta: results for an agent search, hits for a Find entry, and the age", () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    const hour = now - 3_600_000;
    expect(recentMeta(entry({ status: "done", hits: [hit(1), hit(2), hit(3)], createdAtMs: hour }), now)).toBe("3 results · 1h");
    expect(recentMeta(entry({ status: "done", hits: [hit(1)], createdAtMs: hour }), now)).toBe("1 result · 1h");
    expect(recentMeta(entry({ status: "done", createdAtMs: hour }), now)).toBe("no results · 1h");
    expect(recentMeta(entry({ status: "failed", createdAtMs: hour }), now)).toBe("failed · 1h");
    expect(recentMeta(entry({ status: "running", createdAtMs: now }), now)).toBe("running · now");
    expect(recentMeta(entry({ mode: "find", status: "done", findHits: 14, createdAtMs: new Date(2026, 10, 2, 9).getTime() }), now)).toBe("14 hits · yesterday");
    // An entry recorded before the count was kept: the age alone.
    expect(recentMeta(entry({ mode: "find", status: "done", findHits: 0, createdAtMs: hour }), now)).toBe("1h");
  });

  it("findHitCount counts names and message hits", () => {
    expect(findHitCount({ threads: [1, 2], totalHits: 12 })).toBe(14);
    expect(findHitCount(null)).toBe(0);
  });

  it("endedNote says how a search that did not answer ended", () => {
    expect(endedNote({ status: "failed", error: "Claude refused --safe-mode", hits: [] })).toBe("Agent search failed: Claude refused --safe-mode.");
    expect(endedNote({ status: "stopped", error: "", hits: [hit(1)] })).toBe("Stopped. 1 result found before it stopped.");
    expect(endedNote({ status: "stopped", error: "", hits: [] })).toBe("Stopped before it found anything.");
    expect(endedNote({ status: "done", error: "", hits: [] })).toBe("No messages answer it.");
    expect(endedNote({ status: "done", error: "", hits: [hit(1)] })).toBe("");
  });

  it("footerModel names the utility model at low effort", () => {
    expect(footerModel("claude-sonnet-5-5[1m]", () => "Sonnet 5.5")).toBe("Utility model · Sonnet 5.5 · low");
    expect(footerModel("", () => "x")).toBe("Utility model · low");
  });
});
