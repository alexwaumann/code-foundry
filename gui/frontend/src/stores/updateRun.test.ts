import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetUpdated, resetUpdateRuns, runUpdates, useUpdateRunStore, type UpdateStep } from "./updateRun";

const run = () => useUpdateRunStore.getState().skills;

/** A step that finishes when told to, with the run as it stood when the step started. */
function step(key: string, order: string[]) {
  let finish: (ok: boolean) => void = () => undefined;
  const started: UpdateStep = {
    key,
    version: `${key}-2`,
    run: () => {
      order.push(key);
      return new Promise<boolean>((r) => {
        finish = r;
      });
    },
  };
  return { step: started, finish: (ok: boolean) => { finish(ok); } };
}

const tick = () => new Promise((r) => setTimeout(r));

beforeEach(() => {
  resetUpdateRuns();
});

describe("runUpdates", () => {
  it("takes one row at a time, in order, counting as it goes", async () => {
    const order: string[] = [];
    const a = step("a", order);
    const b = step("b", order);
    const done = runUpdates("skills", [a.step, b.step]);
    expect(run()).toMatchObject({ running: true, at: 1, total: 2 });
    expect(order).toEqual(["a"]);
    a.finish(true);
    await tick();
    expect(order).toEqual(["a", "b"]);
    expect(run()).toMatchObject({ running: true, at: 2, updated: { a: "a-2" } });
    b.finish(true);
    await done;
    expect(run()).toMatchObject({ running: false, updated: { a: "a-2", b: "b-2" } });
  });

  it("a failed row does not stop the rest and is not marked updated", async () => {
    const order: string[] = [];
    const a = step("a", order);
    const b = step("b", order);
    const done = runUpdates("skills", [a.step, b.step]);
    a.finish(false);
    await tick();
    b.finish(true);
    await done;
    expect(run().updated).toEqual({ b: "b-2" });
  });

  it("a step that throws counts as failed", async () => {
    await runUpdates("skills", [{ key: "a", version: "2", run: () => Promise.reject(new Error("no")) }]);
    expect(run()).toMatchObject({ running: false, updated: {} });
  });

  it("a run in progress is left alone, and the pages' runs are their own", async () => {
    const order: string[] = [];
    const a = step("a", order);
    const done = runUpdates("skills", [a.step]);
    const second = vi.fn(() => Promise.resolve(true));
    await runUpdates("skills", [{ key: "b", version: "2", run: second }]);
    expect(second).not.toHaveBeenCalled();
    await runUpdates("plugins", [{ key: "b", version: "2", run: second }]);
    expect(second).toHaveBeenCalledTimes(1);
    a.finish(true);
    await done;
  });

  it("nothing to run starts nothing", async () => {
    await runUpdates("skills", []);
    expect(run()).toMatchObject({ running: false, total: 0 });
  });
});

describe("forgetUpdated", () => {
  it("clears a finished run, keeps one in progress", async () => {
    const order: string[] = [];
    const a = step("a", order);
    const done = runUpdates("skills", [a.step]);
    forgetUpdated("skills");
    expect(run().running).toBe(true);
    a.finish(true);
    await done;
    expect(run().updated).toEqual({ a: "a-2" });
    forgetUpdated("skills");
    expect(run().updated).toEqual({});
  });
});
