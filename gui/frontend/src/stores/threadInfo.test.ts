import { describe, expect, it } from "vitest";
import { holdOnce, pendingKey, releasePending, runOnce } from "./threadInfo";

describe("runOnce", () => {
  it("runs once while one is in flight, and again after it settles, also after a failure", async () => {
    const key = pendingKey("s-1", "git");
    let runs = 0;
    let finish = () => {};
    const run = () =>
      new Promise<void>((resolve) => {
        runs++;
        finish = resolve;
      });
    const first = runOnce(key, run);
    await runOnce(key, run);
    expect(runs).toBe(1);
    finish();
    await first;
    await runOnce(key, () => Promise.reject(new Error("no"))).catch(() => undefined);
    await runOnce(key, () => {
      runs++;
      return Promise.resolve();
    });
    expect(runs).toBe(2);
  });
});

describe("holdOnce", () => {
  it("keeps the row pending after a run that holds, until released; a failed or declined run releases it", async () => {
    const key = pendingKey("s-1", "shell:b1");
    let runs = 0;
    const hold = () => {
      runs++;
      return Promise.resolve(true);
    };
    await holdOnce(key, hold);
    await holdOnce(key, hold);
    expect(runs).toBe(1);
    releasePending(key);
    await holdOnce(key, () => {
      runs++;
      return Promise.resolve(false);
    });
    await holdOnce(key, () => Promise.reject(new Error("no"))).catch(() => undefined);
    await holdOnce(key, hold);
    expect(runs).toBe(3);
    releasePending(key);
  });
});
