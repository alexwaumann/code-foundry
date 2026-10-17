import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { newlyArchived, newlyRemoved, newlySnoozed, putAwaySelected, startArchiveCleanup } from "./archiveCleanup";
import { useBottomStore } from "./bottomPanel";
import { emptyEntry, makeTab, usePanelStore } from "./panel";
import { applyThreadListEvent, emptyThreads, replaceThreads, useThreadsStore } from "./threads";
import { DASHBOARD, useUiStore, type Selection } from "./ui";

const thread = (id: string, archivedAtMs: number | null = null, snoozedUntilMs: number | null = null) =>
  ({ id, createdAtMs: 1, archivedAtMs, snoozedUntilMs, linkedPullRequests: [], usage: [], agentRuns: [] }) as unknown as ThreadView;
const snoozed = (id: string, until: number) => thread(id, null, until);

describe("newlyArchived", () => {
  const before = replaceThreads(emptyThreads, [thread("a"), thread("b"), thread("c", 5)]);
  it.each<[string, ThreadView[], string[]]>([
    ["nothing changed", [thread("a"), thread("b"), thread("c", 5)], []],
    ["a archived", [thread("a", 9), thread("b"), thread("c", 5)], ["a"]],
    ["a and b archived", [thread("a", 9), thread("b", 9), thread("c", 5)], ["a", "b"]],
    ["c unarchived", [thread("a"), thread("b"), thread("c")], []],
    ["c archived again (a new stamp)", [thread("a"), thread("b"), thread("c", 6)], []],
    ["a new thread that is archived (not a transition)", [thread("a"), thread("b"), thread("c", 5), thread("d", 9)], []],
    ["a removed", [thread("b"), thread("c", 5)], []],
  ])("%s", (_name, list, want) => {
    expect(newlyArchived(before, replaceThreads(before, list))).toEqual(want);
  });

  it("the first snapshot resets nothing", () => {
    expect(newlyArchived(emptyThreads, before)).toEqual([]);
  });
});

describe("newlySnoozed", () => {
  const before = replaceThreads(emptyThreads, [thread("a"), thread("b"), snoozed("c", 5)]);
  it.each<[string, ThreadView[], string[]]>([
    ["nothing changed", [thread("a"), thread("b"), snoozed("c", 5)], []],
    ["a snoozed", [snoozed("a", 9), thread("b"), snoozed("c", 5)], ["a"]],
    ["a and b snoozed", [snoozed("a", 9), snoozed("b", 9), snoozed("c", 5)], ["a", "b"]],
    ["c woke or unsnoozed", [thread("a"), thread("b"), thread("c")], []],
    ["c snoozed to another time", [thread("a"), thread("b"), snoozed("c", 6)], []],
    ["a archived (not a snooze)", [thread("a", 9), thread("b"), snoozed("c", 5)], []],
    ["a new thread that is snoozed (not a transition)", [thread("a"), thread("b"), snoozed("c", 5), snoozed("d", 9)], []],
  ])("%s", (_name, list, want) => {
    expect(newlySnoozed(before, replaceThreads(before, list))).toEqual(want);
  });

  it("the first snapshot resets nothing", () => {
    expect(newlySnoozed(emptyThreads, before)).toEqual([]);
  });
});

describe("newlyRemoved", () => {
  const before = replaceThreads(emptyThreads, [thread("a"), thread("b"), thread("c", 5)]);
  it.each<[string, ThreadView[], string[]]>([
    ["nothing changed", [thread("a"), thread("b"), thread("c", 5)], []],
    ["a removed", [thread("b"), thread("c", 5)], ["a"]],
    ["a and c removed", [thread("b")], ["a", "c"]],
    ["a archived (still there)", [thread("a", 9), thread("b"), thread("c", 5)], []],
    ["a new thread", [thread("a"), thread("b"), thread("c", 5), thread("d")], []],
  ])("%s", (_name, list, want) => {
    expect(newlyRemoved(before, replaceThreads(before, list))).toEqual(want);
  });

  it("a removed event for an unknown id removes nothing", () => {
    expect(newlyRemoved(before, applyThreadListEvent(before, { kind: "removed", id: "zz" }))).toEqual([]);
  });
});

