import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunState } from "../src/gen/codefoundry/v1/action_pb";
import { MockActions, type ActionEventInit, type ActionHost } from "./actions";

const WT = "/mock/cf";

function world() {
  const events: ActionEventInit[] = [];
  let terminals = 0;
  const host: ActionHost = {
    publish: (e) => events.push(e),
    projects: () => [{ id: "repo-cf", name: "cf", worktrees: [WT] }],
    thread: () => ({ projectId: "repo-cf", worktreePath: WT, checkouts: { "repo-cf": WT } }),
    startTerminal: () => `t-${String(++terminals)}`,
    openTerminalTab: () => undefined,
    write: () => undefined,
    exit: () => undefined,
  };
  const actions = new MockActions(host);
  actions.reset();
  events.length = 0;
  const updates = () => events.flatMap((e) => (e.event?.case === "runUpdated" ? [e.event.value] : []));
  return { actions, updates };
}

describe("a mock run's ports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pnpm dev listens once Vite is up, and a run's end clears its ports", () => {
    const { actions, updates } = world();
    const run = actions.run({ action: "a-dev000000000", threadId: "s-1" });
    expect(run.ports).toEqual([]);
    vi.advanceTimersByTime(1100);
    expect(updates().at(-1)?.ports).toEqual([5173]);
    actions.finishNow({ run: run.id ?? "" }, 0);
    expect(updates().at(-1)).toMatchObject({ state: ActionRunState.EXITED, ports: [] });
  });

  it("publishes a change only, ascending, by run or terminal, and a set port beats the script", () => {
    const { actions, updates } = world();
    const run = actions.run({ action: "a-dev000000000", threadId: "s-1" });
    const before = updates().length;
    actions.setPorts({ terminal: run.terminalId ?? "" }, [24678, 5173]);
    expect(updates().at(-1)?.ports).toEqual([5173, 24678]);
    actions.setPorts({ run: run.id ?? "" }, [5173, 24678]);
    vi.advanceTimersByTime(2000);
    expect(updates()).toHaveLength(before + 1);
    actions.setPorts({ run: run.id ?? "" }, []);
    expect(updates().at(-1)?.ports).toEqual([]);
  });

  it("refuses an unknown or finished run", () => {
    const { actions } = world();
    expect(() => actions.setPorts({ run: "r-nope" }, [1])).toThrow(/no run/);
    const run = actions.run({ action: "a-dev000000000", threadId: "s-1" });
    actions.finishNow({ run: run.id ?? "" }, 0);
    expect(() => actions.setPorts({ run: run.id ?? "" }, [1])).toThrow(/already finished/);
  });
});

describe("a mock reset and run records", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a reset is a new world: the last run is gone, so the next test's pick is the first action", () => {
    const { actions } = world();
    expect(actions.lastRun("repo-cf", "").action?.name).toBe("Dev");
    const run = actions.run({ action: "a-debug0000000", threadId: "s-1" });
    actions.finishNow({ run: run.id ?? "" }, 0);
    expect(actions.lastRun("repo-cf", "").action?.name).toBe("Debug daemon");
    actions.reset();
    expect(actions.lastRun("repo-cf", "").action?.name).toBe("Dev");
  });

  it("a daemon restart keeps them, as the daemon's table does", () => {
    const { actions } = world();
    const run = actions.run({ action: "a-debug0000000", threadId: "s-1" });
    actions.finishNow({ run: run.id ?? "" }, 0);
    actions.restart();
    expect(actions.lastRun("repo-cf", "").action?.name).toBe("Debug daemon");
  });
});
