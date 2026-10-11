import { describe, expect, it } from "vitest";
import { buildRows, leafOrder, rowCache, nextAfter, ownedTerminalIds, placeTerminal, sessionKey, sessionOrder, terminalKey, type ListSession, type PlaceableTerminal, type Row } from "./tree";

const W = [
  { repoId: "r1", path: "/src/app" },
  { repoId: "r1", path: "/src/app.worktrees/feat" },
  { repoId: "r2", path: "/src/lib" },
];

describe("placeTerminal", () => {
  it.each([
    ["label wins over cwd", { cwd: "/src/lib", worktreeLabel: "/src/app.worktrees/feat" }, W[1]],
    ["label with trailing slash", { cwd: "/tmp", worktreeLabel: "/src/app/" }, W[0]],
    ["unknown label falls back to cwd", { cwd: "/src/lib/x", worktreeLabel: "/gone" }, W[2]],
    ["exact cwd", { cwd: "/src/app", worktreeLabel: "" }, W[0]],
    ["nested cwd", { cwd: "/src/app/internal/daemon", worktreeLabel: "" }, W[0]],
    ["longest prefix wins", { cwd: "/src/app.worktrees/feat/gui", worktreeLabel: "" }, W[1]],
    ["sibling with shared prefix is not a match", { cwd: "/src/application", worktreeLabel: "" }, null],
    ["outside every worktree", { cwd: "/tmp", worktreeLabel: "" }, null],
    ["empty cwd", { cwd: "", worktreeLabel: "" }, null],
  ])("%s", (_name, t, want) => {
    expect(placeTerminal(t, W)).toEqual(want);
  });
});

const terms: PlaceableTerminal[] = [
  { id: "a", cwd: "/src/app", worktreeLabel: "" },
  { id: "b", cwd: "/tmp", worktreeLabel: "" },
  { id: "c", cwd: "/x", worktreeLabel: "/src/app.worktrees/feat", sessionLabel: "s9" }, // unknown session: shown
  { id: "f", cwd: "/src/lib", worktreeLabel: "", sessionLabel: "s2" }, // owned by label: hidden
];
const loose = terms[1] as PlaceableTerminal;

const thread = (id: string, over: Partial<ListSession> = {}): ListSession => ({ id, terminalId: "", pinned: false, group: "idle", ...over });

/** The row key per row, headers as "# Label" (the Working header with its count and state). */
function shape(rows: readonly Row[]): string[] {
  return rows.map((r) => (r.kind !== "header" ? r.key : r.section === "working" ? `# ${r.label} ${String(r.count)}${r.collapsed ? " (collapsed)" : ""}` : `# ${r.label}`));
}

const s = (...ids: string[]) => ids.map(sessionKey);

describe("buildRows (the flat thread list)", () => {
  it("lists idle threads newest first with no header, then loose terminals under Terminals", () => {
    const sessions = [thread("s1", { terminalId: "a" }), thread("s2"), thread("s3")];
    expect(shape(buildRows(sessions, terms))).toEqual([...s("s3", "s2", "s1"), "# Terminals", terminalKey("b"), terminalKey("c")]);
  });

  // Creation order s1..s10; every group newest first.
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

  it("orders pinned, prompts then errors, finished, idle, then Working, then Terminals", () => {
    const rows = buildRows(all, [loose]);
    expect(shape(rows)).toEqual([
      ...s("s11", "s8", "s2"),
      ...s("s7", "s1", "s10", "s4"),
      ...s("s6"),
      ...s("s12", "s3"),
      "# Working 2",
      ...s("s9", "s5"),
      "# Terminals",
      terminalKey("b"),
    ]);
    expect(rows.map((r) => r.section)).toEqual([
      "pinned",
      "pinned",
      "pinned",
      "attention",
      "attention",
      "attention",
      "attention",
      "done",
      "idle",
      "idle",
      "working",
      "working",
      "working",
      "terminals",
      "terminals",
    ]);
  });

  it("collapsed: the Working header stays with its count, its rows are gone", () => {
    const rows = buildRows(all, [loose], { workingCollapsed: true });
    expect(shape(rows)).toEqual([...s("s11", "s8", "s2", "s7", "s1", "s10", "s4", "s6", "s12", "s3"), "# Working 2 (collapsed)", "# Terminals", terminalKey("b")]);
    // A pinned working thread is never hidden.
    expect(rows.some((r) => r.key === sessionKey("s2"))).toBe(true);
  });

  it("has the Working header only when a thread is working, collapsed or not", () => {
    for (const workingCollapsed of [false, true]) {
      expect(shape(buildRows([thread("s1", { group: "prompt" }), thread("s2", { pinned: true, group: "working" })], [], { workingCollapsed }))).toEqual(s("s2", "s1"));
    }
    expect(shape(buildRows([thread("s1", { group: "working" })], []))).toEqual(["# Working 1", sessionKey("s1")]);
    expect(shape(buildRows([], [loose]))).toEqual(["# Terminals", terminalKey("b")]);
    expect(buildRows([], [])).toEqual([]);
  });

  it("ownedTerminalIds uses both terminal_id and labels.session", () => {
    expect([...ownedTerminalIds([thread("s1", { terminalId: "a" }), thread("s2")], terms)].sort()).toEqual(["a", "f"]);
  });

  it("orders leaves (cmd+1..9) and threads (cmd+shift+a) as shown, headers skipped, collapsed rows absent", () => {
    const sessions = [thread("s1"), thread("s2", { group: "done" }), thread("s3", { terminalId: "a", group: "working" }), thread("s4", { group: "prompt" }), thread("s5", { group: "error" })];
    expect(leafOrder(sessions, terms).map((r) => r.key)).toEqual(["s:s4", "s:s5", "s:s2", "s:s1", "s:s3", "t:b", "t:c"]);
    expect(sessionOrder(sessions, terms)).toEqual(["s4", "s5", "s2", "s1", "s3"]);
    expect(leafOrder(sessions, terms, { workingCollapsed: true }).map((r) => r.key)).toEqual(["s:s4", "s:s5", "s:s2", "s:s1", "t:b", "t:c"]);
    expect(sessionOrder(sessions, terms, { workingCollapsed: true })).toEqual(["s4", "s5", "s2", "s1"]);
  });
});