describe("putAwaySelected", () => {
  const putAway = new Set(["a"]);
  it.each<[string, Selection, boolean]>([
    ["the put-away thread is selected", { kind: "thread", id: "a" }, true],
    ["another thread is selected", { kind: "thread", id: "b" }, false],
    ["the dashboard is selected", DASHBOARD, false],
    ["a composer is selected", { kind: "compose", repoId: "r" }, false],
    ["nothing is selected", { kind: "none" }, false],
  ])("%s", (_name, sel, want) => {
    expect(putAwaySelected(sel, putAway)).toBe(want);
  });
});

describe("startArchiveCleanup", () => {
  let stop: () => void;
  const tab = makeTab("worktree", "Worktree");
  beforeEach(() => {
    useThreadsStore.setState({ ...replaceThreads(emptyThreads, [thread("a"), thread("b")]) });
    usePanelStore.setState({
      byKey: {
        "thread:a": { open: true, tabs: [tab], activeTabId: tab.id, width: 500 },
        "thread:b": { open: true, tabs: [tab], activeTabId: tab.id },
      },
    });
    useBottomStore.setState({ byKey: { "thread:a": { open: true, height: 300, activeTerminalId: "t1" }, "thread:b": { open: true } } });
    stop = startArchiveCleanup();
  });
  afterEach(() => {
    stop();
  });

  it("an archived thread's side panel loses its tabs and closes, and its bottom panel closes; others are untouched", () => {
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", 42) }));
    expect(usePanelStore.getState().byKey["thread:a"]).toEqual(emptyEntry);
    expect(useBottomStore.getState().byKey["thread:a"]).toEqual({ open: false });
    expect(usePanelStore.getState().byKey["thread:b"]?.open).toBe(true);
    expect(useBottomStore.getState().byKey["thread:b"]?.open).toBe(true);
  });

  it("unarchiving, and opening an archived thread's panels afterwards, change nothing", () => {
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", 42) }));
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "thread:a": { open: true, tabs: [tab], activeTabId: tab.id } } }));
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("b") })); // unrelated update
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a") })); // unarchived
    expect(usePanelStore.getState().byKey["thread:a"]?.open).toBe(true);
  });

  it("a snoozed thread's panels reset like an archived one's; a re-snooze or a wake changes nothing", () => {
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: snoozed("b", 42) }));
    expect(usePanelStore.getState().byKey["thread:b"]).toEqual(emptyEntry);
    expect(useBottomStore.getState().byKey["thread:b"]).toEqual({ open: false });
    expect(usePanelStore.getState().byKey["thread:a"]?.open).toBe(true);
    expect(useBottomStore.getState().byKey["thread:a"]?.open).toBe(true);
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "thread:b": { open: true, tabs: [tab], activeTabId: tab.id } } }));
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: snoozed("b", 43) })); // another time
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("b") })); // woke
    expect(usePanelStore.getState().byKey["thread:b"]?.open).toBe(true);
  });

  it("a thread with no stored panels gets no entries", () => {
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("a"), thread("b"), thread("z")]) }));
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("z", 1) }));
    expect("thread:z" in usePanelStore.getState().byKey).toBe(false);
    expect("thread:z" in useBottomStore.getState().byKey).toBe(false);
  });

  describe("selection", () => {
    const select = (sel: Selection) => useUiStore.setState({ selection: sel });
    const selection = () => useUiStore.getState().selection;

    it("archiving the selected thread selects the dashboard", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", 42) }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("snoozing the selected thread selects the dashboard", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: snoozed("a", 42) }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("a removed event for the selected thread selects the dashboard", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: "a" }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("a snapshot without the selected thread selects the dashboard", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "snapshot", threads: [thread("b")], retiredUsage: [] }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("putting away or removing another thread leaves the selection alone", () => {
      const sel: Selection = { kind: "thread", id: "a" };
      select(sel);
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("b", 42) }));
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: snoozed("b", 43) }));
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: "b" }));
      expect(selection()).toBe(sel);
    });

    it("unarchiving, waking and unrelated updates leave the selection alone", () => {
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", 42) }));
      const sel: Selection = { kind: "thread", id: "a" };
      select(sel); // the user picked the archived thread again
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a") })); // unarchived
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("b") }));
      expect(selection()).toBe(sel);
    });

    it("a page or composer selection is never touched", () => {
      select({ kind: "view", name: "projects" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: "a" }));
      expect(selection()).toEqual({ kind: "view", name: "projects" });
    });
  });
});
