import { describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { buildRows, buildTurns, rowTurns, type TimelineItem, type TimelineRow, type WorkerState } from "./threadTimeline";
import { decodeWorkers, isNothingNew, senderOf, workerNowOf, workerRuns, workersKey, type RunContext, type WorkerNow } from "./workerRuns";

// The lead is "L"; its workers are W1, W2, W3; "O" is another lead; "C" created L. Times are minutes.
const M = 60_000;

function item(id: string, kind: TimelineItem["kind"], over: Partial<TimelineItem> = {}): TimelineItem {
  return { id, kind, name: "", parentToolUseId: "", toolUseId: "", toolStatus: "", requestState: "", streaming: false, ...over };
}
/** The user's message at minute `min`. */
const user = (id: string, min: number) => item(id, "user", { at: min * M });
/** A wake at minute `min`: each part "<thread>:<done|fail|wait|ask>", created by L unless it says ":<creator>". */
const wake = (id: string, min: number, ...parts: string[]) =>
  item(id, "user", {
    at: min * M,
    from: `w:${parts
      .map((p) => {
        if (p === "x") return "x";
        const [t = "", s = "done", by = s === "ask" ? "" : "L"] = p.split(":");
        return `t/${t}/${s}/${by}`;
      })
      .join(";")}`,
  });
/** Another thread's message. */
const msg = (id: string, min: number, by: string) => item(id, "user", { at: min * M, from: `m:${by}` });
const text = (id: string) => item(id, "text");
/** A text that is only "[nothing new]". */
const quiet = (id: string) => item(id, "text", { quiet: true });
const tool = (id: string) => item(id, "tool", { name: "Bash", toolStatus: "done", toolUseId: `tu-${id}` });
const end = (id: string) => item(id, "turnEnd");

function worker(id: string, createdMin: number, state: WorkerState, sinceMin: number | null = null): WorkerNow {
  return { id, createdAtMs: createdMin * M, state, sinceMs: sinceMin === null ? null : sinceMin * M };
}

function ctx(workers: WorkerNow[], o: Partial<RunContext> = {}): RunContext {
  return { self: "L", creator: "", workers: new Map(workers.map((w) => [w.id, w])), fold: () => undefined, ...o };
}

function rowsOf(items: TimelineItem[], o: { working?: boolean; fold?: (k: string) => boolean | undefined } = {}): TimelineRow[] {
  return buildRows(buildTurns(items), { fold: o.fold ?? (() => undefined), working: o.working ?? false });
}

const at = (m: number | null) => (m === null ? "-" : String(m / M));

/** Rows compactly: the card with its lines (state, since..until in minutes), the gutter with its fold and whether it is the latest. */
function shape(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => {
    switch (r.type) {
      case "workers":
        return `card(${r.live ? "live" : r.folded ? "frozen,folded" : "frozen"} ${at(r.start)}..${at(r.end)}: ${r.lines.map((l) => `${l.id} ${l.state} ${at(l.since)}..${at(l.until)}`).join(", ")})`;
      case "gutter":
        return `gutter:${r.turn}${r.fold ? `(${r.fold})` : ""}${r.latest ? " latest" : ""}`;
      case "header":
        return r.id ? `header:${r.turn}` : "live";
      case "text":
        return `${r.final ? "final" : "text"}:${r.id}`;
      default:
        return `${r.type}:${"id" in r ? r.id : r.key}`;
    }
  });
}

/** The user starts the workers: u1 at 0, a reply, a turn end; W1..W3 made in that turn. */
const start = [user("u1", 0), tool("t-new"), text("r0"), end("e0")];

