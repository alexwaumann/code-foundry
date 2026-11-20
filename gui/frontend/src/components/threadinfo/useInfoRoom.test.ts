import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every thread body measures this wide: too narrow for the inline card, so its card floats.
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, 600] }));

const { useInfoRoom } = await import("./useInfoRoom");
const { setCardRoom, useCardRoom } = await import("@/stores/threadInfoOverlay");

const overlay = () => useCardRoom.getState().overlayFor;

beforeEach(() => {
  useCardRoom.setState({ room: true, rooms: {}, overlayFor: null, focusOverlay: false });
});

/**
 * When the overlay hides (docs/notes/thread-info-overlay.md, "Dismiss": "another thread";
 * "leaving the thread body"), with one thread body or several (the shell's panes).
 */
describe("a thread body coming and going, and the overlay", () => {
  it("a pane for another thread mounting beside it keeps the shown thread's overlay", () => {
    renderHook(() => useInfoRoom("s-1"));
    useCardRoom.setState({ overlayFor: "s-1" });
    renderHook(() => useInfoRoom("s-2"));
    expect(overlay()).toBe("s-1");
  });

  it("a body moving to another thread hides its overlay", () => {
    const body = renderHook(({ id }) => useInfoRoom(id), { initialProps: { id: "s-1" } });
    useCardRoom.setState({ overlayFor: "s-1" });
    body.rerender({ id: "s-2" });
    expect(overlay()).toBeNull();
  });

  it("the body going away hides its overlay; another pane's going away does not", () => {
    const one = renderHook(() => useInfoRoom("s-1"));
    const two = renderHook(() => useInfoRoom("s-2"));
    useCardRoom.setState({ overlayFor: "s-1" });
    two.unmount();
    expect(overlay()).toBe("s-1");
    one.unmount();
    expect(overlay()).toBeNull();
  });

  it("a body arriving for the overlay's own thread keeps it", () => {
    setCardRoom(false);
    useCardRoom.setState({ overlayFor: "s-2" });
    renderHook(() => useInfoRoom("s-2"));
    expect(overlay()).toBe("s-2");
  });

  it("a body arriving drops an overlay left for a thread no body shows", () => {
    renderHook(() => useInfoRoom("s-1"));
    useCardRoom.setState({ overlayFor: "s-9" });
    renderHook(() => useInfoRoom("s-2"));
    expect(overlay()).toBeNull();
  });
});
