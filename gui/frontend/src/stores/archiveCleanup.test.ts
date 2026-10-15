import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import { newlyArchived, newlyRemoved, newlySnoozed, putAwaySelected, startArchiveCleanup } from "./archiveCleanup";
import { useBottomStore } from "./bottomPanel";
import { emptyEntry, makeTab, usePanelStore } from "./panel";
import { applySessionEvent, emptySessions, replaceSessions, useSessionsStore } from "./sessions";
import { DASHBOARD, useUiStore, type Selection } from "./ui";

const session = (id: string, archivedAtMs: number | null = null, snoozedUntilMs: number | null = null) =>
  ({ id, createdAtMs: 1, archivedAtMs, snoozedUntilMs, linkedPullRequests: [], usage: [], agentRuns: [] }) as unknown as SessionView;
const snoozed = (id: string, until: number) => session(id, null, until);

describe("newlyArchived", () => {
  const before = replaceSessions(emptySessions, [session("a"), session("b"), session("c", 5)]);
  it.each<[string, SessionView[], string[]]>([
    ["nothing changed", [session("a"), session("b"), session("c", 5)], []],
    ["a archived", [session("a", 9), session("b"), session("c", 5)], ["a"]],
    ["a and b archived", [session("a", 9), session("b", 9), session("c", 5)], ["a", "b"]],
    ["c unarchived", [session("a"), session("b"), session("c")], []],
    ["c archived again (a new stamp)", [session("a"), session("b"), session("c", 6)], []],
    ["a new thread that is archived (not a transition)", [session("a"), session("b"), session("c", 5), session("d", 9)], []],
    ["a removed", [session("b"), session("c", 5)], []],
  ])("%s", (_name, list, want) => {
    expect(newlyArchived(before, replaceSessions(before, list))).toEqual(want);
  });

  it("the first snapshot resets nothing", () => {
    expect(newlyArchived(emptySessions, before)).toEqual([]);
  });
});

describe("newlySnoozed", () => {
  const before = replaceSessions(emptySessions, [session("a"), session("b"), snoozed("c", 5)]);
  it.each<[string, SessionView[], string[]]>([
    ["nothing changed", [session("a"), session("b"), snoozed("c", 5)], []],
    ["a snoozed", [snoozed("a", 9), session("b"), snoozed("c", 5)], ["a"]],
    ["a and b snoozed", [snoozed("a", 9), snoozed("b", 9), snoozed("c", 5)], ["a", "b"]],
    ["c woke or unsnoozed", [session("a"), session("b"), session("c")], []],
    ["c snoozed to another time", [session("a"), session("b"), snoozed("c", 6)], []],
    ["a archived (not a snooze)", [session("a", 9), session("b"), snoozed("c", 5)], []],
    ["a new thread that is snoozed (not a transition)", [session("a"), session("b"), snoozed("c", 5), snoozed("d", 9)], []],
  ])("%s", (_name, list, want) => {
    expect(newlySnoozed(before, replaceSessions(before, list))).toEqual(want);
  });

  it("the first snapshot resets nothing", () => {
    expect(newlySnoozed(emptySessions, before)).toEqual([]);
  });
});

describe("newlyRemoved", () => {
  const before = replaceSessions(emptySessions, [session("a"), session("b"), session("c", 5)]);
  it.each<[string, SessionView[], string[]]>([
    ["nothing changed", [session("a"), session("b"), session("c", 5)], []],
    ["a removed", [session("b"), session("c", 5)], ["a"]],
    ["a and c removed", [session("b")], ["a", "c"]],
    ["a archived (still there)", [session("a", 9), session("b"), session("c", 5)], []],
    ["a new thread", [session("a"), session("b"), session("c", 5), session("d")], []],
  ])("%s", (_name, list, want) => {
    expect(newlyRemoved(before, replaceSessions(before, list))).toEqual(want);
  });

  it("a removed event for an unknown id removes nothing", () => {
    expect(newlyRemoved(before, applySessionEvent(before, { kind: "removed", id: "zz" }))).toEqual([]);
  });
});

