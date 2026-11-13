import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadLayoutView } from "@/api/layout";

// thread.info runs in the daemon; here it writes the thread's choice straight into the layout
// store, as the layout event that follows it would.
const runs: { name: string; args: Record<string, string> }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult }));

const { dropCardRoom, hideThreadInfoOverlay, setCardRoom, showThreadInfo, threadInfoOpen, toggleThreadInfo, useCardRoom, useThreadInfoOpen } = await import("./threadInfoOverlay");
const { resetLayout, useLayoutStore } = await import("./layout");
const { useSettingsStore } = await import("./settings");
const { useUiStore } = await import("./ui");

function setInfo(id: string, info: boolean): void {
  const s = useLayoutStore.getState();
  const prev: ThreadLayoutView = s.threads[id] ?? { threadId: id, spaceId: "", quick: null, remembered: [], rememberedPaneId: "", info: null };
  useLayoutStore.setState({ threads: { ...s.threads, [id]: { ...prev, info } } });
}

const info = (id: string) => useLayoutStore.getState().threads[id]?.info ?? null;

beforeEach(() => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    if (name === "thread.info") setInfo(args.id ?? "", args.open === "true");
    return Promise.resolve({ message: "", resultJson: "{}" });
  });
  resetLayout();
  useSettingsStore.setState({ snapshot: null });
  useCardRoom.setState({ room: true, rooms: {}, overlayFor: null, focusOverlay: false });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

afterEach(() => {
  vi.clearAllMocks();
  resetLayout();
});

describe("a thread's info card is its own (docs/notes/shell-model.md, \"Thread info is per thread\")", () => {
  it("a thread never toggled follows the setting: shown by default, hidden when it says so", () => {
    expect(threadInfoOpen("s-1")).toBe(true);
    useSettingsStore.setState({ snapshot: { values: { "layout.thread_info": "false" } } as never });
    expect(threadInfoOpen("s-1")).toBe(false);
    setInfo("s-1", true);
    expect(threadInfoOpen("s-1")).toBe(true);
  });

  it("with room, the toggle sets the focused thread's own choice and no other's", () => {
    setInfo("s-2", true);
    toggleThreadInfo(true);
    expect(runs).toEqual([{ name: "thread.info", args: { id: "s-1", close: "true" } }]);
    expect([info("s-1"), info("s-2")]).toEqual([false, true]);
    expect(useCardRoom.getState().overlayFor).toBeNull();
    toggleThreadInfo();
    expect(info("s-1")).toBe(true);
    expect(info("s-2")).toBe(true);
  });

  it("each thread's pane reads its own thread's choice, and follows it", () => {
    const one = renderHook(() => useThreadInfoOpen("s-1"));
    const two = renderHook(() => useThreadInfoOpen("s-2"));
    expect([one.result.current, two.result.current]).toEqual([true, true]);
    act(() => {
      setInfo("s-1", false);
    });
    expect([one.result.current, two.result.current]).toEqual([false, true]);
    act(() => {
      useSettingsStore.setState({ snapshot: { values: { "layout.thread_info": "false" } } as never });
    });
    expect([one.result.current, two.result.current]).toEqual([false, false]);
  });

  it("does nothing without a focused thread", () => {
    useUiStore.setState({ selection: { kind: "home" } as never });
    toggleThreadInfo();
    expect(runs).toEqual([]);
  });
});

describe("the overlay, in a pane too narrow for the card", () => {
  it("shows the focused thread's overlay, turning its card on when it was off, and hides it again", () => {
    setInfo("s-1", false);
    setCardRoom(false);
    toggleThreadInfo(true);
    expect(useCardRoom.getState()).toMatchObject({ overlayFor: "s-1", focusOverlay: true });
    expect(info("s-1")).toBe(true);
    toggleThreadInfo();
    expect(useCardRoom.getState().overlayFor).toBeNull();
    // Hiding the overlay leaves the thread's choice on.
    expect(info("s-1")).toBe(true);
  });

  it("with the card already on, shows the overlay rather than turning the card off", () => {
    setCardRoom(false);
    toggleThreadInfo();
    expect(useCardRoom.getState().overlayFor).toBe("s-1");
    expect(runs).toEqual([]);
  });

  it("dismissing keeps the thread's choice; room again hides the overlay for the inline card", () => {
    setCardRoom(false);
    toggleThreadInfo();
    hideThreadInfoOverlay();
    expect(threadInfoOpen("s-1")).toBe(true);
    toggleThreadInfo();
    setCardRoom(true);
    expect(useCardRoom.getState().overlayFor).toBeNull();
    expect(threadInfoOpen("s-1")).toBe(true);
  });

  it("showThreadInfo turns that thread's card on and floats it only without room", () => {
    setInfo("s-2", false);
    showThreadInfo("s-2");
    expect(useCardRoom.getState().overlayFor).toBeNull();
    expect(info("s-2")).toBe(true);
    setCardRoom(false);
    showThreadInfo("s-2");
    expect(useCardRoom.getState()).toMatchObject({ overlayFor: "s-2", focusOverlay: false });
  });

  it("each thread's pane has its own room: the focused thread's decides", () => {
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
    expect(info("s-2")).toBe(false);
    expect(info("s-1")).toBeNull();
    // The narrow pane widening puts its card inline; a pane that goes forgets its measure.
    setCardRoom(true, "s-1");
    expect(useCardRoom.getState().overlayFor).toBeNull();
    dropCardRoom("s-1");
    expect(useCardRoom.getState().rooms).toEqual({ "s-2": true });
  });
});
