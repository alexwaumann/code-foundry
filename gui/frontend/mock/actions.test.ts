// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunState } from "../src/gen/codefoundry/v1/action_pb";
import { MockActions, type ActionHost } from "./actions";

const WT = "/mock/cf";

function world() {
  const host: ActionHost = {
    publish: () => undefined,
    projects: () => [{ id: "repo-cf", name: "cf", worktrees: [WT] }],
    thread: () => ({ projectId: "repo-cf", worktreePath: WT, checkouts: { "repo-cf": WT } }),
    startTerminal: () => "t-1",
    openTerminalTab: () => undefined,
    write: () => undefined,
    exit: () => undefined,
  };
  const actions = new MockActions(host);
  actions.reset();
  const invoke = async (name: string, args: Record<string, string>) => {
    const c = actions.commands().find((x) => x.cmd.name === name);
    if (!c) throw new Error(`no command ${name}`);
    return c.run(undefined, args);
  };
  return { actions, invoke };
}

describe("mock action runs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("action.stop answers with the run as JSON, and says when the run had finished already", async () => {
    const { actions, invoke } = world();
    const run = actions.run({ action: "a-debug0000000", threadId: "s-1" });
    const out = await invoke("action.stop", { run: run.id ?? "" });
    expect(typeof out === "string" ? out : out.message).toBe(`stopping Debug daemon (run ${run.id ?? ""})`);
    expect(JSON.parse(typeof out === "string" ? "" : out.resultJson)).toMatchObject({ id: run.id, state: "ACTION_RUN_STATE_EXITED" });
    const again = await invoke("action.stop", { run: run.id ?? "" });
    expect(typeof again === "string" ? again : again.message).toBe(`Debug daemon had finished already, with code 129 (run ${run.id ?? ""})`);
  });

  it("a reset or a daemon restart ends a wait on a running run", async () => {
    for (const drop of ["reset", "restart"] as const) {
      const { actions } = world();
      const run = actions.run({ action: "a-debug0000000", threadId: "s-1" });
      expect(run.state).toBe(ActionRunState.RUNNING);
      const wait = actions.waitRun(run.id ?? "");
      actions[drop]();
      await expect(wait).rejects.toThrow(/is gone/);
    }
  });
});
