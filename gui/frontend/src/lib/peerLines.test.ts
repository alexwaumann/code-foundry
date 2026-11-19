import { describe, expect, it } from "vitest";
import type { SentMessageView } from "@/api/replies";
import { decodeSent, peerStart, peerWords, sentDescOf, type PeerEvent, type SentState } from "./peerLines";
import { buildRows, buildTurns, rowTurns, type TimelineItem, type TimelineRow } from "./threadTimeline";
import { workerRuns, type RunContext, type WorkerNow } from "./workerRuns";

// This thread is "L"; "P" and "Q" are other lead threads; "W1" is L's worker; "C" created L. Times are minutes.
const M = 60_000;

function item(id: string, kind: TimelineItem["kind"], over: Partial<TimelineItem> = {}): TimelineItem {
  return { id, kind, name: "", parentToolUseId: "", toolUseId: "", toolStatus: "", requestState: "", streaming: false, ...over };
}
const user = (id: string, min: number) => item(id, "user", { at: min * M });
/** Another thread's message; `wanted`: it wants a reply. */
const msg = (id: string, min: number, by: string, wanted = false) => item(id, "user", { at: min * M, from: `m:${by}${wanted ? "/w" : ""}` });
/** L's note for a message it sent: "<to>/<w|n>/<state>/<reply item>". */
const sent = (id: string, min: number, desc: string) => item(id, "note", { at: min * M, sent: desc });
const wake = (id: string, min: number, w: string) => item(id, "user", { at: min * M, from: `w:t/${w}/done/L` });
const text = (id: string) => item(id, "text");
const quiet = (id: string) => item(id, "text", { quiet: true });
const tool = (id: string) => item(id, "tool", { name: "Bash", toolStatus: "done", toolUseId: `tu-${id}` });
const end = (id: string) => item(id, "turnEnd");

function ctx(workers: WorkerNow[] = [], o: Partial<RunContext> = {}): RunContext {
  return { self: "L", creator: "", workers: new Map(workers.map((w) => [w.id, w])), fold: () => undefined, ...o };
}

function rowsOf(items: TimelineItem[], o: { working?: boolean } = {}): TimelineRow[] {
  return buildRows(buildTurns(items), { fold: () => undefined, working: o.working ?? false });
}

const at = (m: number | null) => (m === null ? "-" : String(m / M));

