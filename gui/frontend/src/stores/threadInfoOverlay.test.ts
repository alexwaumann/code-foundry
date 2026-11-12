import { beforeEach, describe, expect, it } from "vitest";
import { dropCardRoom, hideThreadInfoOverlay, setCardRoom, showThreadInfo, toggleThreadInfo, useCardRoom } from "./threadInfoOverlay";
import { useUiStore } from "./ui";

describe("toggleThreadInfo", () => {
  beforeEach(() => {
    useCardRoom.setState({ room: true, rooms: {}, overlayFor: null, focusOverlay: false });
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

  it("in the window shell, each thread's pane has its own room: the selected thread's decides", () => {
    // s-1 in a narrow pane, s-2 in a wide one that measured last.
    setCardRoom(false, "s-1");
    setCardRoom(true, "s-2");
    toggleThreadInfo();
    expect(useCardRoom.getState().overlayFor).toBe("s-1");
    // The wide pane measuring again does not take the narrow one's overlay away.
    setCardRoom(true, "s-2");
    expect(useCardRoom.getState().overlayFor).toBe("s-1");
    useUiStore.setState({ selection: { kind: "thread", id: "s-2" } });
    toggleThreadInfo();
    expect(useUiStore.getState().threadInfoOpen).toBe(false);
    // The narrow pane widening puts its card inline; a pane that goes forgets its measure.
    setCardRoom(true, "s-1");
    expect(useCardRoom.getState().overlayFor).toBeNull();
    dropCardRoom("s-1");
    expect(useCardRoom.getState().rooms).toEqual({ "s-2": true });
  });
});
