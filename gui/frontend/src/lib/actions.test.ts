import { describe, expect, it } from "vitest";
import type { ActionView } from "@/api/actions";
import { actionCommandOf, actionTabStatus, addArgs, commandEcho, draftOf, draftProblem, editArgs, formatRunClock, formatRunDuration, NEW_ACTION_DRAFT } from "./actions";

const action: ActionView = { id: "a-1", repoId: "repo-cf", name: "Test", command: "go test ./...", icon: "test", inTerminal: true, onWorktreeCreate: false, position: 1 };

describe("actionTabStatus", () => {
  it.each([
    ["running", { state: "running", exitCode: 0 }, "running"],
    ["unknown counts as running", { state: "unknown", exitCode: 0 }, "running"],
    ["exit 0", { state: "exited", exitCode: 0 }, "ok"],
    ["exit 1", { state: "exited", exitCode: 1 }, "failed"],
    ["killed", { state: "exited", exitCode: 129 }, "failed"],
    ["gone first", { state: "exited", exitCode: -1 }, "failed"],
  ])("%s", (_n, t, want) => {
    expect(actionTabStatus(t)).toBe(want);
  });
});

describe("formatRunClock", () => {
  it.each([
    [0, "0:00"],
    [-5, "0:00"],
    [12_400, "0:12"],
    [725_000, "12:05"],
    [3_723_000, "1:02:03"],
  ])("%d ms", (ms, want) => {
    expect(formatRunClock(ms)).toBe(want);
  });
});

describe("formatRunDuration", () => {
  it.each([
    [0, "0.0s"],
    [4_230, "4.2s"],
    [9_990, "9.9s"],
    [10_000, "10s"],
    [42_700, "42s"],
    [185_000, "3m 5s"],
    [3_720_000, "1h 2m"],
  ])("%d ms", (ms, want) => {
    expect(formatRunDuration(ms)).toBe(want);
  });
});

describe("actionCommandOf and commandEcho", () => {
  it.each([
    ["the run's command wins", "make check", ["/bin/zsh", "-lc", "other"], "make check"],
    ["else argv's -lc script", undefined, ["/bin/zsh", "-lc", "go test ./..."], "go test ./..."],
    ["an argv that is not a script", undefined, ["/bin/zsh"], ""],
  ])("%s", (_n, run, argv, want) => {
    expect(actionCommandOf(run, argv)).toBe(want);
  });
  it.each([
    ["one line", "make", { first: "make", more: 0 }],
    ["two lines", "cd gui\npnpm install", { first: "cd gui", more: 1 }],
    ["blank lines do not count", "\ncd gui\n\npnpm i\nls\n", { first: "cd gui", more: 2 }],
    ["empty", "", { first: "", more: 0 }],
  ])("%s", (_n, cmd, want) => {
    expect(commandEcho(cmd)).toEqual(want);
  });
});

describe("drafts", () => {
  it("draftProblem needs a name and a command", () => {
    expect(draftProblem(NEW_ACTION_DRAFT)).toMatch(/name/);
    expect(draftProblem({ ...NEW_ACTION_DRAFT, name: " x " })).toMatch(/command/);
    expect(draftProblem({ ...NEW_ACTION_DRAFT, name: "x", command: "y" })).toBeNull();
  });

  it("addArgs: a terminal action of the project, the name trimmed", () => {
    expect(addArgs("repo-cf", { name: " Lint ", command: "make lint", icon: "lint", onWorktreeCreate: true })).toEqual({
      name: "Lint",
      command: "make lint",
      icon: "lint",
      "in-terminal": "true",
      "on-worktree-create": "true",
      repo: "repo-cf",
    });
  });

  it.each([
    ["nothing changed", {}, null],
    ["the command", { command: "go test -race ./..." }, { action: "a-1", command: "go test -race ./...", repo: "repo-cf" }],
    ["name (trimmed) and icon", { name: " Tests ", icon: "debug" as const }, { action: "a-1", name: "Tests", icon: "debug", repo: "repo-cf" }],
    ["the switch", { onWorktreeCreate: true }, { action: "a-1", "on-worktree-create": "true", repo: "repo-cf" }],
    ["a name only differing by spaces is no change", { name: "Test  " }, null],
  ])("editArgs: %s", (_n, change, want) => {
    expect(editArgs(action, { ...draftOf(action), ...change })).toEqual(want);
  });
});
