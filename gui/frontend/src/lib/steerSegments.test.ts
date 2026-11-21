import { describe, expect, it } from "vitest";
import { buildRows, buildTurns, decodeTimelineKey, foldingTurn, queuedLast, rowTurns, segments, timelineKey, type TimelineItem, type TimelineOptions, type TimelineRow } from "./threadTimeline";

// A turn split at the user's steers Claude read (docs/notes/steer-segments.md): a header per
// stretch, queued messages drawn last, ones Claude never read inside their turn.

let n = 0;
function item(kind: TimelineItem["kind"], over: Partial<TimelineItem> = {}): TimelineItem {
  n++;
  return { id: `${kind}-${String(n)}`, kind, name: "", parentToolUseId: "", toolUseId: "", toolStatus: "", requestState: "", streaming: false, ...over };
}
const bash = (id: string) => item("tool", { id, name: "Bash", toolUseId: `tu-${id}`, toolStatus: "done" });
const user = (id: string, over: Partial<TimelineItem> = {}) => item("user", { id, ...over });
const read = (id: string, readAt: number) => user(id, { delivery: "read", readAt });
const queued = (id: string) => user(id, { delivery: "queued" });
const unsent = (id: string) => user(id, { delivery: "unsent" });
const text = (id: string) => item("text", { id });
const end = (id: string) => item("turnEnd", { id });

const folded: TimelineOptions = { fold: () => undefined, working: false };
const expanded: TimelineOptions = { fold: () => false, working: false };
const live: TimelineOptions = { fold: () => undefined, working: true };

/** Rows compactly: a header as h(<index>[ live][ folded] <steps>[ from-to]), a steer with its delivery, gutters as gutter[ split]. */
function shape(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => {
    switch (r.type) {
      case "header": {
        const seg = r.seg ? `${String(r.seg.index)} ${String(r.seg.from ?? "start")}-${String(r.seg.to ?? "end")}` : "turn";
        return `h(${seg}${r.live ? " live" : ""}${r.folded ? " folded" : ""} ${String(r.steps)})`;
      }
      case "steer":
        return `steer:${r.id}${r.delivery ? `(${r.delivery})` : ""}`;
      case "text":
        return r.final ? `final:${r.id}` : `text:${r.id}`;
      case "tool":
        return `tool:${r.id}`;
      case "gutter":
        return `gutter${r.split ? " split" : ""}`;
      case "strip":
        return `strip(${String(r.steps)})`;
      default:
        return `${r.type}:${"id" in r ? r.id : r.key}`;
    }
  });
}

const rowsOf = (items: TimelineItem[], opts: TimelineOptions) => buildRows(buildTurns(items), opts);

