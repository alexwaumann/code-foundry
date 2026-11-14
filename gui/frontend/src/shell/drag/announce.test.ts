import { describe, expect, it } from "vitest";
import { cancelledText, droppedText, overText, pickedUpText, type DragNames } from "./announce";
import type { DragSource } from "./targets";

const names: DragNames = {
  tab: (id) => ({ "t-a": "Fix login", "t-d": "Diff" })[id] ?? id,
  pane: (id) => ({ "p-1": "Fix login", "p-2": "Diff" })[id] ?? id,
  tabCount: (id) => ({ "p-1": 3, "p-2": 1 })[id] ?? 0,
  thread: (id) => ({ "th-1": "Plan the trip" })[id] ?? id,
};
const tab: DragSource = { kind: "tab", tab: "t-a", pane: "p-1" };
const pane: DragSource = { kind: "pane", pane: "p-1" };

describe("drag announcements", () => {
  it("name what was picked up", () => {
    expect(pickedUpText(tab, names)).toMatch(/^Picked up tab Fix login\. .*Escape to cancel\.$/);
    expect(pickedUpText(pane, names)).toMatch(/^Picked up the pane of Fix login \(3 tabs\)\./);
  });

  it("say where the drop would land", () => {
    expect(overText(tab, { kind: "strip", pane: "p-2", index: 1 }, names)).toBe("Tab Fix login is over position 2 of 2 in the pane of Diff.");
    // In its own strip the count stays and the place is clamped to it.
    expect(overText(tab, { kind: "strip", pane: "p-1", index: 3 }, names)).toBe("Tab Fix login is over position 3 of 3 in the pane of Fix login.");
    expect(overText(tab, { kind: "pane", pane: "p-2" }, names)).toBe("Tab Fix login is over the pane of Diff.");
    expect(overText(pane, { kind: "edge", pane: "p-2", edge: "bottom" }, names)).toBe("The pane of Fix login (3 tabs) is over the bottom edge of the pane of Diff.");
    expect(overText(tab, { kind: "outer", edge: "left" }, names)).toBe("Tab Fix login is over the left edge of the whole pane area.");
    expect(overText(tab, null, names)).toBe("Tab Fix login is over no place to drop.");
  });

  it("say what the drop did, or that it was cancelled", () => {
    expect(droppedText(tab, { kind: "edge", pane: "p-2", edge: "right" }, names)).toBe("Tab Fix login was dropped on the right edge of the pane of Diff.");
    expect(droppedText(tab, null, names)).toBe("Tab Fix login was put back.");
    expect(cancelledText(pane, names)).toBe("Moving the pane of Fix login (3 tabs) was cancelled.");
  });

  it("name a thread dragged from the sidebar, which joins a strip as a new tab", () => {
    const thread: DragSource = { kind: "thread", thread: "th-1" };
    expect(pickedUpText(thread, names)).toMatch(/^Picked up thread Plan the trip\./);
    expect(overText(thread, { kind: "strip", pane: "p-2", index: 1 }, names)).toBe("Thread Plan the trip is over position 2 of 2 in the pane of Diff.");
    expect(droppedText(thread, { kind: "outer", edge: "right" }, names)).toBe("Thread Plan the trip was dropped on the right edge of the whole pane area.");
    expect(droppedText(thread, null, names)).toBe("Thread Plan the trip was not opened.");
  });
});