describe("rowCache", () => {
  const byKey = (rows: readonly Row[], key: string) => rows.find((r) => r.key === key);

  it("keeps row objects whose key and section are unchanged", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1"), thread("s2")], [loose]));
    const second = stable(buildRows([thread("s1"), thread("s2", { group: "prompt" }), thread("s3")], [loose]));
    expect(byKey(second, sessionKey("s1"))).toBe(byKey(first, sessionKey("s1")));
    expect(byKey(second, terminalKey("b"))).toBe(byKey(first, terminalKey("b")));
    expect(byKey(second, "h:terminals")).toBe(byKey(first, "h:terminals"));
    // s2 moved into the attention group: a new object with the new section.
    expect(byKey(second, sessionKey("s2"))).not.toBe(byKey(first, sessionKey("s2")));
    expect(byKey(second, sessionKey("s2"))).toMatchObject({ section: "attention" });
    expect(second.map((r) => r.key)).toEqual([...s("s2", "s3", "s1"), "h:terminals", terminalKey("b")]);
  });

  it("re-creates the Working header when its count or state changes, and only the rows that moved", () => {
    const stable = rowCache();
    const first = stable(buildRows([thread("s1", { group: "working" }), thread("s2"), thread("s3", { group: "working" })], [loose]));
    // s2 starts working: the header's count changes and s2 moves; s1, s3 and the terminal rows stay.
    const second = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" })], [loose]));
    expect(byKey(second, "h:working")).not.toBe(byKey(first, "h:working"));
    expect(byKey(second, "h:working")).toMatchObject({ count: 3, collapsed: false });
    expect(byKey(second, sessionKey("s2"))).not.toBe(byKey(first, sessionKey("s2")));
    for (const key of [sessionKey("s1"), sessionKey("s3"), "h:terminals", terminalKey("b")]) expect(byKey(second, key), key).toBe(byKey(first, key));
    // Nothing changed: every object is reused.
    const same = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" })], [loose]));
    same.forEach((r, i) => {
      expect(r).toBe(second[i]);
    });
    // Collapsing: a new header object; the rows above and the terminals are reused.
    const collapsed = stable(buildRows([thread("s1", { group: "working" }), thread("s2", { group: "working" }), thread("s3", { group: "working" }), thread("s4")], [loose], { workingCollapsed: true }));
    expect(byKey(collapsed, "h:working")).toMatchObject({ count: 3, collapsed: true });
    expect(byKey(collapsed, "h:working")).not.toBe(byKey(same, "h:working"));
    expect(byKey(collapsed, terminalKey("b"))).toBe(byKey(same, terminalKey("b")));
    expect(shape(collapsed)).toEqual([sessionKey("s4"), "# Working 3 (collapsed)", "# Terminals", terminalKey("b")]);
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
