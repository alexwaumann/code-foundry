// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateState } from "../src/gen/codefoundry/v1/update_pb";
import { MockUpdater } from "./update";

function updater() {
  const u = new MockUpdater(
    () => 1,
    () => ({ threads: 0, midTurn: 0, agents: 0, shells: 0 }),
  );
  u.stepMs = 10;
  u.latest = "v0.2.0";
  return u;
}

const settle = () => vi.advanceTimersByTime(1000);

describe("the mock updater's automatic downloads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failure goes back to Available with its reason, the check after it does not retry, and the third failure is Failed", () => {
    const u = updater();
    u.failNext = "bad asset";
    u.check();
    settle();
    expect(u.status).toMatchObject({ state: UpdateState.AVAILABLE, targetVersion: "v0.2.0", failureReason: "bad asset" });

    u.failNext = "bad asset";
    u.check();
    expect(u.status.state).toBe(UpdateState.DOWNLOADING);
    settle();
    expect(u.status).toMatchObject({ state: UpdateState.AVAILABLE, failureReason: "bad asset" });

    u.failNext = "bad asset";
    u.check();
    settle();
    expect(u.status).toMatchObject({ state: UpdateState.FAILED, failureReason: "bad asset" });
    u.check();
    expect(u.status).toMatchObject({ state: UpdateState.FAILED, failureReason: "bad asset" });
  });

  it("Download by hand from Failed downloads it", () => {
    const u = updater();
    for (let i = 0; i < 3; i++) {
      u.failNext = "bad asset";
      u.check();
      settle();
    }
    expect(u.status.state).toBe(UpdateState.FAILED);
    u.download();
    settle();
    expect(u.status).toMatchObject({ state: UpdateState.DOWNLOADED, targetVersion: "v0.2.0", failureReason: "" });
  });

  it("Download checks first and takes the newest release", () => {
    const u = updater();
    u.failNext = "gone";
    u.check();
    settle();
    u.latest = "v0.3.0";
    u.download();
    expect(u.status).toMatchObject({ state: UpdateState.DOWNLOADING, targetVersion: "v0.3.0" });
  });
});