describe("a turn split at the steers Claude read", () => {
  it.each<[string, TimelineItem[], TimelineOptions, string[]]>([
    [
      "finished, folded: a header per stretch, the steer between, the reply and one gutter",
      [user("u1"), bash("A"), text("mid"), read("s1", 1000), bash("B"), text("a"), end("e")],
      folded,
      ["user:u1", "h(0 start-1000 folded 1)", "steer:s1(read)", "h(1 1000-end folded 1)", "final:a", "gutter split"],
    ],
    [
      "finished, open: each stretch's work under its header, text before the steer is work",
      [user("u1"), bash("A"), text("mid"), read("s1", 1000), bash("B"), text("a"), end("e")],
      expanded,
      ["user:u1", "h(0 start-1000 1)", "tool:A", "text:mid", "steer:s1(read)", "h(1 1000-end 1)", "tool:B", "final:a", "gutter split"],
    ],
    [
      "two steers: three stretches",
      [user("u1"), bash("A"), read("s1", 1000), bash("B"), bash("C"), read("s2", 3000), bash("D"), text("a"), end("e")],
      folded,
      ["user:u1", "h(0 start-1000 folded 1)", "steer:s1(read)", "h(1 1000-3000 folded 2)", "steer:s2(read)", "h(2 3000-end folded 1)", "final:a", "gutter split"],
    ],
    [
      "running: the stretches before the latest read steer are settled and open; only the last header is live and counts its own steps",
      [user("u1"), bash("A"), bash("B"), read("s1", 1000), bash("C")],
      live,
      ["user:u1", "h(0 start-1000 2)", "tool:A", "tool:B", "steer:s1(read)", "h(1 1000-end live 1)", "tool:C"],
    ],
    [
      "running, a steer still queued: no split yet, and it is the last row under what arrived after it",
      [user("u1"), bash("A"), queued("s1"), bash("B"), text("t")],
      live,
      ["user:u1", "h(turn live 2)", "tool:A", "tool:B", "text:t", "steer:s1(queued)"],
    ],
    [
      "a read steer from before read times were kept: one header, as before",
      [user("u1"), bash("A"), user("s1", { delivery: "read" }), bash("B"), text("a"), end("e")],
      folded,
      ["user:u1", "h(turn folded 2)", "steer:s1(read)", "final:a", "gutter"],
    ],
    [
      "a never-queued steer (no delivery): one header, as before",
      [user("u1"), bash("A"), user("s1"), bash("B"), text("a"), end("e")],
      folded,
      ["user:u1", "h(turn folded 2)", "steer:s1", "final:a", "gutter"],
    ],
    [
      "another thread's message read mid-turn does not split (its row is a From row or a card's)",
      [user("u1"), bash("A"), user("s1", { delivery: "read", readAt: 1000, from: "m:s-lead" }), bash("B"), text("a"), end("e")],
      folded,
      ["user:u1", "h(turn folded 2)", "steer:s1(read)", "final:a", "gutter"],
    ],
    [
      "a message Claude never read stays in its turn and does not split it",
      [user("u1"), bash("A"), unsent("s1"), item("error", { id: "err" })],
      folded,
      ["user:u1", "tool:A", "steer:s1(unsent)", "note:err"],
    ],
    [
      "a user fold on a settled stretch of the running turn hides its work",
      [user("u1"), bash("A"), read("s1", 1000), bash("C")],
      { fold: (k) => (k === "u1" ? true : undefined), working: true },
      ["user:u1", "h(0 start-1000 folded 1)", "steer:s1(read)", "h(1 1000-end live 1)", "tool:C"],
    ],
    [
      "ended while scrolled up (deferred): every stretch stays open",
      [user("u1"), bash("A"), read("s1", 1000), bash("B"), text("a"), end("e")],
      { fold: () => undefined, working: false, deferred: (e) => e === "e" },
      ["user:u1", "h(0 start-1000 1)", "tool:A", "steer:s1(read)", "h(1 1000-end 1)", "tool:B", "final:a", "gutter split"],
    ],
    [
      "running with strips: the last stretch's run is a strip, the earlier one's too",
      [user("u1"), bash("A"), bash("B"), read("s1", 1000), bash("C"), bash("D")],
      { fold: () => undefined, working: true, strips: true },
      ["user:u1", "h(0 start-1000 2)", "strip(2)", "steer:s1(read)", "h(1 1000-end live 2)", "strip(2)"],
    ],
  ])("%s", (_name, items, opts, want) => {
    expect(shape(rowsOf(items, opts))).toEqual(want);
  });

  it("keys: the first header keeps the turn's (the live one turns into it in place); each later one is keyed by its steer", () => {
    const before = rowsOf([user("u1"), bash("A"), queued("s1")], live);
    const after = rowsOf([user("u1"), bash("A"), read("s1", 1000)], live);
    expect(before.map((r) => r.key)).toEqual(["u1", "h:u1", "A", "s1"]);
    // Read: nothing above the message moves or remounts; a live header is appended under it.
    expect(after.map((r) => r.key)).toEqual(["u1", "h:u1", "A", "s1", "h:u1:s1"]);
    const done = rowsOf([user("u1"), bash("A"), read("s1", 1000), text("a"), end("e")], folded);
    expect(done.map((r) => r.key)).toEqual(["u1", "h:u1", "s1", "h:u1:s1", "a", "f:u1"]);
    const heads = done.filter((r): r is Extract<TimelineRow, { type: "header" }> => r.type === "header");
    expect(heads.map((h) => [h.seg?.fold, h.turn, h.since])).toEqual([
      ["u1", "u1", "u1"],
      ["u1>s1", "u1", "u1"],
    ]);
    // The steer row knows where the turn's time starts, for its "+3m 10s".
    expect(done.find((r) => r.type === "steer")).toMatchObject({ since: "u1", readAt: 1000 });
  });

  it("each header folds its own stretch: the user's choice is by the stretch's key", () => {
    const items = [user("u1"), bash("A"), read("s1", 1000), bash("B"), text("a"), end("e")];
    expect(shape(rowsOf(items, { fold: (k) => (k === "u1>s1" ? false : undefined), working: false }))).toEqual([
      "user:u1",
      "h(0 start-1000 folded 1)",
      "steer:s1(read)",
      "h(1 1000-end 1)",
      "tool:B",
      "final:a",
      "gutter split",
    ]);
  });

  it("the find bar opens the stretch that hides an item", () => {
    const items = [user("u1"), bash("A"), text("mid"), read("s1", 1000), bash("B"), text("a"), end("e")];
    const turns = buildTurns(items);
    expect(foldingTurn(turns, "A")).toBe("u1");
    expect(foldingTurn(turns, "mid")).toBe("u1");
    expect(foldingTurn(turns, "B")).toBe("u1>s1");
    expect(foldingTurn(turns, "a")).toBe("");
    expect(foldingTurn(turns, "s1")).toBe("");
  });

  it("every stretch's rows belong to the turn, for the gutter's hover", () => {
    const rows = rowsOf([user("u1"), bash("A"), read("s1", 1000), bash("B"), text("a"), end("e")], expanded);
    expect(rowTurns(rows)).toEqual(["", "u1", "u1", "u1", "u1", "u1", "u1", "u1"]);
  });

  it("segments: the steers that split, and none for a body without", () => {
    const turn = buildTurns([user("u1"), bash("A"), read("s1", 1), bash("B"), queued("q")])[0];
    expect(segments(turn?.body ?? []).map((s) => [s.steer?.id ?? null, s.nodes.map((x) => ("id" in x ? x.id : x.key))])).toEqual([
      [null, ["A"]],
      ["s1", ["B", "q"]],
    ]);
  });
});

