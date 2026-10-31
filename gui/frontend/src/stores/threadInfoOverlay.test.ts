import { beforeEach, describe, expect, it } from "vitest";
import { hideThreadInfoOverlay, setCardRoom, showThreadInfo, toggleThreadInfo, useCardRoom } from "./threadInfoOverlay";
import { useUiStore } from "./ui";

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
