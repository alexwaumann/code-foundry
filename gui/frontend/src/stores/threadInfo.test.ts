import { beforeEach, describe, expect, it } from "vitest";
import { hideThreadInfoOverlay, holdOnce, pendingKey, releasePending, runOnce, setCardRoom, showThreadInfo, toggleThreadInfo, useCardRoom } from "./threadInfo";
import { useUiStore } from "./ui";

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

describe("toggleThreadInfo", () => {
  beforeEach(() => {
    useCardRoom.setState({ room: true, overlayFor: null, focusOverlay: false });
    useUiStore.setState({ threadInfoOpen: false, selection: { kind: "thread", id: "s-1" } });
  });

  it("with room toggles the inline card and never shows the overlay", () => {
    toggleThreadInfo(true);
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
    expect(useCardRoom.getState().overlayFor).toBeNull();
    toggleThreadInfo();
    expect(useUiStore.getState().threadInfoOpen).toBe(false);
  });

  it("without room shows the selected thread's overlay, turning the card on, and hides it again", () => {
    setCardRoom(false);
    toggleThreadInfo(true);
    expect(useCardRoom.getState()).toMatchObject({ overlayFor: "s-1", focusOverlay: true });
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
    toggleThreadInfo();
    expect(useCardRoom.getState().overlayFor).toBeNull();
    // Hiding the overlay leaves the preference on.
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
  });

  it("without room and the card already on, shows the overlay rather than turning the card off", () => {
    useUiStore.setState({ threadInfoOpen: true });
    setCardRoom(false);
    toggleThreadInfo();
    expect(useCardRoom.getState().overlayFor).toBe("s-1");
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
  });

  it("dismissing keeps threadInfoOpen; room again hides the overlay for the inline card", () => {
    setCardRoom(false);
    toggleThreadInfo();
    hideThreadInfoOverlay();
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
    toggleThreadInfo();
    setCardRoom(true);
    expect(useCardRoom.getState().overlayFor).toBeNull();
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
  });

  it("showThreadInfo floats only without room", () => {
    showThreadInfo("s-2");
    expect(useCardRoom.getState().overlayFor).toBeNull();
    expect(useUiStore.getState().threadInfoOpen).toBe(true);
    setCardRoom(false);
    showThreadInfo("s-2");
    expect(useCardRoom.getState()).toMatchObject({ overlayFor: "s-2", focusOverlay: false });
  });
});
