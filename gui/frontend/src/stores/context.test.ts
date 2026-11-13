import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { decodeThreadListKeys, deriveContext, encodeThreadListKey, getListOptions, getListThreads, getUiContext } from "./context";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { HOME, useUiStore } from "./ui";

describe("getUiContext", () => {
  beforeEach(() => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: {}, order: [] });
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
  });

  it("is the window's selection's context, or an explicit selection's", () => {
    expect(getUiContext()).toEqual(deriveContext({ kind: "thread", id: "s1" }, useProjectsStore.getState()));
    expect(getUiContext()).toMatchObject({ activeThreadId: "s1", activeTerminalId: "" });
    expect(getUiContext({ kind: "view", name: "projects" })).toMatchObject({ activeThreadId: "", activeView: "projects" });
  });
});

describe("the sidebar list's keys", () => {
  const thread = (o: Partial<ThreadView>) =>
    ({ id: "s1", state: "connected", status: "idle", statusReason: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", statusChangedAtMs: 100, lastActivityAtMs: 200, ...o }) as ThreadView;
  type Want = { pinned: boolean; group: string; archivedAtMs: number | null; snoozedUntilMs: number | null; statusChangedAtMs: number | null; lastActivityAtMs: number | null; hidden?: true };
  // The keys carry only the band's sort time: the last activity for idle, the status change for attention and done.
  const IDLE = { statusChangedAtMs: null, lastActivityAtMs: 200 };
  const BY_STATUS = { statusChangedAtMs: 100, lastActivityAtMs: null };
  const NONE = { statusChangedAtMs: null, lastActivityAtMs: null };
  // The thread list the rule looks creators up in: "p" exists, "gone" was removed.
  const BY_ID = { p: {} };

  it.each<[string, Partial<ThreadView>, Want]>([
    ["idle", {}, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE }],
    ["finished", { status: "attention", statusReason: "finished" }, { pinned: false, group: "done", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }],
    ["error", { state: "disconnected", status: "error", statusReason: "crashed" }, { pinned: false, group: "error", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS }],
    ["working", { status: "busy" }, { pinned: false, group: "working", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["pinned and idle", { pinned: true }, { pinned: true, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["idle, times unknown", { statusChangedAtMs: null, lastActivityAtMs: null }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["pinned and busy", { pinned: true, status: "busy" }, { pinned: true, group: "working", archivedAtMs: null, snoozedUntilMs: null, ...NONE }],
    ["archived", { state: "disconnected", archivedAtMs: 1760352000123 }, { pinned: false, group: "idle", archivedAtMs: 1760352000123, snoozedUntilMs: null, ...NONE }],
    ["snoozed", { state: "disconnected", snoozedUntilMs: 1760518800000 }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 1760518800000, ...NONE }],
    [
      "woken (snooze ended)",
      { state: "disconnected", status: "attention", statusReason: "snooze ended" },
      { pinned: false, group: "prompt", archivedAtMs: null, snoozedUntilMs: null, ...BY_STATUS },
    ],
    ["created by a thread, its creator present: hidden", { createdBy: "p" }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE, hidden: true }],
    ["created by a thread, its creator removed: shown", { createdBy: "gone" }, { pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...IDLE }],
  ])("round-trips %s", (_name, o, want) => {
    expect(decodeThreadListKeys([encodeThreadListKey("s1", thread(o), BY_ID)])).toEqual([{ id: "s1", ...want }]);
  });

  it("an unknown thread decodes as an idle, unarchived, unsnoozed, shown thread", () => {
    expect(decodeThreadListKeys([encodeThreadListKey("s9", undefined, BY_ID)])).toEqual([{ id: "s9", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, ...NONE }]);
  });

  it("getListThreads and getListOptions read the stores (archive and snooze times, hidden and orphaned threads, the collapsed states)", () => {
    useThreadsStore.setState({ byId: { s1: thread({ archivedAtMs: 5 }), s2: thread({ id: "s2", snoozedUntilMs: 7 }), s3: thread({ id: "s3", createdBy: "s1" }), s4: thread({ id: "s4", createdBy: "gone" }) }, order: ["s1", "s2", "s3", "s4"] });
    useUiStore.setState({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true, selection: HOME });
    expect(getListThreads()).toEqual([
      { id: "s1", pinned: false, group: "idle", archivedAtMs: 5, snoozedUntilMs: null, statusChangedAtMs: 100, lastActivityAtMs: 200 },
      { id: "s2", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: 7, statusChangedAtMs: 100, lastActivityAtMs: 200 },
      // Its creator (s1, archived) still exists: hidden.
      { id: "s3", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, statusChangedAtMs: 100, lastActivityAtMs: 200, hidden: true },
      // Its creator was removed: shown.
      { id: "s4", pinned: false, group: "idle", archivedAtMs: null, snoozedUntilMs: null, statusChangedAtMs: 100, lastActivityAtMs: 200 },
    ]);
    expect(getListOptions()).toEqual({ workingCollapsed: true, archivedCollapsed: false, snoozedCollapsed: true, openThreadId: null });
    // The open thread keeps its row under a collapsed header, so cmd+1..9 count it as the sidebar shows it.
    useUiStore.setState({ selection: { kind: "thread", id: "s2" } });
    expect(getListOptions().openThreadId).toBe("s2");
  });
});
