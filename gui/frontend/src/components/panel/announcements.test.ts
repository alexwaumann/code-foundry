import { beforeEach, describe, expect, it } from "vitest";
import { makeTab, usePanelStore } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import { droppedText, overText, tabAnnouncer } from "./announcements";
import type { DropTarget } from "./dragDrop";

const KEY = "thread:a";
const a = makeTab("files", "Files");
const b = makeTab("diff", "Diff");
const c = makeTab("pullrequest", "#12", { number: "12" });

beforeEach(() => {
  useUiStore.setState({ selection: { kind: "thread", id: "a" } });
  usePanelStore.setState({
    byKey: {
      [KEY]: {
        open: true,
        groups: [
          { tabs: [a, b], activeTabId: a.id },
          { tabs: [c], activeTabId: c.id },
        ],
      },
    },
  });
});

describe("overText", () => {
  it.each<[string, DropTarget | null, string]>([
    ["nothing", null, "Tab Files is no longer over a place to drop it."],
    ["its own strip", { kind: "reorder", overId: b.id }, "Tab Files is over position 2 of 2."],
    ["the other strip, counting the tab it would add", { kind: "strip", group: 1, index: 1 }, "Tab Files is over the second group's tabs, position 2 of 2."],
    ["the other body", { kind: "body", group: 1 }, "Tab Files is over the second group."],
    ["the band", { kind: "band" }, "Tab Files is over the edge of the side panel: dropping it there splits the panel."],
  ])("%s", (_name, t, want) => {
    expect(overText(KEY, a.id, "Files", t)).toBe(want);
  });
});

describe("droppedText", () => {
  // The store is as the drop left it: the text reads the tab's place there.
  it.each<[string, string, string, DropTarget | null, string]>([
    ["nothing", a.id, "Files", null, "Tab Files was dropped."],
    ["a reorder: where it is now", a.id, "Files", { kind: "reorder", overId: b.id }, "Tab Files was dropped at position 1 of 2."],
    ["moved to the other strip: where it is now", c.id, "#12", { kind: "strip", group: 1, index: 0 }, "Tab #12 was moved to the second group, position 1 of 1."],
    ["onto the other body", c.id, "#12", { kind: "body", group: 1 }, "Tab #12 was moved to the second group, position 1 of 1."],
    ["the band", b.id, "Diff", { kind: "band" }, "Tab Diff was moved to a new second group."],
    ["a tab closed mid-drag", "gone", "Gone", { kind: "band" }, "Tab Gone was dropped."],
  ])("%s", (_name, id, title, t, want) => {
    expect(droppedText(KEY, id, title, t)).toBe(want);
  });
});

describe("tabAnnouncer", () => {
  it("names the tab by title and says what track() last set", () => {
    const { announcements, track } = tabAnnouncer(KEY);
    const active = { id: a.id } as Parameters<typeof announcements.onDragStart>[0]["active"];
    expect(announcements.onDragStart({ active })).toBe("Picked up tab Files.");
    track({ kind: "body", group: 1 });
    expect(announcements.onDragOver({ active, over: null })).toBe("Tab Files is over the second group.");
    track(null);
    expect(announcements.onDragEnd({ active, over: null })).toBe("Tab Files was dropped.");
    expect(announcements.onDragCancel({ active, over: null })).toBe("Moving tab Files was cancelled.");
  });
});
