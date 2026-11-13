import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/lib/codeEditor", () => ({ loadCodeEditor: () => Promise.resolve(), draftText: () => null, forgetDraft: () => undefined }));

const { appliedOps, layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { applyLayoutOp } = await import("@/api/layout");
const { openTab } = await import("@/shell/host");
const { blankFile } = await import("@/api/files");
const { fileTab } = await import("@/surfaces/fileTarget");
const { fileEditKey, noteEditor, startEdit, useFileEditStore } = await import("./fileEdit");
const { useLayoutStore } = await import("./layout");
const { useThreadsStore } = await import("./threads");
const { startFileRequests } = await import("./fileRequestArrivals");

const WT = "/wt/b";
const A = `${WT}/a.env`;
const ENV = `${WT}/.env`;
const a = fileTab({ project: "web", base: WT, path: A });
const b = fileTab({ project: "web", base: WT, path: ENV });
const KEY = "thread:b";
const thread = (id: string) => ({ id, projectId: "web", worktreePath: WT, workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [] }) as unknown as ThreadView;

/** What the daemon's view.open.file --edit sends: thread b's tab, the request in its params. */
const request = (over: Record<string, string> = {}, pane?: string) =>
  applyLayoutOp({
    op: "open_surface",
    tab: { kind: "file", thread: "b", params: { path: ENV, project: "web", base: WT, edit: "1", asker: "b", askId: over.askId ?? "ask-1", ...over } },
    focus: false,
    ...(pane ? { pane } : {}),
  });

const tabOf = (path: string) => Object.values(useLayoutStore.getState().tabs).find((t) => t.params.path === path);
const activeIn = (pane: string) => useLayoutStore.getState().panes[pane]?.active;

let stop: () => void = () => undefined;
let wrap: HTMLElement | null = null;

/** The user types in tab A's editor: a session for it, the keyboard in its document. */
async function typingInA(): Promise<void> {
  const key = fileEditKey(KEY, a.id);
  await startEdit(key, { panelKey: KEY, tabId: a.id, base: WT }, { ...blankFile(A), text: "x\n" });
  wrap = document.createElement("div");
  wrap.setAttribute("data-code-editor", useFileEditStore.getState().sessions[key]?.stateKey ?? "");
  const host = document.createElement("div");
  host.tabIndex = -1;
  wrap.append(host);
  document.body.append(wrap);
  host.focus();
}

beforeEach(async () => {
  const seed = threadSeed("a");
  seed.spaces[0]?.root?.tabs?.push({ id: "t-b", kind: "thread", thread: "b" });
  await resetFakeLayout(seed);
  useThreadsStore.setState({ byId: { a: thread("a"), b: thread("b") }, order: ["a", "b"] });
  useFileEditStore.setState({ sessions: {} });
});

afterEach(async () => {
  stop();
  wrap?.remove();
  wrap = null;
  await layoutSettled();
});

describe("a thread's request to edit a file, as it arrives in the layout", () => {
  it("with focus=1 the editor takes the keyboard at the end of the line, once it is on screen", async () => {
    stop = startFileRequests();
    await request({ focus: "1", line: "2" });
    await layoutSettled();
    const focus = vi.fn();
    noteEditor(fileEditKey(KEY, b.id), { focus, caret: () => null, select: vi.fn() });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("without it the editor takes nothing", async () => {
    stop = startFileRequests();
    await request();
    await layoutSettled();
    const focus = vi.fn();
    noteEditor(fileEditKey(KEY, b.id), { focus, caret: () => null, select: vi.fn() });
    expect(focus).not.toHaveBeenCalled();
  });

  describe("with the user typing in an editor of thread b in a pane the layout does not have focused", () => {
    let editorPane = "";
    beforeEach(async () => {
      openTab(KEY, a, { focus: false });
      await layoutSettled();
      const tab = tabOf(A);
      await applyLayoutOp({ op: "move_tab", tab: tab?.id ?? "", pane: tab?.paneId ?? "", edge: "bottom" });
      await layoutSettled();
      editorPane = tabOf(A)?.paneId ?? "";
      // The layout's focus goes back to the thread's pane; the keyboard stays in A's editor.
      await applyLayoutOp({ op: "focus_tab", tab: "t-a" });
      await layoutSettled();
      expect(useLayoutStore.getState().spaces[useLayoutStore.getState().currentSpaceId]?.focus).not.toBe(editorPane);
      await typingInA();
      stop = startFileRequests();
      appliedOps.length = 0;
    });

    it("a request landing in front of it goes back behind it, without taking the focus elsewhere", async () => {
      await request({}, editorPane);
      await layoutSettled();
      expect(tabOf(ENV)?.paneId).toBe(editorPane);
      expect(activeIn(editorPane)).toBe(tabOf(A)?.id);
      expect(appliedOps.filter((o) => o.op === "focus_tab").map((o) => (o as { tab: string }).tab)).toEqual([tabOf(A)?.id]);
    });

    it("a second request for the same file (a new id) goes behind it too", async () => {
      await request({}, editorPane);
      await layoutSettled();
      await applyLayoutOp({ op: "focus_tab", tab: tabOf(ENV)?.id ?? "" });
      await applyLayoutOp({ op: "focus_tab", tab: "t-a" });
      await layoutSettled();
      await request({ askId: "ask-2", note: "Second" }, editorPane);
      await layoutSettled();
      expect(tabOf(ENV)?.params.note).toBe("Second");
      expect(activeIn(editorPane)).toBe(tabOf(A)?.id);
    });

    it("--focus goes to it: the user asked to be taken there", async () => {
      await applyLayoutOp({ op: "open_surface", tab: { kind: "file", thread: "b", params: { path: ENV, project: "web", base: WT, edit: "1", asker: "b", askId: "ask-3", focus: "1" } }, pane: editorPane, focus: true });
      await layoutSettled();
      expect(activeIn(editorPane)).toBe(tabOf(ENV)?.id);
    });

    it("a plain open (no request) behaves as it always has", async () => {
      await applyLayoutOp({ op: "open_surface", tab: { kind: "file", thread: "b", params: { path: ENV, project: "web", base: WT } }, pane: editorPane, focus: false });
      await layoutSettled();
      expect(activeIn(editorPane)).toBe(tabOf(ENV)?.id);
    });

    it("landing in another pane than the editor's, it shows there: that pane's screen is not the one typed in", async () => {
      const other = tabOf(A) ? useLayoutStore.getState().spaces[useLayoutStore.getState().currentSpaceId]?.focus ?? "" : "";
      await request({}, other);
      await layoutSettled();
      expect(tabOf(ENV)?.paneId).toBe(other);
      expect(activeIn(editorPane)).toBe(tabOf(A)?.id);
      expect(appliedOps.some((o) => o.op === "focus_tab")).toBe(false);
    });
  });

  it("a request already in the layout when the window reads it is not new: a reload moves nothing", async () => {
    await request({ focus: "1", line: "2" });
    await layoutSettled();
    stop = startFileRequests();
    const focus = vi.fn();
    noteEditor(fileEditKey(KEY, b.id), { focus, caret: () => null, select: vi.fn() });
    expect(focus).not.toHaveBeenCalled();
  });
});
