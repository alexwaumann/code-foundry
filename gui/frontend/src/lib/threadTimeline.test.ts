import { describe, expect, it } from "vitest";
import { buildRows, buildTurns, decodeTimelineKey, groupLabel, timelineKey, type TimelineItem, type TimelineRow } from "./threadTimeline";

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
      case "footer":
        return `footer${r.folded ? `(folded ${String(r.hidden)})` : ""}`;
      case "working":
        return `working(${r.since})`;
      case "note":
        return `note:${r.kind}`;
      default:
        return `${r.type}:${r.id}`;
    }
  });
}

const open = { fold: () => undefined, working: false };

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
    const rows = buildRows(buildTurns(items), open);
    expect(shape(rows)).toEqual(["user:u1", "thinking(1)", "group(Read,Grep,Read)", "thinking(1)", "tool:Bash", "final:t1", "footer"]);
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

  it("folds finished turns except the latest; final text, notes and the footer stay", () => {
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
    expect(shape(rows)).toEqual(["user:u1", "note:error", "final:a1", "final:a2", "footer(folded 5)", "user:u2", "tool:Bash", "final:b1", "footer"]);
    expect(rows.flatMap((r) => (r.type === "footer" ? [r.finals] : []))).toEqual([["a1", "a2"], ["b1"]]);
    // The user's choice wins both ways.
    const fold = (k: string) => (k === "u1" ? false : k === "u2" ? true : undefined);
    expect(shape(buildRows(turns, { fold, working: false }))).toEqual([
      "user:u1",
      "thinking(1)",
      "group(Read,Read)",
      "text:mid",
      "tool:Edit",
      "note:error",
      "final:a1",
      "thinking(1)",
      "final:a2",
      "footer",
      "user:u2",
      "final:b1",
      "footer(folded 1)",
    ]);
  });

  it("the running turn never folds; a new turn folds the one before it", () => {
    const items = [user("u1"), tool("Bash"), text("a"), end("e1"), user("u2"), tool("Read")];
    expect(shape(buildRows(buildTurns(items), { fold: () => undefined, working: true }))).toEqual(["user:u1", "final:a", "footer(folded 1)", "user:u2", "tool:Read", "working(u2)"]);
    // Nothing runs after a turn_end: no working row even when the thread says busy.
    expect(shape(buildRows(buildTurns(items.slice(0, 4)), { fold: () => undefined, working: true }))).toEqual(["user:u1", "tool:Bash", "final:a", "footer"]);
  });

  it("consecutive user messages share a turn; items before any user message form one", () => {
    const items = [item("commandOutput", { id: "c0" }), end("e0"), user("u1"), user("u2"), text("a")];
    const turns = buildTurns(items);
    expect(turns.map((t) => [t.key, t.user])).toEqual([
      ["c0", []],
      ["u1", ["u1", "u2"]],
    ]);
  });

  it("an empty thread has no rows, and a starting one only the working row", () => {
    expect(buildRows(buildTurns([]), open)).toEqual([]);
    expect(shape(buildRows(buildTurns([]), { fold: () => undefined, working: true }))).toEqual(["working()"]);
  });
});

describe("timelineKey", () => {
  it("round-trips", () => {
    const it = tool("Bash", { parentToolUseId: "p", requestState: "pending", streaming: true });
    expect(decodeTimelineKey(timelineKey(it))).toEqual(it);
  });
});
