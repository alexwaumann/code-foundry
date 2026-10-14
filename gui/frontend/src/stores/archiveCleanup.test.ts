import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import { newlyArchived, newlySnoozed, startArchiveCleanup } from "./archiveCleanup";
import { useBottomStore } from "./bottomPanel";
import { emptyEntry, makeTab, usePanelStore } from "./panel";
import { applySessionEvent, emptySessions, replaceSessions, useSessionsStore } from "./sessions";

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
});