describe("workerRuns", () => {
  it("leaves a thread without workers as it is (the same rows)", () => {
    const rows = rowsOf([user("u1", 0), text("r0"), end("e0"), user("u2", 5), text("r1"), end("e1")]);
    expect(workerRuns(rows, ctx([]))).toBe(rows);
  });

  it("one worker: its wake turn's note and header give way to a card after the user's turn; the reply stacks under it", () => {
    const rows = rowsOf([...start, wake("k1", 9, "W1"), tool("t1"), text("r1"), end("e1")]);
    expect(shape(workerRuns(rows, ctx([worker("W1", 1, "finished", 9)])))).toEqual([
      "user:u1",
      "header:u1",
      "final:r0",
      "gutter:u1",
      "card(live 0..9: W1 finished 1..9)",
      "final:r1",
      "gutter:k1(folded) latest",
    ]);
  });

  it("three workers reporting at once in one batched wake: one turn, three lines in spawn order", () => {
    const rows = rowsOf([...start, wake("k1", 9, "W2", "W1", "W3"), text("r1"), end("e1")]);
    const out = workerRuns(rows, ctx([worker("W1", 1, "finished"), worker("W2", 2, "finished"), worker("W3", 3, "working", 3)]));
    expect(shape(out)).toEqual(["user:u1", "header:u1", "final:r0", "gutter:u1", "card(live 0..-: W1 finished 1..9, W2 finished 2..9, W3 working 3..-)", "final:r1", "gutter:k1(none) latest"]);
  });

  it("a report arriving mid-turn of a run is left out (its worker is in the card); one mid-turn of the user's own turn stays", () => {
    const run = rowsOf([...start, wake("k1", 9, "W1"), tool("t1"), wake("k2", 10, "W2"), text("r1"), end("e1")], { fold: () => false });
    expect(shape(workerRuns(run, ctx([worker("W1", 1, "finished"), worker("W2", 2, "finished")])))).toEqual([
      "user:u1",
      "header:u1",
      "tool:t-new",
      "final:r0",
      "gutter:u1",
      "card(live 0..10: W1 finished 1..9, W2 finished 2..10)",
      "tool:t1",
      "final:r1",
      "gutter:k1(open) latest",
    ]);
    const own = rowsOf([user("u1", 0), tool("t-new"), wake("k1", 3, "W1"), text("r0"), end("e0")]);
    expect(shape(workerRuns(own, ctx([worker("W1", 1, "finished")])))).toEqual(["user:u1", "header:u1", "steer:k1", "final:r0", "gutter:u1 latest", "card(live 0..3: W1 finished 1..3)"]);
  });

  it("several rounds with one worker: a turn with nothing for the user leaves nothing, the latest gutter moves up", () => {
    const rows = rowsOf([...start, wake("k1", 4, "W1:ask"), tool("t1"), end("e1"), wake("k2", 9, "W1"), text("r2"), end("e2"), wake("k3", 12, "W1:wait"), tool("t3"), end("e3")]);
    expect(shape(workerRuns(rows, ctx([worker("W1", 1, "needs", 12)])))).toEqual(["user:u1", "header:u1", "final:r0", "gutter:u1", "card(live 0..-: W1 needs 9..-)", "final:r2", "gutter:k2(none) latest"]);
  });

  it("a turn that ends with only [nothing new] leaves nothing; opened, its work shows without the marker", () => {
    const items = [...start, wake("k1", 9, "W1:ask"), tool("t1"), quiet("q1"), end("e1"), wake("k2", 12, "W1"), text("r2"), end("e2")];
    const workers = ctx([worker("W1", 1, "finished")]);
    expect(shape(workerRuns(rowsOf(items), workers)).slice(4)).toEqual(["card(live 0..12: W1 finished 1..12)", "final:r2", "gutter:k2(none) latest"]);
    expect(shape(workerRuns(rowsOf(items, { fold: () => false }), workers)).slice(5)).toEqual(["card(live 0..12: W1 finished 1..12)", "tool:t1", "gutter:k1(open)", "final:r2", "gutter:k2(none) latest"]);
  });

  it("the user stepping in freezes the card (folded, stamped) and starts a new one with the workers still running", () => {
    const items = [...start, wake("k1", 9, "W1"), text("r1"), end("e1"), user("u2", 12), text("r2"), end("e2"), wake("k2", 20, "W2"), text("r3"), end("e3")];
    const workers = [worker("W1", 1, "finished"), worker("W2", 2, "finished")];
    expect(shape(workerRuns(rowsOf(items), ctx(workers)))).toEqual([
      "user:u1",
      "header:u1",
      "final:r0",
      "gutter:u1",
      "card(frozen,folded 0..12: W1 finished 1..9, W2 working 2..12)",
      "final:r1",
      "gutter:k1(none)",
      "user:u2",
      "header:u2",
      "final:r2",
      "gutter:u2",
      "card(live 12..20: W2 finished 2..20)",
      "final:r3",
      "gutter:k2(none) latest",
    ]);
  });

  it("opens a frozen card the user opened (its key is the anchoring turn's)", () => {
    const items = [...start, wake("k1", 9, "W1"), text("r1"), end("e1"), user("u2", 12), text("r2"), end("e2")];
    const out = workerRuns(rowsOf(items), ctx([worker("W1", 1, "finished")], { fold: (k) => (k === "w:u1" ? false : undefined) }));
    expect(out.find((r) => r.type === "workers")).toMatchObject({ key: "w:u1", folded: false, live: false });
  });

  it("a finished worker is not carried into the next card; sent more work, it comes back", () => {
    const items = [...start, wake("k1", 9, "W1"), text("r1"), end("e1"), user("u2", 12), text("r2"), end("e2")];
    expect(shape(workerRuns(rowsOf(items), ctx([worker("W1", 1, "finished", 9)]))).filter((s) => s.startsWith("card"))).toEqual(["card(frozen,folded 0..12: W1 finished 1..9)"]);
    // The lead sent it more in u2's turn: it works again since 13.
    expect(shape(workerRuns(rowsOf(items), ctx([worker("W1", 1, "working", 13)]))).filter((s) => s.startsWith("card"))).toEqual(["card(frozen,folded 0..12: W1 finished 1..9)", "card(live 12..-: W1 working 13..-)"]);
  });

  it("a worker that needs the user, or asks, reads so in the current card", () => {
    const rows = rowsOf([...start, wake("k1", 9, "W1:wait"), text("r1"), end("e1")]);
    expect(shape(workerRuns(rows, ctx([worker("W1", 1, "needs", 9), worker("W2", 2, "asks", 8)]))).find((s) => s.startsWith("card"))).toBe("card(live 0..-: W1 needs 1..-, W2 asks 2..-)");
  });

  it("wakes that are no worker's stay as they were, among the stacked replies, and end nothing", () => {
    const items = [
      ...start,
      wake("k1", 5, "W1"),
      text("r1"),
      end("e1"),
      wake("pr", 6, "x"),
      text("r2"),
      end("e2"),
      wake("ko", 7, "O:done:Z"),
      text("r3"),
      end("e3"),
      msg("mo", 8, "O"),
      text("r4"),
      end("e4"),
      wake("k2", 9, "W1"),
      text("r5"),
      end("e5"),
    ];
    expect(shape(workerRuns(rowsOf(items), ctx([worker("W1", 1, "finished")])))).toEqual([
      "user:u1",
      "header:u1",
      "final:r0",
      "gutter:u1",
      "card(live 0..9: W1 finished 5..9)",
      "final:r1",
      "gutter:k1(none)",
      "user:pr",
      "header:pr",
      "final:r2",
      "gutter:pr",
      "user:ko",
      "header:ko",
      "final:r3",
      "gutter:ko",
      "user:mo",
      "header:mo",
      "final:r4",
      "gutter:mo",
      "final:r5",
      "gutter:k2(none) latest",
    ]);
  });

  it("a worker's message and a removed worker's wake join the run", () => {
    const rows = rowsOf([...start, msg("m1", 4, "W1"), text("r1"), end("e1"), wake("k2", 6, "W9"), text("r2"), end("e2")]);
    expect(shape(workerRuns(rows, ctx([worker("W1", 1, "working", 4)])))).toEqual([
      "user:u1",
      "header:u1",
      "final:r0",
      "gutter:u1",
      "card(live 0..-: W1 working 4..-, W9 finished 6..6)",
      "final:r1",
      "gutter:m1(none)",
      "final:r2",
      "gutter:k2(none) latest",
    ]);
  });

  it("the creator's message counts as the user's: it freezes the run", () => {
    const items = [msg("c1", 0, "C"), tool("t-new"), text("r0"), end("e0"), wake("k1", 9, "W1"), text("r1"), end("e1"), msg("c2", 12, "C"), text("r2"), end("e2")];
    expect(shape(workerRuns(rowsOf(items), ctx([worker("W1", 1, "finished")], { creator: "C" }))).filter((s) => s.startsWith("card") || s.startsWith("user"))).toEqual([
      "user:c1",
      "card(frozen,folded 0..12: W1 finished 1..9)",
      "user:c2",
    ]);
  });

  it("the user's message mid-run turn makes that turn the user's: shown as before, it freezes the card before it", () => {
    const items = [...start, wake("k1", 9, "W1"), tool("t1"), user("s1", 10), text("r1"), end("e1")];
    // W1 finished before the user spoke and nothing touched it since: no new card.
    expect(shape(workerRuns(rowsOf(items), ctx([worker("W1", 1, "finished")])))).toEqual([
      "user:u1",
      "header:u1",
      "final:r0",
      "gutter:u1",
      "card(frozen,folded 0..10: W1 finished 1..9)",
      "user:k1",
      "header:k1",
      "steer:s1",
      "final:r1",
      "gutter:k1 latest",
    ]);
    // Still working, it carries over into a new card under that turn.
    expect(shape(workerRuns(rowsOf([...start, wake("k1", 9, "W1:ask"), tool("t1"), user("s1", 10), text("r1"), end("e1")]), ctx([worker("W1", 1, "working", 1)]))).at(-1)).toBe(
      "card(live 10..-: W1 working 1..-)",
    );
  });

  it("a run turn that runs shows its work without the note or header; no card while the user's own turn runs", () => {
    const live = rowsOf([...start, wake("k1", 9, "W1"), tool("t1"), text("r1")], { working: true });
    // The run turn still runs, so the gutter above is not the latest (turn-gutter.md).
    expect(shape(workerRuns(live, ctx([worker("W1", 1, "finished")])))).toEqual(["user:u1", "header:u1", "final:r0", "gutter:u1", "card(live 0..9: W1 finished 1..9)", "tool:t1", "final:r1"]);
    const own = rowsOf([user("u1", 0), tool("t-new")], { working: true });
    expect(shape(workerRuns(own, ctx([worker("W1", 1, "working", 1)])))).toEqual(["user:u1", "live", "tool:t-new"]);
  });

  it("a run turn's rows belong to its turn for the gutter's hover", () => {
    const rows = workerRuns(rowsOf([...start, wake("k1", 9, "W1"), tool("t1"), text("r1"), end("e1")], { fold: () => false }), ctx([worker("W1", 1, "finished")]));
    expect(rowTurns(rows)).toEqual(["", "u1", "u1", "u1", "u1", "", "k1", "k1", "k1"]);
  });
});

