import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ActionEventSchema, ActionIcon, ActionRunMode, ActionRunState, ActionRunTrigger } from "@/gen/codefoundry/v1/action_pb";
import { runFromResult, toActionEventView } from "./actions";

describe("toActionEventView", () => {
  it("maps a snapshot's actions and runs", () => {
    const ev = create(ActionEventSchema, {
      event: {
        case: "snapshot",
        value: {
          actions: [{ id: "a-1", repoId: "r", name: "Test", command: "go test", icon: ActionIcon.TEST, inTerminal: true, onWorktreeCreate: true, position: 2 }],
          runs: [
            {
              id: "r-1",
              actionId: "a-1",
              actionName: "Test",
              command: "go test",
              repoId: "r",
              threadId: "s-1",
              worktreePath: "/w",
              mode: ActionRunMode.TERMINAL,
              terminalId: "t-1",
              state: ActionRunState.EXITED,
              exitCode: 3,
              startedAt: timestampFromMs(1000),
              finishedAt: timestampFromMs(5200),
              trigger: ActionRunTrigger.WORKTREE_CREATE,
            },
          ],
        },
      },
    });
    expect(toActionEventView(ev)).toEqual({
      kind: "snapshot",
      actions: [{ id: "a-1", repoId: "r", name: "Test", command: "go test", icon: "test", inTerminal: true, onWorktreeCreate: true, position: 2 }],
      runs: [
        {
          id: "r-1",
          actionId: "a-1",
          actionName: "Test",
          command: "go test",
          repoId: "r",
          sessionId: "s-1",
          worktreePath: "/w",
          mode: "terminal",
          terminalId: "t-1",
          running: false,
          exitCode: 3,
          startedAtMs: 1000,
          finishedAtMs: 5200,
          trigger: "worktree-create",
        },
      ],
    });
  });

  it.each([
    ["removed", { case: "removedId" as const, value: "a-1" }, { kind: "removed", id: "a-1" }],
    ["run removed", { case: "runRemovedId" as const, value: "r-1" }, { kind: "runRemoved", id: "r-1" }],
    ["nothing", { case: undefined }, null],
  ])("%s", (_n, event, want) => {
    expect(toActionEventView(create(ActionEventSchema, { event }))).toEqual(want);
  });

  it("an unset icon is play", () => {
    const ev = create(ActionEventSchema, { event: { case: "updated", value: { id: "a", icon: ActionIcon.UNSPECIFIED } } });
    expect(toActionEventView(ev)).toMatchObject({ action: { icon: "play" } });
  });
});

describe("runFromResult", () => {
  it.each([
    ["a terminal run", '{"id":"r-1","terminalId":"t-9","mode":"ACTION_RUN_MODE_TERMINAL"}', { id: "r-1", terminalId: "t-9" }],
    ["a background run", '{"id":"r-2"}', { id: "r-2", terminalId: "" }],
    ["no run", "{}", null],
    ["empty", "", null],
    ["not JSON", "started", null],
  ])("%s", (_n, json, want) => {
    expect(runFromResult(json)).toEqual(want);
  });
});
