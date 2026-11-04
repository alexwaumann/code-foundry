import { describe, expect, it } from "vitest";
import type { ActionRunView } from "@/api/actions";
import type { ThreadView } from "@/api/threads";
import type { LineageData } from "./lineage";
import { rollupThreadIds, runSource, serverRows, serverSourceWords, shellSource, type ServerSource } from "./servers";

const shell = (owner: string, task: string, ports: number[], command = `cmd ${task}`): ServerSource =>
  shellSource(owner, { taskId: task, description: "", command, startedAtMs: 1, ports });
const run = (owner: string, id: string, ports: number[], o: Partial<ActionRunView> = {}): ServerSource =>
  runSource({ id, threadId: owner, actionName: "Dev", command: "pnpm dev", terminalId: "", startedAtMs: 1, ports, ...o } as ActionRunView);
const rows = (r: ServerSource[]) => r.map((s) => [s.key, ...s.ports]);

describe("rollupThreadIds", () => {
  const t = (id: string, o: Partial<ThreadView> = {}) => ({ id, createdBy: "", archivedAtMs: null, ...o }) as ThreadView;
  const list = (...threads: ThreadView[]): LineageData => ({ byId: Object.fromEntries(threads.map((x) => [x.id, x])), order: threads.map((x) => x.id) });

  it("leaves an archived thread out and walks on through it", () => {
    const data = list(t("p"), t("kid", { createdBy: "p", archivedAtMs: 5 }), t("grandkid", { createdBy: "kid" }));
    expect(rollupThreadIds(data, "p")).toEqual(["p", "grandkid"]);
  });

  it("an archived parent still lists what runs below it, not itself", () => {
    expect(rollupThreadIds(list(t("p", { archivedAtMs: 5 }), t("kid", { createdBy: "p" })), "p")).toEqual(["kid"]);
  });

  it("an unknown thread lists nothing", () => {
    expect(rollupThreadIds(list(), "gone")).toEqual([]);
  });
});

describe("serverRows", () => {
  it("thread by thread: its shells, then its runs, the oldest run first", () => {
    const shells = [shell("p", "s1", [9399]), shell("kid", "s2", [6006])];
    const runs = [run("kid", "r2", [8080], { startedAtMs: 9 }), run("kid", "r1", [8081], { startedAtMs: 3 }), run("p", "r0", [7788])];
    expect(rows(serverRows(["p", "kid"], shells, runs))).toEqual([
      ["shell:p:s1", 9399],
      ["run:r0", 7788],
      ["shell:kid:s2", 6006],
      ["run:r1", 8081],
      ["run:r2", 8080],
    ]);
  });

  it("several servers of one child and a grandchild's each get a row", () => {
    const shells = [shell("kid", "a", [1]), shell("kid", "b", [2]), shell("grandkid", "c", [3])];
    expect(serverRows(["p", "kid", "grandkid"], shells, [])).toHaveLength(3);
  });

  it("leaves out what no listed thread owns", () => {
    expect(serverRows(["p"], [shell("stranger", "a", [1])], [run("stranger", "r", [2])])).toEqual([]);
  });

  it("a port two sources report is one row: a run with a terminal beats a shell, whichever comes first", () => {
    const shells = [shell("p", "s", [5173])];
    const runs = [run("kid", "r", [5173, 24678], { terminalId: "t" })];
    expect(rows(serverRows(["p", "kid"], shells, runs))).toEqual([["run:r", 5173, 24678]]);
  });

  it("a run beats a shell, a terminal run beats a background run", () => {
    expect(rows(serverRows(["p"], [shell("p", "s", [1])], [run("p", "r", [1])]))).toEqual([["run:r", 1]]);
    expect(rows(serverRows(["p"], [], [run("p", "bg", [1], { startedAtMs: 1 }), run("p", "tty", [1], { startedAtMs: 2, terminalId: "t" })]))).toEqual([["run:tty", 1]]);
  });

  it("two of the same kind: the earlier in the list keeps the port", () => {
    expect(rows(serverRows(["p", "kid"], [shell("p", "own", [1]), shell("kid", "child", [1])], []))).toEqual([["shell:p:own", 1]]);
  });

  it("the other source keeps its other ports, and the port it gave up is off its +N", () => {
    const got = serverRows(["p"], [shell("p", "s", [5173, 9000])], [run("p", "r", [5173], { terminalId: "t" })]);
    expect(rows(got)).toEqual([
      ["shell:p:s", 9000],
      ["run:r", 5173],
    ]);
  });

  it("a port repeated within one source is listed once", () => {
    expect(rows(serverRows(["p"], [shell("p", "s", [1, 1, 2])], []))).toEqual([["shell:p:s", 1, 2]]);
  });
});

describe("serverSourceWords", () => {
  it.each([
    ["this thread's own shell", "", "", ""],
    ["this thread's action", "Dev", "", "Dev action"],
    ["a child's shell", "", "Storybook docs", "Storybook docs"],
    ["a child's action", "Dev", "Serve the web preview", "Dev action · Serve the web preview"],
    ["an action named for it", "Deploy action", "", "Deploy action"],
    ["a name that only ends like it", "Reaction", "", "Reaction action"],
  ])("%s", (_name, action, owner, want) => {
    expect(serverSourceWords(action, owner)).toBe(want);
  });
});