describe("senderOf", () => {
  const u = (o: Partial<Extract<ThreadItemView, { kind: "user" }>>): ThreadItemView =>
    ({ id: "u", kind: "user", text: "", attachments: [], composerText: "", ordinal: 1, parentToolUseId: "", createdAtMs: 0, updatedAtMs: 0, streaming: false, ...o });

  it.each([
    ["the user's", {}, ""],
    ["another thread's message", { from: { threadId: "s-9", relation: "worker", reply: "none" } }, "m:s-9"],
    ["a thread's settle", { wake: { title: "", json: JSON.stringify({ kind: "thread", thread: { id: "s-1", status: "needs_attention", status_reason: "finished", created_by: "s-L" } }) } }, "w:t/s-1/done/s-L"],
    [
      "a batch with a failure and a prompt",
      {
        wake: {
          title: "",
          json: JSON.stringify({
            kind: "batch",
            wakes: [
              { kind: "thread", thread: { id: "a", status: "error", created_by: "L" } },
              { kind: "thread", thread: { id: "b", status: "needs_attention", status_reason: "permission: Bash", created_by: "L" } },
            ],
          }),
        },
      },
      "w:t/a/fail/L;t/b/wait/L",
    ],
    ["an ask", { wake: { title: "", json: JSON.stringify({ kind: "ask", thread: "s-2", question: "?" }) } }, "w:t/s-2/ask/"],
    ["an action run", { wake: { title: "", json: JSON.stringify({ kind: "action_run", run: { id: "r", exit_code: 0 } }) } }, "w:x"],
    ["a pull request", { wake: { title: "PR merged", json: JSON.stringify({ kind: "pull_request" }) } }, "w:x"],
  ] as const)("%s", (_n, o, want) => {
    expect(senderOf(u(o as Partial<Extract<ThreadItemView, { kind: "user" }>>))).toBe(want);
  });
});

