import { describe, expect, it } from "vitest";
import { buildRows, buildTurns, decodeTimelineKey, groupLabel, timelineKey, turnCostLabel, type TimelineItem, type TimelineRow } from "./threadTimeline";

let n = 0;
function item(kind: TimelineItem["kind"], over: Partial<TimelineItem> = {}): TimelineItem {
  n++;
  return { id: `${kind}-${String(n)}`, kind, name: "", parentToolUseId: "", toolUseId: "", toolStatus: "", requestState: "", streaming: false, ...over };
}
const tool = (name: string, over: Partial<TimelineItem> = {}) => {
  const it = item("tool", { name, toolStatus: "done", ...over });
  return { ...it, toolUseId: over.toolUseId ?? `tu-${it.id}` };
};
const user = (id: string) => item("user", { id });
const text = (id: string) => item("text", { id });
const end = (id: string) => item("turnEnd", { id });

/** Row types with their ids, compactly. */
function shape(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => {
    switch (r.type) {
      case "group":
        return `group(${r.names.join(",")})`;
      case "thinking":
        return `thinking(${String(r.ids.length)})`;
      case "tool":
        return r.children.length > 0 ? `tool:${r.name}[${shape(r.children).join(" ")}]` : `tool:${r.name}${r.permissionId ? "+perm" : ""}`;
      case "text":
        return r.final ? `final:${r.id}` : `text:${r.id}`;
      case "header":
        return r.id ? `header${r.folded ? `(folded ${String(r.steps)})` : ""}` : `live(${r.since},${String(r.steps)})`;
      case "note":
        return `note:${r.kind}`;
      default:
        return `${r.type}:${r.id}`;
    }
  });
}

const open = { fold: () => undefined, working: false };
/** Every turn unfolded by the user: the whole structure of finished turns. */
const expanded = { fold: () => false, working: false };

describe("groupLabel", () => {
  it.each([
    [["Read", "Read", "Read", "Grep", "Glob"], "Read 3 files, searched code 2 times"],
    [["Read", "Read", "Grep"], "Read 2 files, searched code once"],
    [["Grep", "Grep"], "Searched code 2 times"],
    [["Read", "LS"], "Read 2 files"],
    [["Read"], "Read 1 file"],
  ])("%j → %s", (names, want) => {
    expect(groupLabel(names)).toBe(want);
  });
});

