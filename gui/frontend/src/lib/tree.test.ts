import { describe, expect, it } from "vitest";
import { buildRows, leafOrder, nextAfter, ownedTerminalIds, placeTerminal, sessionKey, sessionOrder, terminalKey, type ListSession, type PlaceableTerminal } from "./tree";

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

const thread = (id: string, over: Partial<ListSession> = {}): ListSession => ({ id, terminalId: "", pinned: false, attention: false, ...over });

/** "<kind>:<key>" per row, headers as "# Label". */
function shape(rows: ReturnType<typeof buildRows>): string[] {
  return rows.map((r) => (r.kind === "header" ? `# ${r.label}` : r.key));
}

describe("buildRows (the flat thread list)", () => {
  it("lists threads newest first with no header when there is only one section, then loose terminals", () => {
    const sessions = [thread("s1", { terminalId: "a" }), thread("s2"), thread("s3")];
    expect(shape(buildRows(sessions, terms))).toEqual([sessionKey("s3"), sessionKey("s2"), sessionKey("s1"), "# Terminals", terminalKey("b"), terminalKey("c")]);
  });

  it("puts pinned threads, then unpinned ones needing attention, above the rest", () => {
    const sessions = [thread("s1", { attention: true }), thread("s2", { pinned: true }), thread("s3"), thread("s4", { pinned: true, attention: true }), thread("s5", { attention: true })];
    expect(shape(buildRows(sessions, []))).toEqual([
      "# Pinned",
      sessionKey("s4"),
      sessionKey("s2"),
      "# Needs attention",
      sessionKey("s5"),
      sessionKey("s1"),
      "# Threads",
      sessionKey("s3"),
    ]);
    expect(buildRows(sessions, []).find((r) => r.key === sessionKey("s4"))).toMatchObject({ section: "pinned" });
  });

  it("drops empty sections and their headers", () => {
    expect(shape(buildRows([thread("s1", { attention: true })], []))).toEqual(["# Needs attention", sessionKey("s1")]);
    expect(shape(buildRows([], [terms[1] as PlaceableTerminal]))).toEqual(["# Terminals", terminalKey("b")]);
    expect(buildRows([], [])).toEqual([]);
  });

  it("ownedTerminalIds uses both terminal_id and labels.session", () => {
    expect([...ownedTerminalIds([thread("s1", { terminalId: "a" }), thread("s2")], terms)].sort()).toEqual(["a", "f"]);
  });

  it("orders leaves (cmd+1..9) and threads (cmd+shift+a) as shown, headers skipped", () => {
    const sessions = [thread("s1"), thread("s2", { attention: true }), thread("s3", { terminalId: "a" })];
    expect(leafOrder(sessions, terms).map((r) => r.key)).toEqual(["s:s2", "s:s3", "s:s1", "t:b", "t:c"]);
    expect(sessionOrder(sessions, terms)).toEqual(["s2", "s3", "s1"]);
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