describe("workerNowOf / workersKey", () => {
  const t = (id: string, o: Partial<ThreadView>): ThreadView =>
    ({ id, name: id, state: "connected", status: "idle", statusReason: "", statusChangedAtMs: 5, createdAtMs: 1, archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, createdBy: "L", setup: null, ...o }) as ThreadView;

  it.each([
    ["busy", { status: "busy" }, "working"],
    ["waiting on its own children", { statusReason: "waiting on 2 child threads" }, "working"],
    ["snoozed but busy", { status: "busy", snoozedUntilMs: 9e15 }, "working"],
    ["a permission", { status: "attention", statusReason: "permission: Bash" }, "needs"],
    ["a question", { status: "attention", statusReason: "question: Which?" }, "asks"],
    ["finished", { status: "attention", statusReason: "finished" }, "finished"],
    ["idle", {}, "finished"],
    ["an error", { status: "attention", statusReason: "error: overloaded" }, "failed"],
    ["interrupted", { status: "error", statusReason: "interrupted" }, "stopped"],
    ["archived", { archivedAtMs: 3 }, "archived"],
  ] as const)("%s → %s", (_n, o, want) => {
    expect(workerNowOf(t("w", o as Partial<ThreadView>)).state).toBe(want);
  });

  it("keys only this thread's workers and decodes them back", () => {
    const byId = { a: t("a", { status: "busy" }), b: t("b", { createdBy: "other" }), L: t("L", { createdBy: "" }) };
    const key = workersKey(byId, "L");
    expect(key).toBe("a|1|working|5");
    expect([...decodeWorkers(key).values()]).toEqual([{ id: "a", createdAtMs: 1, state: "working", sinceMs: 5 }]);
    expect(decodeWorkers("").size).toBe(0);
  });
});

describe("isNothingNew", () => {
  it.each([
    ["[nothing new]", true],
    ["  [Nothing new].\n", true],
    ["`[nothing new]`", true],
    ["nothing new", false],
    ["[nothing new] but W2 failed", false],
  ])("%j → %s", (text, want) => {
    expect(isNothingNew(text)).toBe(want);
  });
});
