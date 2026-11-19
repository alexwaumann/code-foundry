import { describe, expect, it } from "vitest";
import { previewOf, switchQuestion, type SwitchPreview } from "./threadsOpenAsSwitch";

const p = (o: Partial<SwitchPreview>): SwitchPreview => ({ threadTabs: 0, composers: 0, panes: 0, moved: 0, spaces: 1, ...o });
const LOST_PANES = "\n\nNothing is lost: those threads stay in the sidebar and keep running, and each one's diff, files and terminals come back when you open it.";
const LOST_SINGLE = "\n\nNothing is lost: those threads stay in the sidebar and keep running.";

describe("the switch dialog's words", () => {
  it("reads the daemon's preview", () => {
    expect(previewOf('{"to":"panes","thread_tabs":2,"composers":1,"panes":0,"moved":3,"spaces":2}')).toEqual({ threadTabs: 2, composers: 1, panes: 0, moved: 3, spaces: 2 });
    expect(previewOf("not json")).toEqual(p({ spaces: 0 }));
  });

  it("asks nothing when nothing closes or moves, nor toward Tabs", () => {
    expect(switchQuestion("panes", p({}))).toBeNull();
    expect(switchQuestion("single", p({}))).toBeNull();
    expect(switchQuestion("tabs", p({ threadTabs: 4 }))).toBeNull();
  });

  it.each<[string, string, SwitchPreview, string]>([
    ["panes, plural", "panes", p({ threadTabs: 3, spaces: 2 }), `Each pane keeps the thread it is showing now. 3 other thread tabs in 2 spaces will close.${LOST_PANES}`],
    ["panes, singular", "panes", p({ threadTabs: 1 }), `Each pane keeps the thread it is showing now. 1 other thread tab in 1 space will close.${LOST_PANES}`],
    ["panes, a composer counts as a thread tab", "panes", p({ threadTabs: 1, composers: 1 }), `Each pane keeps the thread it is showing now. 2 other thread tabs in 1 space will close.${LOST_PANES}`],
    ["panes, tabs that move", "panes", p({ threadTabs: 2, moved: 3 }), `Each pane keeps the thread it is showing now. 2 other thread tabs in 1 space will close. 3 other tabs move to a pane of their own.${LOST_PANES}`],
    ["panes, only a move", "panes", p({ moved: 1 }), "Each pane keeps the thread it is showing now. 1 other tab moves to a pane of its own."],
    ["single, panes", "single", p({ threadTabs: 2, panes: 2 }), `Each space keeps the thread pane you used last. 2 other thread panes will close.${LOST_SINGLE}`],
    ["single, one pane", "single", p({ threadTabs: 1, panes: 1 }), `Each space keeps the thread pane you used last. 1 other thread pane will close.${LOST_SINGLE}`],
    ["single, panes with more tabs", "single", p({ threadTabs: 5, panes: 2 }), `Each space keeps the thread pane you used last. 2 other thread panes (5 thread tabs) will close.${LOST_SINGLE}`],
    ["single, tabs of the kept pane only", "single", p({ threadTabs: 2 }), `Each space keeps the thread pane you used last. 2 other thread tabs will close.${LOST_SINGLE}`],
  ])("%s", (_name, to, preview, message) => {
    const q = switchQuestion(to, preview);
    expect(q?.message).toBe(message);
    expect(q?.title).toBe(to === "panes" ? "Switch to Panes?" : "Switch to Single?");
    expect(q?.confirmLabel).toBe(to === "panes" ? "Switch to Panes" : "Switch to Single");
  });
});
