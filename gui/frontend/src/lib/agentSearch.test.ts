import { describe, expect, it } from "vitest";
import type { AgentHitView, AgentStepView, SearchEntryView, SearchWatchEventView } from "@/api/search";
import { answerPieces, withoutRefs } from "./answerMarkdown";
import {
  ANSWER_ROW,
  answerPreview,
  defaultSelection,
  endedNote,
  findHitCount,
  footerModel,
  hasAnswerRow,
  moveHit,
  recentMeta,
  reduceSearch,
  resultsWord,
  RESTORE_MS,
  restoreSelection,
  resultRows,
  sessionToRestore,
  summaryLine,
  unseenCue,
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

  it("a restored dialog's cue: the newest unseen finished agent search other than the shown one, and how many more", () => {
    const list = [entry({ id: "q-run", unseen: true, status: "running" }), entry({ id: "q-find", mode: "find", unseen: true, status: "done" }), entry({ id: "q-new", unseen: true, status: "failed" }), entry({ id: "q-seen", status: "done" }), entry({ id: "q-old", unseen: true, status: "done" })];
    expect(unseenCue(list, null)).toMatchObject({ entry: { id: "q-new" }, more: 1 });
    expect(unseenCue(list, "q-new")).toMatchObject({ entry: { id: "q-old" }, more: 0 });
    expect(unseenCue(list.slice(0, 2), null)).toBeNull();
    expect(unseenCue(null, null)).toBeNull();
  });
});

describe("restoreSelection", () => {
  const hits = (opened: number[]) => [1, 2, 3, 4].map((n) => ({ n, opened: opened.includes(n) }));
  const withAnswer = (opened: number[]) => [{ n: ANSWER_ROW, opened: false }, ...hits(opened)];
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
    ["the Answer row first: nothing selected, it", withAnswer([]), null, null, ANSWER_ROW],
    ["the Answer row selected before: it", withAnswer([]), null, ANSWER_ROW, ANSWER_ROW],
    ["the Answer row selected after a hit was opened: it", withAnswer([1]), 1, ANSWER_ROW, ANSWER_ROW],
    ["the Answer row selected, the answer gone: the first unopened", hits([1]), null, ANSWER_ROW, 2],
    ["a hit selected, the Answer row there: the hit", withAnswer([]), null, 3, 3],
    ["the selected hit gone: the Answer row", withAnswer([]), null, 9, ANSWER_ROW],
    ["after an opened hit: the next unopened hit, not the Answer row", withAnswer([1]), 1, 1, 2],
    ["wrapping past the end: the first unopened hit, not the Answer row", withAnswer([2, 4]), 4, 4, 1],
    ["every hit opened, the last opened: the Answer row", withAnswer([1, 2, 3, 4]), 4, 4, ANSWER_ROW],
    ["the Answer row alone", [{ n: ANSWER_ROW, opened: false }], null, null, ANSWER_ROW],
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

  it("moveHit goes through the Answer row", () => {
    const rows = [{ n: ANSWER_ROW }, { n: 1 }, { n: 2 }];
    expect(moveHit(rows, ANSWER_ROW, 1)).toBe(1);
    expect(moveHit(rows, 1, -1)).toBe(ANSWER_ROW);
    expect(moveHit(rows, ANSWER_ROW, -1)).toBe(2);
    expect(moveHit(rows, 2, 1)).toBe(ANSWER_ROW);
    expect(moveHit([{ n: ANSWER_ROW }], ANSWER_ROW, 1)).toBe(ANSWER_ROW);
  });
});