/** Rows compactly; a line as `line(<key> <live|frozen@end> <tone>: <words> from <start>)`. */
function shape(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => {
    switch (r.type) {
      case "peer":
        return `line(${r.key} ${r.live ? "live" : `frozen@${at(r.end)}`} ${r.tone}: ${r.words} from ${at(r.start)})`;
      case "workers":
        return `card(${r.lines.map((l) => l.id).join(",")})`;
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

const run = (items: TimelineItem[], c: RunContext = ctx(), o: { working?: boolean } = {}) => shape(workerRuns(rowsOf(items, o), c));

/** The user asks L to talk to P: u1 at 0, the send at 1, L's reply. */
const ask = (desc: string) => [user("u1", 0), tool("t1"), sent("n1", 1, desc), text("r0"), end("e0")];

describe("other threads' lines in the run (workerRuns)", () => {
  const cases: { name: string; items: TimelineItem[]; c?: RunContext; working?: boolean; want: string[] }[] = [
    {
      name: "told: one line under the turn that sent, the note gone",
      items: ask("P/n//"),
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1 latest", "line(p:u1:P live info: told · no reply needed from 1)"],
    },
    {
      name: "asked and waiting",
      items: ask("P/w/waiting/"),
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1 latest", "line(p:u1:P live warning: asked · waiting for a reply from 1)"],
    },
    {
      name: "asked, then the reply: the same line says replied, the reply's turn has no message or header, its reply stacks",
      items: [...ask("P/w/replied/m1"), msg("m1", 5, "P"), tool("t2"), text("r1"), end("e1")],
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1", "line(p:u1:P live success: replied from 1)", "final:r1", "gutter:m1(folded) latest"],
    },
    {
      name: "asked back, then told: the line extends; a turn with nothing for the user leaves nothing",
      items: [
        ...ask("P/w/replied/m1"),
        msg("m1", 5, "P"),
        text("r1"),
        end("e1"),
        msg("m2", 8, "P", true),
        tool("t3"),
        sent("n2", 9, "P/n//"),
        text("r2"),
        end("e2"),
        msg("m3", 12, "P"),
        quiet("q3"),
        end("e3"),
      ],
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1", "line(p:u1:P live success: replied · then asked 1 question, answered · then sent 1 message from 1)", "final:r1", "gutter:m1(none)", "final:r2", "gutter:m2(folded) latest"],
    },
    {
      name: "asked back and not answered yet",
      items: [...ask("P/w/replied/m1"), msg("m1", 5, "P"), text("r1"), end("e1"), msg("m2", 8, "P", true), tool("t3")],
      working: true,
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1", "line(p:u1:P live success: replied · then asked 1 question from 1)", "final:r1", "gutter:m1(none)", "tool:t3"],
    },
    {
      name: "two other threads: two lines, in the order they were first messaged",
      items: [user("u1", 0), sent("n1", 1, "P/n//"), sent("n2", 2, "Q/w/waiting/"), text("r0"), end("e0")],
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1 latest", "line(p:u1:P live info: told · no reply needed from 1)", "line(p:u1:Q live warning: asked · waiting for a reply from 2)"],
    },
    {
      name: "other threads next to its workers in one run: the card first, the lines under it; turns of both stack",
      items: [user("u1", 0), tool("t-new"), sent("n1", 1, "P/w/replied/m1"), text("r0"), end("e0"), wake("k1", 4, "W1"), text("r1"), end("e1"), msg("m1", 6, "P"), text("r2"), end("e2")],
      c: ctx([{ id: "W1", createdAtMs: 0.5 * M, state: "finished", sinceMs: 4 * M }]),
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1", "card(W1)", "line(p:u1:P live success: replied from 1)", "final:r1", "gutter:k1(none)", "final:r2", "gutter:m1(none) latest"],
    },
    {
      name: "the user steps in: the line freezes at their message; a new message to the same thread starts a new line in the new run",
      items: [...ask("P/w/replied/m1"), msg("m1", 5, "P"), text("r1"), end("e1"), user("u2", 10), sent("n2", 11, "P/n//"), text("r2"), end("e2")],
      want: [
        "user:u1",
        "header:u1",
        "final:r0",
        "gutter:u1",
        "line(p:u1:P frozen@10 success: replied from 1)",
        "final:r1",
        "gutter:m1(none)",
        "user:u2",
        "header:u2",
        "final:r2",
        "gutter:u2 latest",
        "line(p:u2:P live info: told · no reply needed from 11)",
      ],
    },
    {
      name: "an answer that comes after the user stepped in: the frozen line had none yet; it opens a new line above its turn",
      items: [...ask("P/w/replied/m1"), user("u2", 5), text("r2"), end("e2"), msg("m1", 7, "P"), text("r3"), end("e3")],
      want: [
        "user:u1",
        "header:u1",
        "final:r0",
        "gutter:u1",
        "line(p:u1:P frozen@5 muted: asked · no answer yet from 1)",
        "user:u2",
        "header:u2",
        "final:r2",
        "gutter:u2",
        "line(p:u2:P live success: replied from 7)",
        "final:r3",
        "gutter:m1(none) latest",
      ],
    },
    {
      name: "receiving: another thread's message opens a normal turn (its row stays); the answer is a line under that turn",
      items: [user("u1", 0), text("r0"), end("e0"), msg("m1", 3, "P", true), tool("t1"), sent("n1", 4, "P/n//"), text("r1"), end("e1")],
      want: ["user:u1", "header:u1", "final:r0", "gutter:u1", "user:m1", "header:m1", "final:r1", "gutter:m1 latest", "line(p:u1:P live success: answered from 3)"],
    },
    {
      name: "no line while the turn that sent still runs",
      items: [user("u1", 0), tool("t1"), sent("n1", 1, "P/w/waiting/"), tool("t2")],
      working: true,
      want: ["user:u1", "live", "tool:t1", "tool:t2"],
    },
    {
      name: "its creator's message is the user's and its worker's is the card's, next to a line",
      items: [msg("c1", 0, "C"), sent("n1", 1, "P/n//"), text("r0"), end("e0"), item("m1", "user", { at: 3 * M, from: "m:W1" }), text("r1"), end("e1")],
      c: ctx([{ id: "W1", createdAtMs: 0.5 * M, state: "finished", sinceMs: 3 * M }], { creator: "C" }),
      want: ["user:c1", "header:c1", "final:r0", "gutter:c1", "card(W1)", "line(p:c1:P live info: told · no reply needed from 1)", "final:r1", "gutter:m1(none) latest"],
    },
  ];
  it.each(cases)("$name", ({ items, c, working, want }) => {
    expect(run(items, c, working === undefined ? {} : { working })).toEqual(want);
  });

  it("a thread that only got another thread's message (it sent nothing) keeps its rows as they are", () => {
    const rows = rowsOf([user("u1", 0), text("r0"), end("e0"), msg("m1", 3, "P", true), text("r1"), end("e1")]);
    expect(workerRuns(rows, ctx())).toBe(rows);
  });

  it("a line's key holds while its words change, and nothing before it moves", () => {
    const before = workerRuns(rowsOf(ask("P/w/waiting/")), ctx());
    const after = workerRuns(rowsOf([...ask("P/w/replied/m1"), msg("m1", 5, "P"), text("r1"), end("e1")]), ctx());
    const i = before.findIndex((r) => r.type === "peer");
    expect(after.slice(0, i).map((r) => r.key)).toEqual(before.slice(0, i).map((r) => r.key));
    expect(after[i]?.key).toBe(before[i]?.key);
  });

  it("rowTurns: a line belongs to no turn, and a stacked reply's turn starts under it", () => {
    const rows = workerRuns(rowsOf([...ask("P/w/replied/m1"), msg("m1", 5, "P"), tool("t2"), text("r1"), end("e1")]), ctx());
    expect(rowTurns(rows)).toEqual(["", "u1", "u1", "u1", "", "m1", "m1"]);
  });
});

describe("peerWords", () => {
  const S = (wanted: boolean, state: SentState = "", replyItem = "", min = 1): PeerEvent => ({
    kind: "sent",
    wanted,
    state: wanted && state === "" ? "waiting" : state,
    replyItem,
    at: min * M,
  });
  const G = (item: string, wanted: boolean, answer = false, min = 2): PeerEvent => ({ kind: "got", wanted, item, answer, at: min * M });
  const cases: { name: string; ev: PeerEvent[]; live?: boolean; want: string | null }[] = [
    { name: "nothing sent: no line", ev: [G("m1", true)], want: null },
    { name: "told", ev: [S(false)], want: "info: told · no reply needed" },
    { name: "asked, waiting", ev: [S(true)], want: "warning: asked · waiting for a reply" },
    { name: "asked, frozen before the reply", ev: [S(true)], live: false, want: "muted: asked · no answer yet" },
    { name: "replied", ev: [S(true, "replied", "m1"), G("m1", false)], want: "success: replied" },
    { name: "replied after the freeze", ev: [S(true, "replied", "m9")], live: false, want: "muted: asked · no answer yet" },
    { name: "no answer: it ended its turn", ev: [S(true, "ended")], want: "muted: asked · no answer yet" },
    { name: "no answer: archived", ev: [S(true, "archived")], want: "muted: asked · no answer: archived" },
    { name: "no answer: removed", ev: [S(true, "removed")], want: "muted: asked · no answer: removed" },
    { name: "answered a question it was asked first", ev: [G("m1", true), S(false)], want: "success: answered" },
    { name: "told after a message that wanted no reply", ev: [G("m1", false), S(false)], want: "info: told · no reply needed" },
    { name: "the answer to an earlier run's question", ev: [G("m1", false, true)], want: "success: replied" },
    { name: "replied, then asked back and answered", ev: [S(true, "replied", "m1"), G("m1", false), G("m2", true), S(false)], want: "success: replied · then asked 1 question, answered" },
    { name: "replied, then a message that wants no reply", ev: [S(true, "replied", "m1"), G("m1", false), G("m2", false), G("m3", false)], want: "success: replied · then sent 2 messages" },
    { name: "told, then a message back and a question, answered", ev: [S(false), G("m1", false), G("m2", true), S(false)], want: "success: told · no reply needed · then sent 1 message · then asked 1 question, answered" },
    { name: "two questions back, one open", ev: [S(true, "replied", "m1"), G("m1", false), G("m2", true), S(false), G("m3", true)], want: "success: replied · then asked 2 questions" },
    { name: "answered, then asked it something, waiting", ev: [G("m1", true), S(false), S(true)], want: "warning: answered · then asked it 1 question · waiting for a reply" },
    { name: "answered and asked in one message, replied", ev: [G("m1", true), S(true, "replied", "m2"), G("m2", false)], want: "success: answered · then asked it 1 question, replied" },
    { name: "told, then asked it, no answer yet", ev: [S(false), S(true, "ended")], want: "muted: told · no reply needed · then asked it 1 question, no answer yet" },
  ];
  it.each(cases)("$name", ({ ev, live, want }) => {
    const w = peerWords(ev, live ?? true);
    expect(w ? `${w.tone}: ${w.words}` : null).toBe(want);
  });

  it("peerStart: the first event's time", () => {
    expect(peerStart([G("m1", true, false, 3), S(false, "", "", 4)])).toBe(3 * M);
    expect(peerStart([])).toBeNull();
  });
});

describe("sentDescOf and decodeSent", () => {
  const view = (o: Partial<SentMessageView>): SentMessageView => ({ toThreadId: "P", toName: "P", relation: "other", reply: "none", itemId: "P-u1", ordinal: 1, repliedAtMs: null, replyItemId: "", unanswered: "", ...o });
  const cases: { name: string; v: SentMessageView | undefined; want: string }[] = [
    { name: "none", v: undefined, want: "" },
    { name: "to its lead: a plain note", v: view({ relation: "lead" }), want: "" },
    { name: "told", v: view({}), want: "P/n//" },
    { name: "waiting", v: view({ reply: "wanted" }), want: "P/w/waiting/" },
    { name: "replied", v: view({ reply: "wanted", repliedAtMs: 5, replyItemId: "m1" }), want: "P/w/replied/m1" },
    { name: "turn ended", v: view({ reply: "wanted", unanswered: "turn ended" }), want: "P/w/ended/" },
    { name: "archived", v: view({ reply: "wanted", unanswered: "archived" }), want: "P/w/archived/" },
  ];
  it.each(cases)("$name", ({ v, want }) => {
    expect(sentDescOf(v)).toBe(want);
  });
  it("decodes what it encodes, and nothing for junk", () => {
    expect(decodeSent("P/w/replied/m1")).toEqual({ to: "P", wanted: true, state: "replied", replyItem: "m1" });
    expect(decodeSent("P/n//")).toEqual({ to: "P", wanted: false, state: "", replyItem: "" });
    expect(decodeSent("")).toBeNull();
    expect(decodeSent("P/w/bogus/")).toBeNull();
  });
});
