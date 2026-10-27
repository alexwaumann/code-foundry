import { describe, expect, it } from "vitest";
import { buildRows, buildTurns, decodeTimelineKey, groupLabel, linkRepeatShows, stripRuns, timelineKey, turnCostLabel, type TimelineItem, type TimelineRow, type WorkNode } from "./threadTimeline";

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
      case "strip":
        return `strip(${String(r.steps)})[${shape(r.nodes).join(" ")}]`;
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

  it("folds every finished turn, the latest included, under its header; every text and the notes stay", () => {
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
    expect(shape(rows)).toEqual(["user:u1", "header(folded 4)", "text:mid", "note:error", "final:a1", "final:a2", "user:u2", "header(folded 1)", "final:b1"]);
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([["a1", "a2"], ["b1"]]);
    // Every finished turn's header counts its steps (open or folded) and carries its turn_end.
    expect(rows.flatMap((r) => (r.type === "header" ? [[r.key, r.id, r.turn, r.steps, r.folded]] : []))).toEqual([
      ["h:u1", "e1", "u1", 4, true],
      ["h:u2", "e2", "u2", 1, true],
    ]);
    // The answer's copy action sits on its first final text row and copies all of it.
    expect(rows.flatMap((r) => (r.type === "text" ? [[r.id, r.answer]] : []))).toEqual([
      ["mid", ""],
      ["a1", "a1\na2"],
      ["a2", ""],
      ["b1", "b1"],
    ]);
    // The user's choice wins both ways: the latest turn reopened, then an older one.
    expect(shape(buildRows(turns, { fold: (k) => (k === "u2" ? false : undefined), working: false }))).toEqual([
      "user:u1",
      "header(folded 4)",
      "text:mid",
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

  it("a restart's note between turns stays apart: the next message starts a turn, not a steer", () => {
    const items = [user("u1"), text("a"), end("e1"), item("commandOutput", { id: "r" }), user("u2"), text("b"), end("e2")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.user, t.end])).toEqual([
      ["u1", ["u1"], "e1"],
      ["r", [], ""],
      ["u2", ["u2"], "e2"],
    ]);
    expect(shape(buildRows(turns, { fold: () => undefined, working: false }))).toEqual(["user:u1", "header(folded 0)", "final:a", "note:commandOutput", "user:u2", "header(folded 0)", "final:b"]);
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

  it("a folded turn keeps every text in its place under the header; text is no step (thread-fold-5-text-and-html)", () => {
    const items = [user("u1"), text("t1"), tool("Bash"), text("t2"), tool("Edit"), text("t3"), end("e1")];
    const rows = buildRows(buildTurns(items), open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 2)", "text:t1", "text:t2", "final:t3"]);
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([["t3"]]);
    // Folded by the reader: the same; unfolded: the work comes back between the texts.
    expect(shape(buildRows(buildTurns(items), { fold: () => true, working: false }))).toEqual(shape(rows));
    expect(shape(buildRows(buildTurns(items), expanded))).toEqual(["user:u1", "header", "text:t1", "tool:Bash", "text:t2", "tool:Edit", "final:t3"]);
  });

  it("a steer followed by the final text: the text after it is the turn's answer", () => {
    const items = [user("u1"), text("mid"), tool("Bash"), user("s1"), text("a1"), item("thinking"), text("a2"), end("e1")];
    const rows = buildRows(buildTurns(items), open);
    expect(shape(rows)).toEqual(["user:u1", "header(folded 2)", "text:mid", "steer:s1", "final:a1", "final:a2"]);
    expect(rows.flatMap((r) => (r.type === "header" ? [r.finals] : []))).toEqual([["a1", "a2"]]);
    // A steer right before the turn_end does not make earlier text final.
    const late = buildRows(buildTurns([user("u1"), tool("Bash"), text("a"), user("s1"), end("e1")]), open);
    expect(shape(late)).toEqual(["user:u1", "header(folded 1)", "text:a", "steer:s1"]);
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

describe("live tool strip (stripRuns)", () => {
  /** The live turn with strips on. */
  const live = { fold: () => undefined, working: true, strips: true };
  const strips = (rows: readonly TimelineRow[]) => rows.filter((r): r is Extract<WorkNode, { type: "strip" }> => r.type === "strip");

  // The live header's count is the turn's (thinking included, text not); a strip's counts tools and groups only.
  it.each<[string, () => TimelineItem[], string[]]>([
    [
      "text breaks a run; each run of two steps or more is one strip",
      () => [user("u1"), tool("Bash"), tool("Edit"), text("a"), tool("Bash"), tool("Write"), tool("Bash")],
      ["user:u1", "live(u1,5)", "strip(2)[tool:Bash tool:Edit]", "text:a", "strip(3)[tool:Bash tool:Write tool:Bash]"],
    ],
    ["a run of one step is not stripped", () => [user("u1"), tool("Bash"), text("a"), tool("Edit")], ["user:u1", "live(u1,2)", "tool:Bash", "text:a", "tool:Edit"]],
    [
      "thinking is absorbed into a run but is no step: one step and thinking stay rows",
      () => [user("u1"), item("thinking"), tool("Bash"), item("thinking"), text("a"), item("thinking"), tool("Bash"), tool("Edit"), item("thinking")],
      ["user:u1", "live(u1,7)", "thinking(1)", "tool:Bash", "thinking(1)", "text:a", "strip(2)[thinking(1) tool:Bash tool:Edit thinking(1)]"],
    ],
    [
      "a group and an Agent count as one step each",
      () => [user("u1"), tool("Read"), tool("Grep"), tool("Read"), tool("Agent", { toolUseId: "tu-ag" }), tool("Bash", { parentToolUseId: "tu-ag" }), tool("Bash", { parentToolUseId: "tu-ag" })],
      ["user:u1", "live(u1,2)", "strip(2)[group(Read,Grep,Read) tool:Agent[tool:Bash tool:Bash]]"],
    ],
    [
      "a steer breaks a run",
      () => [user("u1"), tool("Bash"), tool("Edit"), user("s1"), tool("Bash"), tool("Bash")],
      ["user:u1", "live(u1,4)", "strip(2)[tool:Bash tool:Edit]", "steer:s1", "strip(2)[tool:Bash tool:Bash]"],
    ],
    [
      "a tool with a permission request breaks out; the next call starts a new run",
      () => [
        user("u1"),
        tool("Bash"),
        tool("Edit"),
        tool("Bash", { toolUseId: "tu-p", toolStatus: "running" }),
        item("permission", { id: "p1", toolUseId: "tu-p", name: "Bash", requestState: "denied" }),
        tool("Bash"),
        tool("Bash"),
      ],
      ["user:u1", "live(u1,5)", "strip(2)[tool:Bash tool:Edit]", "tool:Bash+perm", "strip(2)[tool:Bash tool:Bash]"],
    ],
    [
      "a permission row (denied before the tool ran) and a question break the run",
      () => [
        user("u1"),
        tool("Bash"),
        tool("Bash"),
        item("permission", { id: "p2", toolUseId: "", name: "Write", requestState: "denied" }),
        tool("Bash"),
        tool("Bash"),
        tool("AskUserQuestion", { toolUseId: "tu-q" }),
        item("question", { id: "q1", toolUseId: "tu-q", requestState: "allowed" }),
        tool("Bash"),
        tool("Bash"),
      ],
      ["user:u1", "live(u1,8)", "strip(2)[tool:Bash tool:Bash]", "permission:p2", "strip(2)[tool:Bash tool:Bash]", "question:q1", "strip(2)[tool:Bash tool:Bash]"],
    ],
    [
      "a failed tool stays inside the strip",
      () => [user("u1"), tool("Bash", { toolStatus: "error" }), tool("Bash")],
      ["user:u1", "live(u1,2)", "strip(2)[tool:Bash tool:Bash]"],
    ],
    [
      "a note breaks a run",
      () => [user("u1"), tool("Bash"), tool("Bash"), item("compaction"), tool("Bash"), tool("Bash")],
      ["user:u1", "live(u1,4)", "strip(2)[tool:Bash tool:Bash]", "note:compaction", "strip(2)[tool:Bash tool:Bash]"],
    ],
  ])("%s", (_, items, want) => {
    expect(shape(buildRows(buildTurns(items()), live))).toEqual(want);
  });

  it("the latest step is the last tool or group, never thinking", () => {
    const items = [user("u1"), tool("Bash", { id: "b1" }), tool("Read", { id: "r1" }), tool("Grep", { id: "g1" }), item("thinking")];
    const [s] = strips(buildRows(buildTurns(items), live));
    expect(s?.latest).toMatchObject({ type: "group", ids: ["r1", "g1"] });
    expect(s?.steps).toBe(2);
  });

  it("the expanded state's key is the run's first item and holds while the run grows (a lone Read turning into a group included)", () => {
    const items = [user("u1"), text("a"), tool("Read", { id: "r1" }), tool("Bash", { id: "b1" })];
    const keyOf = (its: TimelineItem[]) => strips(buildRows(buildTurns(its), live)).map((r) => r.expandKey);
    expect(keyOf(items)).toEqual(["strip:r1"]);
    expect(keyOf([...items, tool("Edit")])).toEqual(["strip:r1"]);
    // The first node changes from a tool row to a group: the key stays its first item.
    const reads = [user("u1"), tool("Read", { id: "r2" }), tool("Read"), tool("Bash")];
    expect(keyOf(reads)).toEqual(["strip:r2"]);
    const thinkingFirst = [user("u1"), item("thinking", { id: "th1" }), tool("Bash"), tool("Bash")];
    expect(keyOf(thinkingFirst)).toEqual(["strip:th1"]);
    expect(keyOf([...thinkingFirst, item("thinking"), tool("Bash")])).toEqual(["strip:th1"]);
  });

  it("the row key is the first node's, so that node's row takes the strip's place when the turn ends", () => {
    const running = [user("u1"), text("a"), item("thinking", { id: "th1" }), tool("Bash", { id: "b1" }), tool("Edit", { id: "e1" })];
    const live1 = buildRows(buildTurns(running), live);
    expect(strips(live1).map((r) => r.key)).toEqual(["th:th1"]);
    const done = buildRows(buildTurns([...running, text("b"), end("x")]), { fold: () => false, working: false, strips: false });
    expect(done.map((r) => r.key)).toContain("th:th1");
    expect(strips(buildRows(buildTurns([user("u1"), tool("Bash", { id: "b2" }), tool("Bash")]), live)).map((r) => r.key)).toEqual(["b2"]);
  });

  it("stays on while a request waits (working is false); only the open turn gets strips", () => {
    const items = [user("u1"), tool("Bash"), tool("Bash"), text("a"), end("e1"), user("u2"), tool("Bash"), tool("Edit"), tool("Bash", { toolUseId: "tu-p", toolStatus: "running" }), item("permission", { toolUseId: "tu-p", requestState: "pending" })];
    const rows = buildRows(buildTurns(items), { fold: () => false, working: false, strips: true });
    expect(shape(rows)).toEqual(["user:u1", "header", "tool:Bash", "tool:Bash", "final:a", "user:u2", "strip(2)[tool:Bash tool:Edit]", "tool:Bash+perm"]);
  });

  it("finished turns, a turn without strips on, and the subagent's nested rows are unchanged", () => {
    const running = [user("u1"), tool("Bash"), tool("Edit"), text("a"), tool("Agent", { toolUseId: "tu-ag" }), tool("Bash", { parentToolUseId: "tu-ag" }), tool("Bash", { parentToolUseId: "tu-ag" }), tool("Bash")];
    expect(shape(buildRows(buildTurns(running), { fold: () => undefined, working: true }))).toEqual(["user:u1", "live(u1,4)", "tool:Bash", "tool:Edit", "text:a", "tool:Agent[tool:Bash tool:Bash]", "tool:Bash"]);
    const done = buildTurns([...running, text("b"), end("e1")]);
    for (const fold of [() => undefined, () => false]) {
      expect(buildRows(done, { fold, working: true, strips: true })).toEqual(buildRows(done, { fold, working: true }));
    }
    expect(shape(buildRows(done, { fold: () => false, working: false, strips: true }))).toEqual([
      "user:u1",
      "header",
      "tool:Bash",
      "tool:Edit",
      "text:a",
      "tool:Agent[tool:Bash tool:Bash]",
      "tool:Bash",
      "final:b",
    ]);
  });
});

describe("timelineKey", () => {
  it("round-trips", () => {
    const it = tool("Bash", { parentToolUseId: "p", requestState: "pending", streaming: true, page: "" });
    expect(decodeTimelineKey(timelineKey(it))).toEqual(it);
    const page = item("html", { page: "/Users/dev/repo/docs/a.html" });
    expect(decodeTimelineKey(timelineKey(page))).toEqual(page);
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

describe("theme cards (theme items)", () => {
  it("stay in a folded turn, are no step, and break a live strip's run", () => {
    const items = [user("u1"), tool("Bash"), item("theme", { id: "c" }), text("a"), end("e1")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 1)", "theme:c", "final:a"]);
    const live = [user("u1"), tool("Bash"), tool("Write"), item("theme", { id: "c" }), tool("Bash"), tool("Read", { toolStatus: "running" })];
    expect(shape(buildRows(buildTurns(live), { fold: () => undefined, working: true, strips: true }))).toEqual([
      "user:u1",
      "live(u1,4)",
      "strip(2)[tool:Bash tool:Write]",
      "theme:c",
      "strip(2)[tool:Bash tool:Read]",
    ]);
  });

  it("saved between turns: no turn of their own, and the next message starts one", () => {
    const items = [user("u1"), end("e1"), item("theme", { id: "c" }), user("u2"), text("b"), end("e2")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 0)", "theme:c", "user:u2", "header(folded 0)", "final:b"]);
  });
});

describe("inline pages (html items)", () => {
  it("stay in a folded turn as they are; no step", () => {
    const items = [user("u1"), tool("Write"), item("html", { id: "h" }), text("a"), end("e1")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 1)", "html:h", "final:a"]);
    expect(shape(buildRows(buildTurns(items), expanded))).toEqual(["user:u1", "header", "tool:Write", "html:h", "final:a"]);
  });

  it("are the same node whatever the turn's fold: by default at its end, by the reader, or unfolded (thread-fold-5-text-and-html)", () => {
    const items = [user("u1"), tool("Write"), item("html", { id: "h" }), text("a"), end("e1")];
    const node = (fold: () => boolean | undefined) => buildRows(buildTurns(items), { fold, working: false }).find((r) => r.type === "html");
    const want = { type: "html", key: "h", id: "h", page: "", later: "" };
    expect(node(() => undefined)).toEqual(want);
    expect(node(() => true)).toEqual(want);
    expect(node(() => false)).toEqual(want);
  });

  it("break a live strip's run and show on their own", () => {
    const items = [user("u1"), tool("Bash"), tool("Write"), item("html", { id: "h" }), tool("Bash"), tool("Read", { toolStatus: "running" })];
    const rows = buildRows(buildTurns(items), { fold: () => undefined, working: true, strips: true });
    expect(shape(rows)).toEqual(["user:u1", "live(u1,4)", "strip(2)[tool:Bash tool:Write]", "html:h", "strip(2)[tool:Bash tool:Read]"]);
  });

  it("do not end the answer: text after a page is the final text", () => {
    const items = [user("u1"), text("before"), item("html", { id: "h" }), text("after"), end("e1")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 0)", "text:before", "html:h", "final:after"]);
  });

  it("shown between turns: no turn, no header, never folded (inline-html-2-fixes)", () => {
    const items = [user("u1"), text("a"), end("e1"), item("html", { id: "h" }), item("html", { id: "h2" })];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 0)", "final:a", "html:h", "html:h2"]);
    // Folding every turn leaves them open: they are in none.
    expect(shape(buildRows(buildTurns(items), { fold: () => true, working: false }))).toEqual(["user:u1", "header(folded 0)", "final:a", "html:h", "html:h2"]);
    // Before the thread's first message too.
    expect(shape(buildRows(buildTurns([item("html", { id: "h" })]), open))).toEqual(["html:h"]);
  });

  it("shown between turns: the next message starts a turn of its own, not a steer", () => {
    const items = [user("u1"), end("e1"), item("html", { id: "h" }), user("u2"), tool("Bash"), text("b"), end("e2")];
    expect(shape(buildRows(buildTurns(items), open))).toEqual(["user:u1", "header(folded 0)", "html:h", "user:u2", "header(folded 1)", "final:b"]);
  });

  it("shown again: only the latest show of a page is a card, the earlier ones link to it (inline-page-shows)", () => {
    const A = "/Users/dev/repo/docs/a.html";
    const B = "/Users/dev/repo/docs/b.html";
    const page = (id: string, p: string) => item("html", { id, page: p });
    const items = [user("u1"), page("a1", A), page("b1", B), text("t1"), end("e1"), user("u2"), page("a2", A), text("t2"), end("e2"), page("a3", A)];
    const rows = buildRows(buildTurns(items), open);
    const pages = rows.flatMap((r) => (r.type === "html" ? [`${r.id}${r.later ? `->${r.later}` : ""}`] : []));
    expect(pages).toEqual(["a1->a3", "b1", "a2->a3", "a3"]);
    // Folded or not, inside a turn or between turns: the same rule.
    const unfolded = buildRows(buildTurns(items), expanded).flatMap((r) => (r.type === "html" ? [r.later] : []));
    expect(unfolded).toEqual(["a3", "", "a3", ""]);
  });

  it("shown again while the turn runs: the earlier card turns into a link as the new show arrives, in the live turn's strips too", () => {
    const A = "/Users/dev/repo/docs/a.html";
    const before = [user("u1"), tool("Write"), item("html", { id: "a1", page: A }), tool("Edit"), tool("Bash")];
    const live = { fold: () => undefined, working: true, strips: true };
    const html = (rows: TimelineRow[]) => rows.flatMap((r) => (r.type === "html" ? [[r.id, r.later]] : []));
    expect(html(buildRows(buildTurns(before), live))).toEqual([["a1", ""]]);
    const after = [...before, item("html", { id: "a2", page: A })];
    expect(html(buildRows(buildTurns(after), live))).toEqual([
      ["a1", "a2"],
      ["a2", ""],
    ]);
  });

  it("linkRepeatShows keeps rows (and the list) by identity when nothing links, and leaves pathless pages alone", () => {
    const rows: TimelineRow[] = [
      { type: "html", key: "a", id: "a", page: "/x.html", later: "" },
      { type: "html", key: "b", id: "b", page: "/y.html", later: "" },
      { type: "html", key: "c", id: "c", page: "", later: "" },
      { type: "html", key: "d", id: "d", page: "", later: "" },
    ];
    expect(linkRepeatShows(rows)).toBe(rows);
    const again: TimelineRow[] = [...rows, { type: "html", key: "e", id: "e", page: "/x.html", later: "" }];
    const out = linkRepeatShows(again);
    expect(out).not.toBe(again);
    expect(out[0]).toEqual({ type: "html", key: "a", id: "a", page: "/x.html", later: "e" });
    expect(out.slice(1)).toEqual(again.slice(1));
    expect(out[1]).toBe(again[1]);
    // A link that no longer applies (its later show went) is a card again.
    expect(linkRepeatShows([{ type: "html", key: "a", id: "a", page: "/x.html", later: "e" }])[0]).toMatchObject({ later: "" });
    // stripRuns leaves pages as they are (they break runs).
    expect(stripRuns(out as WorkNode[])).toEqual(out);
  });

  it("shown between turns while a new one starts: the live header follows the page", () => {
    const items = [user("u1"), end("e1"), item("html", { id: "h" })];
    expect(shape(buildRows(buildTurns(items), { fold: () => undefined, working: true }))).toEqual(["user:u1", "header(folded 0)", "html:h", "live(,0)"]);
  });
});
