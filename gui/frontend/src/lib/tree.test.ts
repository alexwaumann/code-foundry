import { describe, expect, it } from "vitest";
import { buildRows, rowCache, nextAfter, placeSession, sessionKey, sessionOrder, type ListSession } from "./tree";

const W = [
  { repoId: "r1", path: "/src/app" },
  { repoId: "r1", path: "/src/app.worktrees/feat" },
  { repoId: "r2", path: "/src/lib" },
];

describe("placeSession", () => {
  it.each([
    ["exact", "/src/app", W[0]],
    ["exact with trailing slash", "/src/app/", W[0]],
    ["nested", "/src/app/internal/daemon", W[0]],
    ["longest prefix wins", "/src/app.worktrees/feat/gui", W[1]],
    ["sibling with shared prefix is not a match", "/src/application", null],
    ["outside every worktree", "/tmp", null],
    ["empty", "", null],
  ])("%s", (_name, worktreePath, want) => {
    expect(placeSession({ worktreePath }, W)).toEqual(want);
  });
});

const thread = (id: string, over: Partial<ListSession> = {}): ListSession => ({ id, pinned: false, attention: "", ...over });

describe("buildRows (the flat thread list)", () => {
  it("lists threads newest first with no header", () => {
    expect(buildRows([thread("s1"), thread("s2"), thread("s3")]).map((r) => r.key)).toEqual([sessionKey("s3"), sessionKey("s2"), sessionKey("s1")]);
    expect(buildRows([])).toEqual([]);
  });

  it("puts pinned threads, then prompts, then finished turns, above the rest, with no headers", () => {
    const sessions = [
      thread("s1", { attention: "prompt" }),
      thread("s2", { pinned: true }),
      thread("s3"),
      thread("s4", { pinned: true, attention: "prompt" }),
      thread("s5", { attention: "done" }),
      thread("s6", { attention: "prompt" }),
      thread("s7"),
      thread("s8", { pinned: true, attention: "done" }),
    ];
    const rows = buildRows(sessions);
    expect(rows.map((r) => r.key)).toEqual([sessionKey("s8"), sessionKey("s4"), sessionKey("s2"), sessionKey("s6"), sessionKey("s1"), sessionKey("s5"), sessionKey("s7"), sessionKey("s3")]);
    expect(rows.map((r) => r.section)).toEqual(["pinned", "pinned", "pinned", "attention", "attention", "attention", "threads", "threads"]);
  });

  it("orders threads (cmd+1..9, cmd+shift+a) as shown", () => {
    const sessions = [thread("s1"), thread("s2", { attention: "done" }), thread("s3"), thread("s4", { attention: "prompt" })];
    expect(sessionOrder(sessions)).toEqual(["s4", "s2", "s3", "s1"]);
  });
});

describe("rowCache", () => {
  it("keeps row objects whose key and section are unchanged", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1"), thread("s2")]));
    const second = stable(buildRows([thread("s1"), thread("s2", { attention: "prompt" }), thread("s3")]));
    const byKey = (rows: ReturnType<typeof buildRows>, key: string) => rows.find((r) => r.key === key);
    expect(byKey(second, sessionKey("s1"))).toBe(byKey(first, sessionKey("s1")));
    // s2 moved into the attention group: a new object with the new section.
    expect(byKey(second, sessionKey("s2"))).not.toBe(byKey(first, sessionKey("s2")));
    expect(byKey(second, sessionKey("s2"))).toMatchObject({ section: "attention" });
    expect(second.map((r) => r.key)).toEqual([sessionKey("s2"), sessionKey("s3"), sessionKey("s1")]);
  });
});

describe("nextAfter", () => {
  const order = ["a", "b", "c", "d"];
  const pick = (id: string) => id === "b" || id === "d";
  it.each([
    ["from nothing: first match", null, "b"],
    ["from a match: the next one", "b", "d"],
    ["wraps", "d", "b"],
    ["from a non-match", "c", "d"],
    ["unknown current", "zz", "b"],
  ])("%s", (_name, current, want) => {
    expect(nextAfter(order, current, pick)).toBe(want);
  });
  it("null when nothing matches", () => {
    expect(nextAfter(order, "a", () => false)).toBeNull();
  });
});