describe("queued messages drawn last", () => {
  it("keeps everything else in order and the queued ones in theirs", () => {
    const items = [user("u1"), queued("q1"), bash("A"), queued("q2"), text("t")];
    expect(queuedLast(items).map((x) => x.id)).toEqual(["u1", "A", "t", "q1", "q2"]);
    const none = [user("u1"), bash("A")];
    expect(queuedLast(none)).toBe(none);
  });

  it("too late: still queued after the turn ended, it waits under the finished turn's gutter with no header", () => {
    const rows = rowsOf([user("u1"), bash("A"), queued("q"), text("a"), end("e")], live);
    expect(shape(rows)).toEqual(["user:u1", "h(turn folded 1)", "final:a", "gutter", "user:q"]);
    // The finished turn is still the latest: its gutter shows at rest.
    expect(rows.find((r) => r.type === "gutter")).toMatchObject({ latest: true });
    // Read: it is the next turn's prompt where it is, with the live header under it.
    const next = rowsOf([user("u1"), bash("A"), text("a"), end("e"), read("q", 5000)], live);
    expect(shape(next)).toEqual(["user:u1", "h(turn folded 1)", "final:a", "gutter", "user:q", "h(turn live 0)"]);
  });

  it("a message never read with no turn open is a row of its own: no header, and the next message starts a turn", () => {
    const items = [user("u1"), text("a"), end("e"), unsent("x"), user("u2"), bash("B")];
    expect(shape(rowsOf(items, live))).toEqual(["user:u1", "h(turn folded 0)", "final:a", "gutter", "steer:x(unsent)", "user:u2", "h(turn live 1)", "tool:B"]);
    // Alone at the end while Claude works: the live header goes after it.
    expect(shape(rowsOf([user("u1"), text("a"), end("e"), unsent("x")], live)).slice(-2)).toEqual(["steer:x(unsent)", "h(turn live 0)"]);
  });

  it("a message never read is not the turn's last item: a message after a crash still starts a new turn", () => {
    const items = [user("u1"), bash("A"), item("error", { id: "err" }), unsent("x"), user("u2")];
    expect(shape(rowsOf(items, folded))).toEqual(["user:u1", "tool:A", "note:err", "steer:x(unsent)", "user:u2"]);
  });
});

describe("the structural key", () => {
  it("round-trips a message's delivery and read time", () => {
    const it0 = read("s1", 1234);
    expect(decodeTimelineKey(timelineKey(it0))).toMatchObject({ id: "s1", delivery: "read", readAt: 1234 });
    expect(decodeTimelineKey(timelineKey(queued("q")))).toMatchObject({ delivery: "queued" });
    expect(decodeTimelineKey(timelineKey(user("u"))).delivery).toBeUndefined();
  });
});