describe("the Answer row", () => {
  it.each<[string, { status: "running" | "done" | "failed" | "stopped"; answer: string }, boolean]>([
    ["done with an answer", { status: "done", answer: "It did [1]." }, true],
    ["done without one", { status: "done", answer: "" }, false],
    ["only whitespace", { status: "done", answer: " \n " }, false],
    ["an answer while it still runs: hits behave as before", { status: "running", answer: "It did [1]." }, false],
    ["stopped with an answer", { status: "stopped", answer: "It did [1]." }, true],
    ["failed without one", { status: "failed", answer: "" }, false],
  ])("hasAnswerRow: %s", (_name, e, want) => {
    expect(hasAnswerRow(e)).toBe(want);
    expect(resultRows({ ...e, hits: [hit(1)] }).map((r) => r.n)).toEqual(want ? [ANSWER_ROW, 1] : [1]);
  });

  it.each<[string, number[], number | null, boolean, number | null]>([
    ["a run's end moves to the Answer row", [ANSWER_ROW, 1, 2], 1, false, ANSWER_ROW],
    ["unless the user picked a hit", [ANSWER_ROW, 1, 2], 2, true, 2],
    ["a picked hit that went: the first row", [ANSWER_ROW, 1], 7, true, ANSWER_ROW],
    ["while it runs: the same hit", [1, 2], 2, false, 2],
    ["while it runs: the first as it arrives", [1], null, false, 1],
    ["no rows", [], 1, false, null],
  ])("defaultSelection: %s", (_name, ns, cur, picked, want) => {
    expect(
      defaultSelection(
        ns.map((n) => ({ n })),
        cur,
        picked,
      ),
    ).toBe(want);
  });

  it.each([
    ["markdown stripped", "**Bold** and `code` and a [link](https://example.com).", "Bold and code and a link."],
    ["blocks on one line", "## Heading\n\n- one\n- two\n\nThen text.", "Heading one two Then text."],
    ["references out, with the space before them", "The spot [1]. Both [2][3] and [1, 4], done.", "The spot. Both and, done."],
    ["an image is nothing, raw HTML its text", "See ![x](https://example.com/a.png) and <b>this", "See and <b>this"],
    ["empty", "", ""],
  ])("answerPreview: %s", (_name, answer, want) => {
    expect(answerPreview(answer)).toBe(want);
  });

  it("withoutRefs leaves other brackets", () => {
    expect(withoutRefs("See [a] and [100] there [2].")).toBe("See [a] and [100] there.");
  });
});

describe("texts", () => {
  it.each([
    [{ status: "done", hits: [hit(1), hit(2)] }, "2 results"],
    [{ status: "done", hits: [hit(1)] }, "1 result"],
    [{ status: "done", hits: [] }, "no results"],
    [{ status: "failed", hits: [] }, "failed"],
    [{ status: "stopped", hits: [] }, "stopped"],
    [{ status: "stopped", hits: [hit(1)] }, "1 result"],
  ] as const)("resultsWord(%o) is %s", (e, want) => {
    expect(resultsWord({ status: e.status, hits: [...e.hits] })).toBe(want);
  });

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
    expect(endedNote({ status: "failed", error: "Claude refused --safe-mode", hits: [], answer: "" })).toBe("Agent search failed: Claude refused --safe-mode.");
    expect(endedNote({ status: "stopped", error: "", hits: [hit(1)], answer: "" })).toBe("Stopped. 1 result found before it stopped.");
    expect(endedNote({ status: "stopped", error: "", hits: [], answer: "" })).toBe("Stopped before it found anything.");
    expect(endedNote({ status: "done", error: "", hits: [], answer: "" })).toBe("No messages answer it.");
    expect(endedNote({ status: "done", error: "", hits: [hit(1)], answer: "" })).toBe("");
    // The answer says it itself; one that cites what it never reported is told apart.
    expect(endedNote({ status: "done", error: "", hits: [], answer: "None of your threads talk about it." })).toBe("");
    expect(endedNote({ status: "done", error: "", hits: [], answer: "It was decided [1]." })).toBe("It reported no messages to open.");
  });

  it("footerModel names the utility model at low effort", () => {
    expect(footerModel("claude-sonnet-5-5[1m]", () => "Sonnet 5.5")).toBe("Utility model · Sonnet 5.5 · low");
    expect(footerModel("", () => "x")).toBe("Utility model · low");
  });
});