describe("buildTurns / buildRows", () => {
  it("groups consecutive reads and searches, absorbing thinking between them but not after", () => {
    const items = [user("u1"), item("thinking"), tool("Read"), item("thinking"), tool("Grep"), tool("Read"), item("thinking"), tool("Bash"), text("t1"), end("e1")];
    const rows = buildRows(buildTurns(items), expanded);
    expect(shape(rows)).toEqual(["user:u1", "header", "thinking(1)", "group(Read,Grep,Read)", "thinking(1)", "tool:Bash", "final:t1"]);
  });

  it("a lone read stays a tool row; consecutive thinking merges", () => {
    const items = [user("u1"), item("thinking"), item("thinking"), tool("Read"), tool("Edit"), text("t1")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "thinking(2)", "tool:Read", "tool:Edit", "final:t1"]);
  });

  it("nests a subagent's items under its Agent row, grouped the same way", () => {
    const agent = tool("Agent", { toolUseId: "tu-agent" });
    const items = [
      user("u1"),
      agent,
      tool("Read", { parentToolUseId: "tu-agent" }),
      tool("Read", { parentToolUseId: "tu-agent" }),
      tool("Bash", { parentToolUseId: "tu-agent" }),
      item("text", { id: "sub", parentToolUseId: "tu-agent" }),
      text("t1"),
    ];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "tool:Agent[group(Read,Read) tool:Bash text:sub]", "final:t1"]);
  });

  it("an item whose parent is unknown stays at the top level", () => {
    const items = [user("u1"), tool("Bash", { parentToolUseId: "tu-gone" })];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "tool:Bash"]);
  });

  it("hides AskUserQuestion's call behind its question; a permission annotates its tool", () => {
    const bash = tool("Bash", { toolUseId: "tu-b", toolStatus: "running" });
    const items = [
      user("u1"),
      tool("AskUserQuestion", { toolUseId: "tu-q" }),
      item("question", { id: "q1", toolUseId: "tu-q", requestState: "allowed" }),
      bash,
      item("permission", { id: "p1", toolUseId: "tu-b", name: "Bash", requestState: "pending" }),
      item("permission", { id: "p2", toolUseId: "", name: "Write", requestState: "denied" }),
    ];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "question:q1", "tool:Bash+perm", "permission:p2"]);
  });

  it("a read waiting on a permission is not grouped (its row shows the wait)", () => {
    const items = [user("u1"), tool("Read"), tool("Read", { toolUseId: "tu-r" }), item("permission", { toolUseId: "tu-r", requestState: "pending" })];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "tool:Read", "tool:Read+perm"]);
  });

  it("folds every finished turn, the latest included, under its header; final text and notes stay", () => {
    const items = [
      user("u1"),
      item("thinking"),
      tool("Read"),
      tool("Read"),
      text("mid"),
      tool("Edit"),
      item("error", { id: "err" }),
      text("a1"),
      item("thinking"),
      text("a2"),
      end("e1"),
      user("u2"),
      tool("Bash"),
      text("b1"),
      end("e2"),
    ];
    const turns = buildTurns(items);
    expect(turns.map((t) => t.key)).toEqual(["u1", "u2"]);
    const rows = buildRows(turns, open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 5)", "note:error", "final:a1", "final:a2", "user:u2", "header(folded 1)", "final:b1"]);
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([["a1", "a2"], ["b1"]]);
    // Every finished turn's header counts its steps (open or folded) and carries its turn_end.
    expect(rows.flatMap((r) => (r.type === "header" ? [[r.key, r.id, r.turn, r.steps, r.folded]] : []))).toEqual([
      ["h:u1", "e1", "u1", 5, true],
      ["h:u2", "e2", "u2", 1, true],
    ]);
    // The answer's copy action sits on its first final text row and copies all of it.
    expect(rows.flatMap((r) => (r.type === "text" ? [[r.id, r.answer]] : []))).toEqual([
      ["a1", "a1\na2"],
      ["a2", ""],
      ["b1", "b1"],
    ]);
    // The user's choice wins both ways: the latest turn reopened, then an older one.
    expect(shape(buildRows(turns, { fold: (k) => (k === "u2" ? false : undefined), working: false }))).toEqual([
      "user:u1",
      "header(folded 5)",
      "note:error",
      "final:a1",
      "final:a2",
      "user:u2",
      "header",
      "tool:Bash",
      "final:b1",
    ]);
    const fold = (k: string) => (k === "u1" ? false : k === "u2" ? true : undefined);
    expect(shape(buildRows(turns, { fold, working: false }))).toEqual([
      "user:u1",
      "header",
      "thinking(1)",
      "group(Read,Read)",
      "text:mid",
      "tool:Edit",
      "note:error",
      "final:a1",
      "thinking(1)",
      "final:a2",
      "user:u2",
      "header(folded 1)",
      "final:b1",
    ]);
  });

  it("the running turn never folds; it folds the moment it ends", () => {
    const items = [user("u1"), tool("Bash"), text("a"), end("e1"), user("u2"), tool("Read")];
    expect(shape(buildRows(buildTurns(items), { fold: () => undefined, working: true }))).toEqual(["user:u1", "header(folded 1)", "final:a", "user:u2", "live(u2,1)", "tool:Read"]);
    // The running turn has no turn_end, so no user choice: it stays open whatever fold says.
    expect(shape(buildRows(buildTurns(items), { fold: () => true, working: true })).slice(3)).toEqual(["user:u2", "live(u2,1)", "tool:Read"]);
    // Nothing runs after a turn_end: no live header even when the thread says busy, and
    // the just-finished (latest) turn is folded.
    expect(shape(buildRows(buildTurns(items.slice(0, 4)), { fold: () => undefined, working: true }))).toEqual(["user:u1", "header(folded 1)", "final:a"]);
  });

  it("a turn that ended while the list was scrolled up stays open (deferred); the user's choice still wins", () => {
    const items = [user("u1"), tool("Bash"), text("a"), end("e1"), user("u2"), tool("Edit"), text("b"), end("e2")];
    const turns = buildTurns(items);
    const deferred = (e: string) => e === "e2";
    // Only the deferred turn stays open: the header reads as finished (not live), its work shows.
    expect(shape(buildRows(turns, { fold: () => undefined, deferred, working: false }))).toEqual(["user:u1", "header(folded 1)", "final:a", "user:u2", "header", "tool:Edit", "final:b"]);
    // A click on its header folds it all the same.
    expect(shape(buildRows(turns, { fold: (k) => (k === "u2" ? true : undefined), deferred, working: false })).slice(3)).toEqual(["user:u2", "header(folded 1)", "final:b"]);
    // Re-pinned (no deferral): the default, folded.
    expect(shape(buildRows(turns, { fold: () => undefined, deferred: () => false, working: false })).slice(3)).toEqual(["user:u2", "header(folded 1)", "final:b"]);
    // A running turn has no turn_end to defer: open and live as before.
    expect(shape(buildRows(buildTurns(items.slice(0, 7)), { fold: () => undefined, deferred, working: true })).slice(3)).toEqual(["user:u2", "live(u2,1)", "tool:Edit", "final:b"]);
  });

  it("the live header becomes the finished one in place: same row key, same position", () => {
    const running = [user("u1"), user("u2"), tool("Bash"), tool("Edit"), text("a")];
    const live = buildRows(buildTurns(running), { fold: () => undefined, working: true });
    expect(shape(live)).toEqual(["user:u1", "user:u2", "live(u2,2)", "tool:Bash", "tool:Edit", "final:a"]);
    const done = buildRows(buildTurns([...running, end("e1")]), { fold: () => undefined, working: true });
    expect(shape(done)).toEqual(["user:u1", "user:u2", "header(folded 2)", "final:a"]);
    expect(live[2]?.key).toBe("h:u1");
    expect(done[2]?.key).toBe("h:u1");
    // A running turn's text has no copy action yet: the answer may still grow.
    expect(live.flatMap((r) => (r.type === "text" ? [r.answer] : []))).toEqual([""]);
    // A turn still starting (only its message) shows the live header too.
    expect(shape(buildRows(buildTurns([user("u1")]), { fold: () => undefined, working: true }))).toEqual(["user:u1", "live(u1,0)"]);
  });

  it("no live header while a request waits (working is false); a turn Claude starts itself counts from its first item", () => {
    const items = [user("u1"), tool("Bash", { toolUseId: "tu-b", toolStatus: "running" }), item("permission", { toolUseId: "tu-b", requestState: "pending" })];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "tool:Bash+perm"]);
    const woke = [user("u1"), text("a"), end("e1"), tool("Bash", { id: "w1" })];
    expect(shape(buildRows(buildTurns(woke), { fold: () => undefined, working: true }))).toEqual(["user:u1", "header(folded 0)", "final:a", "live(w1,1)", "tool:Bash"]);
  });

  it("consecutive user messages share a turn; items before any user message form one", () => {
    const items = [item("commandOutput", { id: "c0" }), end("e0"), user("u1"), user("u2"), text("a")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.user])).toEqual([
      ["c0", []],
      ["u1", ["u1", "u2"]],
    ]);
  });

  it("a system note stands alone between turns: the copied history folds above it, the fork's turns follow", () => {
    const items = [user("u1"), tool("Bash"), text("a"), end("e1"), item("note", { id: "n" }), user("u2"), text("b")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.end])).toEqual([
      ["u1", "e1"],
      ["n", ""],
      ["u2", ""],
    ]);
    expect(shape(buildRows(turns, { fold: () => undefined, working: true }))).toEqual(["user:u1", "header(folded 1)", "final:a", "system:n", "user:u2", "live(u2,0)", "final:b"]);
  });

  it("a system note ends a turn that was cut short; a fork with nothing else shows the note (no header of its own), then a live header while it starts", () => {
    const cut = [user("u1"), tool("Bash"), item("note", { id: "n" })];
    expect(buildTurns(cut).map((t) => t.key)).toEqual(["u1", "n"]);
    expect(shape(buildRows(buildTurns(cut), open))).toEqual(["user:u1", "tool:Bash", "system:n"]);
    expect(shape(buildRows(buildTurns([item("note", { id: "n" })]), open))).toEqual(["system:n"]);
    expect(shape(buildRows(buildTurns([item("note", { id: "n" })]), { fold: () => undefined, working: true }))).toEqual(["system:n", "live(,0)"]);
  });

  it("a message sent while the turn runs is a steer inside it: one turn, one header, the steer stays when it folds", () => {
    const items = [user("u1"), tool("Bash"), user("s1"), tool("Bash"), text("a"), end("e1")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.user, t.end])).toEqual([["u1", ["u1"], "e1"]]);
    expect(shape(buildRows(turns, expanded))).toEqual(["user:u1", "header", "tool:Bash", "steer:s1", "tool:Bash", "final:a"]);
    const rows = buildRows(turns, open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 2)", "steer:s1", "final:a"]);
    // Steps are the work rows only; the finals are the final text.
    expect(rows.flatMap((r) => (r.type === "header" ? [[r.steps, r.finals]] : []))).toEqual([[2, ["a"]]]);
  });

  it("while it runs, the steer sits in the open turn and the live header counts from the turn's message", () => {
    const items = [user("u1"), tool("Bash"), user("s1")];
    expect(shape(buildRows(buildTurns(items), { fold: () => undefined, working: true }))).toEqual(["user:u1", "live(u1,1)", "tool:Bash", "steer:s1"]);
  });

  it("a steer then an interrupt: the turn_end after the steer closes the whole turn", () => {
    const items = [user("u1"), tool("Bash"), user("s1"), tool("Bash", { toolStatus: "error" }), end("e1"), user("u2"), text("b"), end("e2")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.end])).toEqual([
      ["u1", "e1"],
      ["u2", "e2"],
    ]);
    const rows = buildRows(turns, open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 2)", "steer:s1", "user:u2", "header(folded 0)", "final:b"]);
    // Interrupted with no final text: nothing to copy.
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([[], ["b"]]);
  });

  it("two steers stay in order in one turn", () => {
    const items = [user("u1"), item("thinking"), tool("Edit"), user("s1"), tool("Bash"), user("s2"), text("a"), end("e1")];
    const turns = buildTurns(items);
    expect(turns).toHaveLength(1);
    expect(shape(buildRows(turns, expanded))).toEqual(["user:u1", "header", "thinking(1)", "tool:Edit", "steer:s1", "tool:Bash", "steer:s2", "final:a"]);
    expect(shape(buildRows(turns, open))).toEqual(["user:u1", "header(folded 3)", "steer:s1", "steer:s2", "final:a"]);
  });

  it("a steer followed by the final text: the text after it is the turn's answer", () => {
    const items = [user("u1"), text("mid"), tool("Bash"), user("s1"), text("a1"), item("thinking"), text("a2"), end("e1")];
    const rows = buildRows(buildTurns(items), open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 3)", "steer:s1", "final:a1", "final:a2"]);
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([["a1", "a2"]]);
    // A steer right before the turn_end does not make earlier text final.
    const late = buildRows(buildTurns([user("u1"), tool("Bash"), text("a"), user("s1"), end("e1")]), open);
    expect(shape(late)).toEqual(["user:u1", "header(folded 2)", "steer:s1"]);
  });

  it("a message after a turn_end, a system note or a process that ended (an error) starts a turn", () => {
    const items = [
      user("u1"),
      text("a"),
      end("e1"),
      user("u2"),
      tool("Bash"),
      item("note", { id: "n" }),
      user("u3"),
      tool("Bash"),
      item("error", { id: "err" }),
      user("u4"),
      text("d"),
    ];
    expect(buildTurns(items).map((t) => [t.key, t.user])).toEqual([
      ["u1", ["u1"]],
      ["u2", ["u2"]],
      ["n", []],
      ["u3", ["u3"]],
      ["u4", ["u4"]],
    ]);
  });

  it("an empty thread has no rows, and a starting one only a live header", () => {
    expect(buildRows(buildTurns([]), open)).toEqual([]);
    expect(shape(buildRows(buildTurns([]), { fold: () => undefined, working: true }))).toEqual(["live(,0)"]);
  });
});

describe("timelineKey", () => {
  it("round-trips", () => {
    const it = tool("Bash", { parentToolUseId: "p", requestState: "pending", streaming: true });
    expect(decodeTimelineKey(timelineKey(it))).toEqual(it);
  });
});

describe("turnCostLabel", () => {
  it.each([
    [1.5, "$1.50"],
    [0.0123, "$0.01"],
    [0.005, "$0.01"],
    [0.0049, "<$0.01"],
    [0.00001, "<$0.01"],
    [0, ""],
    [-0.2, ""],
    [Number.NaN, ""],
    [null, ""],
  ])("%s → %s", (usd, want) => {
    expect(turnCostLabel(usd)).toBe(want);
  });
});