describe("putAwaySelected", () => {
  const putAway = new Set(["a"]);
  it.each<[string, Selection, boolean]>([
    ["the put-away thread is selected", { kind: "session", id: "a" }, true],
    ["another thread is selected", { kind: "session", id: "b" }, false],
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
    useSessionsStore.setState({ ...replaceSessions(emptySessions, [session("a"), session("b")]) });
    usePanelStore.setState({
      byKey: {
        "session:a": { open: true, tabs: [tab], activeTabId: tab.id, width: 500 },
        "session:b": { open: true, tabs: [tab], activeTabId: tab.id },
      },
    });
    useBottomStore.setState({ byKey: { "session:a": { open: true, height: 300, activeTerminalId: "t1" }, "session:b": { open: true } } });
    stop = startArchiveCleanup();
  });
  afterEach(() => {
    stop();
  });

  it("an archived thread's side panel loses its tabs and closes, and its bottom panel closes; others are untouched", () => {
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a", 42) }));
    expect(usePanelStore.getState().byKey["session:a"]).toEqual(emptyEntry);
    expect(useBottomStore.getState().byKey["session:a"]).toEqual({ open: false });
    expect(usePanelStore.getState().byKey["session:b"]?.open).toBe(true);
    expect(useBottomStore.getState().byKey["session:b"]?.open).toBe(true);
  });

  it("unarchiving, and opening an archived thread's panels afterwards, change nothing", () => {
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a", 42) }));
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "session:a": { open: true, tabs: [tab], activeTabId: tab.id } } }));
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("b") })); // unrelated update
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a") })); // unarchived
    expect(usePanelStore.getState().byKey["session:a"]?.open).toBe(true);
  });

  it("a snoozed thread's panels reset like an archived one's; a re-snooze or a wake changes nothing", () => {
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: snoozed("b", 42) }));
    expect(usePanelStore.getState().byKey["session:b"]).toEqual(emptyEntry);
    expect(useBottomStore.getState().byKey["session:b"]).toEqual({ open: false });
    expect(usePanelStore.getState().byKey["session:a"]?.open).toBe(true);
    expect(useBottomStore.getState().byKey["session:a"]?.open).toBe(true);
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "session:b": { open: true, tabs: [tab], activeTabId: tab.id } } }));
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: snoozed("b", 43) })); // another time
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("b") })); // woke
    expect(usePanelStore.getState().byKey["session:b"]?.open).toBe(true);
  });

  it("a thread with no stored panels gets no entries", () => {
    useSessionsStore.setState((s) => ({ ...replaceSessions(s, [session("a"), session("b"), session("z")]) }));
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("z", 1) }));
    expect("session:z" in usePanelStore.getState().byKey).toBe(false);
    expect("session:z" in useBottomStore.getState().byKey).toBe(false);
  });

  describe("selection", () => {
    const select = (sel: Selection) => useUiStore.setState({ selection: sel });
    const selection = () => useUiStore.getState().selection;

    it("archiving the selected thread selects the dashboard", () => {
      select({ kind: "session", id: "a" });
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a", 42) }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("snoozing the selected thread selects the dashboard", () => {
      select({ kind: "session", id: "a" });
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: snoozed("a", 42) }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("a removed event for the selected thread selects the dashboard", () => {
      select({ kind: "session", id: "a" });
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "removed", id: "a" }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("a snapshot without the selected thread selects the dashboard", () => {
      select({ kind: "session", id: "a" });
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "snapshot", sessions: [session("b")], retiredUsage: [] }));
      expect(selection()).toEqual(DASHBOARD);
    });

    it("putting away or removing another thread leaves the selection alone", () => {
      const sel: Selection = { kind: "session", id: "a" };
      select(sel);
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("b", 42) }));
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: snoozed("b", 43) }));
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "removed", id: "b" }));
      expect(selection()).toBe(sel);
    });

    it("unarchiving, waking and unrelated updates leave the selection alone", () => {
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a", 42) }));
      const sel: Selection = { kind: "session", id: "a" };
      select(sel); // the user picked the archived thread again
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("a") })); // unarchived
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: session("b") }));
      expect(selection()).toBe(sel);
    });

    it("a page or composer selection is never touched", () => {
      select({ kind: "view", name: "projects" });
      useSessionsStore.setState((s) => applySessionEvent(s, { kind: "removed", id: "a" }));
      expect(selection()).toEqual({ kind: "view", name: "projects" });
    });
  });
});
