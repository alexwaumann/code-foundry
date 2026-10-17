import { describe, expect, it } from "vitest";
import type { ActionRunView, ActionView } from "@/api/actions";
import { applyActionEvent, emptyActions, replaceActions } from "./actions";

const act = (id: string, projectId: string, position: number, name = id): ActionView => ({ id, projectId, name, command: "x", icon: "play", inTerminal: true, onWorktreeCreate: false, position });
const run = (id: string, running = true): ActionRunView => ({
  id,
  actionId: "a",
  actionName: "A",
  command: "x",
  projectId: "r",
  threadId: "s-1",
  worktreePath: "/w",
  mode: "terminal",
  terminalId: "t",
  running,
  exitCode: 0,
  startedAtMs: 1,
  finishedAtMs: null,
  trigger: "user",
});

describe("actions store", () => {
  it("a snapshot groups by project in position order", () => {
    const s = replaceActions([act("b", "r1", 1), act("a", "r1", 0), act("c", "r2", 0)], [run("r-1")]);
    expect(s.byProject).toEqual({ r1: ["a", "b"], r2: ["c"] });
    expect(Object.keys(s.runs)).toEqual(["r-1"]);
  });

  it("updated adds or moves; removed drops the action and an emptied project", () => {
    let s = applyActionEvent(emptyActions, { kind: "updated", action: act("a", "r1", 0) });
    s = applyActionEvent(s, { kind: "updated", action: act("b", "r1", 1) });
    expect(s.byProject.r1).toEqual(["a", "b"]);
    const before = s.byProject;
    // Same order: the same byProject object (narrow selectors do not re-render).
    s = applyActionEvent(s, { kind: "updated", action: { ...act("a", "r1", 0), command: "y" } });
    expect(s.byProject).toBe(before);
    s = applyActionEvent(s, { kind: "updated", action: act("a", "r1", 2) });
    expect(s.byProject.r1).toEqual(["b", "a"]);
    s = applyActionEvent(s, { kind: "removed", id: "a" });
    s = applyActionEvent(s, { kind: "removed", id: "b" });
    expect(s.byProject).toEqual({});
    expect(applyActionEvent(s, { kind: "removed", id: "zz" })).toBe(s);
  });

  it("runs update, are forgotten, and run_finished changes nothing", () => {
    let s = applyActionEvent(emptyActions, { kind: "runUpdated", run: run("r-1") });
    s = applyActionEvent(s, { kind: "runUpdated", run: run("r-1", false) });
    expect(s.runs["r-1"]?.running).toBe(false);
    const same = applyActionEvent(s, {
      kind: "runFinished",
      finished: { runId: "r-1", actionId: "a", actionName: "A", projectId: "r", threadId: "", exitCode: 0, mode: "terminal", trigger: "user", terminalId: "" },
    });
    expect(same).toBe(s);
    s = applyActionEvent(s, { kind: "runRemoved", id: "r-1" });
    expect(s.runs).toEqual({});
  });
});
