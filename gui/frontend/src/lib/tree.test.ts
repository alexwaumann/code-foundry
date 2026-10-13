import { describe, expect, it } from "vitest";
import { buildRows, buildSections, rowCache, nextAfter, placeSession, sessionKey, sessionOrder, type ListSession, type Row } from "./tree";

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

const thread = (id: string, over: Partial<ListSession> = {}): ListSession => ({ id, pinned: false, group: "idle", archivedAtMs: null, ...over });

/** The row key per row, a header as "# <label> <count>" (and its state). */
function shape(rows: readonly Row[]): string[] {
  return rows.map((r) => (r.kind === "session" ? r.key : `# ${r.label} ${String(r.count)}${r.collapsed ? " (collapsed)" : ""}`));
}

const s = (...ids: string[]) => ids.map(sessionKey);

describe("buildRows (the flat thread list)", () => {
  it("lists idle threads newest first with no header", () => {
    expect(shape(buildRows([thread("s1"), thread("s2"), thread("s3")]))).toEqual(s("s3", "s2", "s1"));
  });

  // Creation order s1..s12; every group newest first.
  const all = [
    thread("s1", { group: "prompt" }),
    thread("s2", { pinned: true, group: "working" }), // pinned working: at the top, not under Working
    thread("s3", { group: "idle" }),
    thread("s4", { group: "error" }),
    thread("s5", { group: "working" }),
    thread("s6", { group: "done" }),
    thread("s7", { group: "prompt" }),
    thread("s8", { pinned: true, group: "idle" }),
    thread("s9", { group: "working" }),
    thread("s10", { group: "error" }),
    thread("s11", { pinned: true, group: "prompt" }),
    thread("s12", { group: "idle" }),
  ];

  it("orders pinned, prompts then errors, finished, idle, then Working", () => {
    const rows = buildRows(all);
    expect(shape(rows)).toEqual([...s("s11", "s8", "s2"), ...s("s7", "s1", "s10", "s4"), ...s("s6"), ...s("s12", "s3"), "# Working 2", ...s("s9", "s5")]);
    expect(rows.map((r) => r.section)).toEqual(["pinned", "pinned", "pinned", "attention", "attention", "attention", "attention", "done", "idle", "idle", "working", "working", "working"]);
  });

  it("collapsed: the Working header stays with its count, its rows are gone", () => {
    const rows = buildRows(all, { workingCollapsed: true });
    expect(shape(rows)).toEqual([...s("s11", "s8", "s2", "s7", "s1", "s10", "s4", "s6", "s12", "s3"), "# Working 2 (collapsed)"]);
    // A pinned working thread is never hidden.
    expect(rows.some((r) => r.key === sessionKey("s2"))).toBe(true);
  });

  it("has the Working header only when a thread is working, collapsed or not", () => {
    for (const workingCollapsed of [false, true]) {
      expect(shape(buildRows([thread("s1", { group: "prompt" }), thread("s2", { pinned: true, group: "working" })], { workingCollapsed }))).toEqual(s("s2", "s1"));
    }
    expect(shape(buildRows([thread("s1", { group: "working" })]))).toEqual(["# Working 1", sessionKey("s1")]);
    expect(buildRows([])).toEqual([]);
  });

  it("orders threads (cmd+1..9, cmd+shift+a) as shown, the header skipped, collapsed rows absent", () => {
    const sessions = [thread("s1"), thread("s2", { group: "done" }), thread("s3", { group: "working" }), thread("s4", { group: "prompt" }), thread("s5", { group: "error" })];
    expect(sessionOrder(sessions)).toEqual(["s4", "s5", "s2", "s1", "s3"]);
    expect(sessionOrder(sessions, { workingCollapsed: true })).toEqual(["s4", "s5", "s2", "s1"]);
  });
});

