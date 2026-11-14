import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import type { ThreadView } from "@/api/threads";
import { newlyArchived, newlyRemoved, newlySnoozed, putAwaySelected, startArchiveCleanup } from "./archiveCleanup";
import { reconcileThreads } from "./events";
import { fileEditKey, noteDraft, startEdit, useFileEditStore } from "./fileEdit";
import { makeTab } from "@/shell/host";
import { useRecentFilesStore } from "./recentFiles";
import { applyThreadListEvent, emptyThreads, replaceThreads, useThreadsStore } from "./threads";
import { HOME, useUiStore, type Selection } from "./ui";

// The library's memory of a draft (lib/codeEditor.ts).
const dropped = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/codeEditor", () => ({
  loadCodeEditor: () => Promise.resolve(),
  draftText: () => "draft",
  forgetDraft: (k: string) => {
    dropped.push(k);
  },
}));

const listThreads = vi.hoisted(() => vi.fn());
vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), listThreads }));

const thread = (id: string, archivedAtMs: number | null = null, snoozedUntilMs: number | null = null) =>
  ({ id, createdAtMs: 1, archivedAtMs, snoozedUntilMs, linkedPullRequests: [], usage: [], agentRuns: [] }) as unknown as ThreadView;
const snoozed = (id: string, until: number) => thread(id, null, until);
const saved = (id: string) => ({ ...thread(id), savedAtMs: 7 }) as ThreadView;

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
    ["a saved for later", [saved("a"), thread("b"), snoozed("c", 5)], ["a"]],
    ["c saved instead of timed (still put away)", [thread("a"), thread("b"), saved("c")], []],
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
    ["HOME is selected", HOME, false],
    ["a composer is selected", { kind: "compose", projectId: "r" }, false],
    ["nothing is selected", { kind: "none" }, false],
  ])("%s", (_name, sel, want) => {
    expect(putAwaySelected(sel, putAway)).toBe(want);
  });
});

describe("startArchiveCleanup", () => {
  let stop: () => void;
  beforeEach(() => {
    useThreadsStore.setState({ ...replaceThreads(emptyThreads, [thread("a"), thread("b")]), loaded: true });
    stop = startArchiveCleanup();
  });
  afterEach(() => {
    stop();
  });

  // Where an archived or snoozed thread's tabs go is the layout's (the daemon's); only a removal drops what nothing can reach.
  describe("a File tab with unsaved edits", () => {
    const file = { ...makeTab("files", "File"), id: "files:env", title: ".env" };
    const key = fileEditKey("thread:a", file.id);
    const view: FileReadView = { path: "/w/.env", realPath: "", mode: 0, size: 4, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 1, notFound: false, isDir: false, outsideHome: false, text: "a=1\n", lossless: true, image: null, pdf: null };
    const session = () => useFileEditStore.getState().sessions[key];

    beforeEach(async () => {
      dropped.length = 0;
      await startEdit(key, { panelKey: "thread:a", tabId: file.id, base: "/w" }, view);
    });
    afterEach(() => {
      useFileEditStore.setState({ sessions: {} });
    });

    it.each<[string, Parameters<typeof applyThreadListEvent>[1]]>([
      ["a removed event", { kind: "removed", id: "a" }],
      ["a snapshot without the thread", { kind: "snapshot", threads: [thread("b")], retiredUsage: [] }],
    ])("the thread removed (%s) drops the draft: nothing could reach it again", (_name, event) => {
      noteDraft(key, "SECRET=draft\n");
      const stateKey = session()?.stateKey ?? "";
      useThreadsStore.setState((s) => applyThreadListEvent(s, event));
      expect(session()).toBeUndefined();
      expect(dropped).toContain(stateKey);
    });
  });

  describe("a thread list that failed", () => {
    const file = makeTab("files", ".env");
    const key = fileEditKey("thread:a", file.id);
    const fails = (err: Error) => {
      listThreads.mockRejectedValue(err);
      return reconcileThreads(new AbortController().signal);
    };

    beforeEach(async () => {
      await startEdit(key, { panelKey: "thread:a", tabId: file.id, base: "/w" }, { path: "/w/.env", realPath: "", mode: 0, size: 4, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 100, notFound: false, isDir: false, outsideHome: false, text: "a=1\n", lossless: true, image: null, pdf: null } satisfies FileReadView);
      noteDraft(key, "SECRET=draft\n");
    });
    afterEach(() => {
      useFileEditStore.setState({ sessions: {} });
    });

    it.each<[string, Error]>([
      ["NotFound", new ConnectError("no such service", Code.NotFound)],
      ["Unavailable", new ConnectError("daemon restarting", Code.Unavailable)],
    ])("%s: the list keeps its threads and says why, and no draft goes", async (_name, err) => {
      await fails(err);
      expect(useThreadsStore.getState()).toMatchObject({ order: ["a", "b"], error: (err as ConnectError).rawMessage });
      expect(useFileEditStore.getState().sessions[key]?.dirty).toBe(true);
    });

    it("the list coming back clears the error and finds the draft where it was", async () => {
      await fails(new ConnectError("daemon restarting", Code.Unavailable));
      listThreads.mockResolvedValue([thread("a"), thread("b")]);
      await reconcileThreads(new AbortController().signal);
      expect(useThreadsStore.getState().error).toBeNull();
      expect(useFileEditStore.getState().sessions[key]?.dirty).toBe(true);
    });

    it("a list that answers without the thread is its removal", async () => {
      listThreads.mockResolvedValue([thread("b")]);
      await reconcileThreads(new AbortController().signal);
      expect(useFileEditStore.getState().sessions[key]).toBeUndefined();
    });
  });

  it.each<[string, Parameters<typeof applyThreadListEvent>[1]]>([
    ["a removed event", { kind: "removed", id: "a" }],
    ["a snapshot without the thread", { kind: "snapshot", threads: [thread("b")], retiredUsage: [] }],
  ])("a removed thread (%s) loses its recent files entry; others are untouched", (_name, event) => {
    const recent = { project: "p", base: "/w", path: "/w/a.go" };
    useRecentFilesStore.setState({ byKey: { "thread:a": [recent], "thread:b": [recent] } });
    useThreadsStore.setState((s) => applyThreadListEvent(s, event));
    expect("thread:a" in useRecentFilesStore.getState().byKey).toBe(false);
    expect(useRecentFilesStore.getState().byKey["thread:b"]).toEqual([recent]);
  });

  describe("selection", () => {
    const select = (sel: Selection) => useUiStore.setState({ selection: sel });
    const selection = () => useUiStore.getState().selection;

    it("archiving the selected thread selects HOME (the No project composer)", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", 42) }));
      expect(selection()).toEqual(HOME);
    });

    it("snoozing the selected thread selects HOME (the No project composer)", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: snoozed("a", 42) }));
      expect(selection()).toEqual(HOME);
    });

    it("a removed event for the selected thread selects HOME (the No project composer)", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: "a" }));
      expect(selection()).toEqual(HOME);
    });

    it("a snapshot without the selected thread selects HOME (the No project composer)", () => {
      select({ kind: "thread", id: "a" });
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "snapshot", threads: [thread("b")], retiredUsage: [] }));
      expect(selection()).toEqual(HOME);
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
