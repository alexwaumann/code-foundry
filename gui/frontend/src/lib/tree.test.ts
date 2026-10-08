import { describe, expect, it } from "vitest";
import {
  buildRows,
  leafOrder,
  nextAfter,
  OTHER_GROUP_KEY,
  ownedTerminalIds,
  placeTerminal,
  repoKey,
  sessionKey,
  sessionOrder,
  terminalKey,
  terminalOrder,
  worktreeKey,
  type PlaceableTerminal,
  type TreeRepo,
  type TreeSession,
} from "./tree";

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

const repos: TreeRepo[] = [
  { id: "r1", worktreePaths: ["/src/app", "/src/app.worktrees/feat"] },
  { id: "r2", worktreePaths: ["/src/lib"] },
];
const terms: PlaceableTerminal[] = [
  { id: "a", cwd: "/src/app", worktreeLabel: "" },
  { id: "b", cwd: "/tmp", worktreeLabel: "" },
  { id: "c", cwd: "/x", worktreeLabel: "/src/app.worktrees/feat" },
  { id: "d", cwd: "/src/lib/sub", worktreeLabel: "" },
];

describe("buildRows", () => {
  it("nests terminals under worktrees and collects the rest under Other", () => {
    const keys = buildRows(repos, terms, {}).map((r) => `${String(r.depth)}:${r.key}`);
    expect(keys).toEqual([
      `0:${repoKey("r1")}`,
      `1:${worktreeKey("r1", "/src/app")}`,
      `2:${terminalKey("a")}`,
      `1:${worktreeKey("r1", "/src/app.worktrees/feat")}`,
      `2:${terminalKey("c")}`,
      `0:${repoKey("r2")}`,
      `1:${worktreeKey("r2", "/src/lib")}`,
      `2:${terminalKey("d")}`,
      `0:${OTHER_GROUP_KEY}`,
      `1:${terminalKey("b")}`,
    ]);
  });

  it("hides children of collapsed nodes", () => {
    const rows = buildRows(repos, terms, { [repoKey("r1")]: true, [worktreeKey("r2", "/src/lib")]: true, [OTHER_GROUP_KEY]: true });
    expect(rows.map((r) => r.key)).toEqual([repoKey("r1"), repoKey("r2"), worktreeKey("r2", "/src/lib"), OTHER_GROUP_KEY]);
    expect(rows[0]).toMatchObject({ kind: "repo", expanded: false, hasChildren: true });
    expect(rows[2]).toMatchObject({ kind: "worktree", expanded: false, hasChildren: true });
  });

  it("marks empty worktrees as leaf rows and omits Other when empty", () => {
    const rows = buildRows(repos, [], {});
    expect(rows.every((r) => r.kind !== "group")).toBe(true);
    expect(rows.flatMap((r) => (r.kind === "worktree" ? [r.hasChildren] : []))).toEqual([false, false, false]);
  });

  it("terminalOrder ignores collapse state", () => {
    expect(terminalOrder(repos, terms)).toEqual(["a", "c", "d", "b"]);
  });
});

describe("buildRows with sessions", () => {
  const sessions: TreeSession[] = [
    { id: "s1", worktreePath: "/src/app", terminalId: "a" },
    { id: "s2", worktreePath: "/src/app", terminalId: "" },
    { id: "s3", worktreePath: "/gone", terminalId: "" },
  ];
  const withLabels: PlaceableTerminal[] = [
    ...terms,
    { id: "e", cwd: "/src/lib", worktreeLabel: "", sessionLabel: "s9" }, // unknown session: shown
    { id: "f", cwd: "/src/lib", worktreeLabel: "", sessionLabel: "s2" }, // owned by label: hidden
  ];

  it("lists sessions first under their worktree and hides their terminals", () => {
    const keys = buildRows(repos, withLabels, {}, sessions).map((r) => `${String(r.depth)}:${r.key}`);
    expect(keys).toEqual([
      `0:${repoKey("r1")}`,
      `1:${worktreeKey("r1", "/src/app")}`,
      `2:${sessionKey("s1")}`,
      `2:${sessionKey("s2")}`,
      `1:${worktreeKey("r1", "/src/app.worktrees/feat")}`,
      `2:${terminalKey("c")}`,
      `0:${repoKey("r2")}`,
      `1:${worktreeKey("r2", "/src/lib")}`,
      `2:${terminalKey("d")}`,
      `2:${terminalKey("e")}`,
      `0:${OTHER_GROUP_KEY}`,
      `1:${sessionKey("s3")}`,
      `1:${terminalKey("b")}`,
    ]);
    expect(buildRows(repos, withLabels, {}, sessions).find((r) => r.key === OTHER_GROUP_KEY)).toMatchObject({ label: "Other" });
  });

  it("ownedTerminalIds uses both terminal_id and labels.session", () => {
    expect([...ownedTerminalIds(sessions, withLabels)].sort()).toEqual(["a", "f"]);
  });

  it("orders leaves and sessions regardless of collapse", () => {
    expect(sessionOrder(repos, withLabels, sessions)).toEqual(["s1", "s2", "s3"]);
    expect(leafOrder(repos, withLabels, sessions).map((r) => r.key)).toEqual(["s:s1", "s:s2", "t:c", "t:d", "t:e", "s:s3", "t:b"]);
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