describe("buildSections (main list, Working and Archived footers)", () => {
  const sessions = [
    thread("s1", { group: "prompt" }),
    thread("s2", { group: "working" }),
    thread("s3", { archivedAtMs: 3000 }),
    thread("s4", { pinned: true, group: "working", archivedAtMs: 1000 }), // defensively: pinned and archived is archived
    thread("s5"),
    thread("s6", { group: "prompt", archivedAtMs: 2000 }), // waiting on the user, archived: under Archived only
    thread("s7", { group: "working" }),
    thread("s8", { archivedAtMs: 3000 }), // same archive time as s3: newer created first
  ];

  it("splits the threads into the main list and the two footers, archived threads only under Archived, most recently archived first", () => {
    const { main, working, archived } = buildSections(sessions);
    expect(shape(main)).toEqual(s("s1", "s5"));
    expect(shape(working)).toEqual(["# Working 2", ...s("s7", "s2")]);
    expect(shape(archived)).toEqual(["# Archived 4", ...s("s8", "s3", "s6", "s4")]);
    expect(archived.map((r) => r.section)).toEqual(["archived", "archived", "archived", "archived", "archived"]);
    expect(shape(buildRows(sessions))).toEqual([...shape(main), ...shape(working), ...shape(archived)]);
  });

  it("collapsed: each footer keeps its header and count, its rows are gone", () => {
    const { working, archived } = buildSections(sessions, { workingCollapsed: true, archivedCollapsed: true });
    expect(shape(working)).toEqual(["# Working 2 (collapsed)"]);
    expect(shape(archived)).toEqual(["# Archived 4 (collapsed)"]);
    expect(shape(buildSections(sessions, { archivedCollapsed: true }).working)).toEqual(["# Working 2", ...s("s7", "s2")]);
  });

  it("has a footer only when it has threads", () => {
    expect(buildSections([thread("s1"), thread("s2", { group: "working" })]).archived).toEqual([]);
    expect(buildSections([thread("s1", { archivedAtMs: 5 })])).toEqual({ main: [], working: [], archived: [expect.objectContaining({ key: "h:archived", count: 1 }), expect.objectContaining({ key: sessionKey("s1") })] });
    expect(buildSections([])).toEqual({ main: [], working: [], archived: [] });
  });

  it("orders threads (cmd+1..9, cmd+shift+a, arrows) across main, Working and Archived; collapsed rows absent", () => {
    expect(sessionOrder(sessions)).toEqual(["s1", "s5", "s7", "s2", "s8", "s3", "s6", "s4"]);
    expect(sessionOrder(sessions, { archivedCollapsed: true })).toEqual(["s1", "s5", "s7", "s2"]);
    expect(sessionOrder(sessions, { workingCollapsed: true })).toEqual(["s1", "s5", "s8", "s3", "s6", "s4"]);
  });
});

describe("rowCache", () => {
  const byKey = (rows: readonly Row[], key: string) => rows.find((r) => r.key === key);

  it("keeps row objects whose key and section are unchanged", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1"), thread("s2")]));
    const second = stable(buildRows([thread("s1"), thread("s2", { group: "prompt" }), thread("s3")]));
    expect(byKey(second, sessionKey("s1"))).toBe(byKey(first, sessionKey("s1")));
    // s2 moved into the attention group: a new object with the new section.
    expect(byKey(second, sessionKey("s2"))).not.toBe(byKey(first, sessionKey("s2")));
    expect(byKey(second, sessionKey("s2"))).toMatchObject({ section: "attention" });
    expect(second.map((r) => r.key)).toEqual(s("s2", "s3", "s1"));
  });

  it("re-creates the Working header when its count or state changes, and only the rows that moved", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1", { group: "working" }), thread("s2"), thread("s3", { group: "working" })]));
    // s2 starts working: the header's count changes and s2 moves; s1 and s3 stay.
    const second = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" })]));
    expect(byKey(second, "h:working")).not.toBe(byKey(first, "h:working"));
    expect(byKey(second, "h:working")).toMatchObject({ count: 3, collapsed: false });
    expect(byKey(second, sessionKey("s2"))).not.toBe(byKey(first, sessionKey("s2")));
    for (const key of [sessionKey("s1"), sessionKey("s3")]) expect(byKey(second, key), key).toBe(byKey(first, key));
    // Nothing changed: every object is reused.
    const same = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" })]));
    same.forEach((r, i) => {
      expect(r).toBe(second[i]);
    });
    // Collapsing: a new header object; the row above is new (s4), nothing else is shown.
    const collapsed = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" }), thread("s4")], { workingCollapsed: true }));
    expect(byKey(collapsed, "h:working")).toMatchObject({ count: 3, collapsed: true });
    expect(byKey(collapsed, "h:working")).not.toBe(byKey(same, "h:working"));
    expect(shape(collapsed)).toEqual([sessionKey("s4"), "# Working 3 (collapsed)"]);
  });

  it("archiving a thread moves only that row (a new object in the archived section)", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1"), thread("s2"), thread("s3", { archivedAtMs: 1 })]));
    const second = stable(buildRows([thread("s1"), thread("s2", { archivedAtMs: 2 }), thread("s3", { archivedAtMs: 1 })]));
    expect(shape(second)).toEqual([sessionKey("s1"), "# Archived 2", ...s("s2", "s3")]);
    expect(byKey(second, sessionKey("s1"))).toBe(byKey(first, sessionKey("s1")));
    expect(byKey(second, sessionKey("s3"))).toBe(byKey(first, sessionKey("s3")));
    expect(byKey(second, sessionKey("s2"))).toMatchObject({ section: "archived" });
    expect(byKey(second, "h:archived")).not.toBe(byKey(first, "h:archived"));
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
