import { describe, expect, it } from "vitest";
import { pendingKey, runOnce } from "./threadInfo";

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
