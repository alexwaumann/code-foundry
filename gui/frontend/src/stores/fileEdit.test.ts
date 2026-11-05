import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView, FileWriteView } from "@/api/files";
import { answerAlternate, answerConfirm, useConfirmStore } from "./confirm";
import {
  canSaveFile,
  discardDraft,
  dropPanelDrafts,
  editClock,
  editorDetached,
  editorOpening,
  fileEditKey,
  noteDraft,
  noteEditor,
  noteRead,
  observeRead,
  reloadDraft,
  saveFile,
  startEdit,
  stopEdit,
  unsavedTabs,
  useFileEditStore,
} from "./fileEdit";
import { confirmCloseFile, presentFileSave } from "./fileRequest";
import { closePanelTab, openSurface, usePanelStore, type Tab } from "./panel";
import { useUiStore } from "./ui";

// The library's memory: a draft per key, and which keys an editor holds.
const lib = vi.hoisted(() => ({ drafts: new Map<string, string>(), attached: new Set<string>() }));
vi.mock("@/lib/codeEditor", () => ({
  loadCodeEditor: () => Promise.resolve(),
  draftText: (k: string) => lib.drafts.get(k) ?? null,
  forgetDraft: (k: string) => {
    if (!lib.attached.has(k)) lib.drafts.delete(k);
  },
}));

const api = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  writeFile: api.write,
  readFile: api.read,
}));

const view = (over: Partial<FileReadView> = {}): FileReadView => ({ path: "/w/.env", size: 4, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 100, notFound: false, isDir: false, text: "a=1\n", lossless: true, image: null, pdf: null, ...over });
const gone = () => view({ notFound: true, text: null, lossless: false, size: 0, modifiedAtMs: null });
const written = (over: Partial<FileWriteView> = {}): FileWriteView => ({ path: "/w/.env", size: 5, modifiedAtMs: 200, conflict: false, notFound: false, ...over });

const TAB = "files:x";
const PANEL = "thread:s1";
const KEY = fileEditKey(PANEL, TAB);
const tab: Tab = { id: TAB, kind: "files", title: ".env", params: {} };
const edit = () => useFileEditStore.getState().sessions[KEY];

/** A session whose editor is on screen with `text` as its document. */
async function editing(text: string | null = null, v = view()): Promise<void> {
  usePanelStore.setState({ byKey: { [PANEL]: { open: true, groups: [{ tabs: [tab], activeTabId: TAB }] } } });
  await startEdit(KEY, { panelKey: PANEL, tabId: TAB, base: "/w" }, v);
  const s = edit();
  if (!s) throw new Error("no session");
  lib.attached.add(s.stateKey);
  lib.drafts.set(s.stateKey, text ?? s.seed);
  noteEditor(KEY, { focus: vi.fn(), caret: () => null });
  if (text !== null) noteDraft(KEY, text);
}

/** What the screen does when the editor's stateKey changes or goes: the old editor detaches. */
function detach(stateKey: string): void {
  lib.attached.delete(stateKey);
  editorDetached(KEY, stateKey);
}

beforeEach(() => {
  api.write.mockReset();
  api.read.mockReset();
});

afterEach(() => {
  lib.drafts.clear();
  lib.attached.clear();
  useFileEditStore.setState({ sessions: {} });
  usePanelStore.setState({ byKey: {} });
  useConfirmStore.setState({ pending: null });
});

describe("starting and stopping", () => {
  it("a file it cannot edit starts nothing", async () => {
    await startEdit(KEY, { panelKey: PANEL, tabId: TAB, base: "/w" }, view({ lossless: false }));
    expect(edit()).toBeUndefined();
  });

  it("a second start leaves the draft alone", async () => {
    await editing("a=2\n");
    const key = edit()?.stateKey;
    await startEdit(KEY, { panelKey: PANEL, tabId: TAB, base: "/w" }, view());
    expect([edit()?.stateKey, edit()?.dirty]).toEqual([key, true]);
  });

  it("stop ends a clean session, never a dirty one", async () => {
    await editing("a=2\n");
    stopEdit(KEY);
    expect(edit()?.dirty).toBe(true);
    noteDraft(KEY, "a=1\n");
    stopEdit(KEY);
    expect(edit()).toBeUndefined();
  });
});

describe("dirty", () => {
  it("follows the text against the baseline: undoing back is clean", async () => {
    await editing();
    noteDraft(KEY, "a=2\n");
    expect(edit()?.dirty).toBe(true);
    noteDraft(KEY, "a=1\n");
    expect(edit()?.dirty).toBe(false);
  });
});

describe("a read while editing", () => {
  it.each<[string, () => FileReadView, boolean, Partial<{ conflict: string | null; revision: number }>]>([
    ["the same version, dirty", () => view(), true, { conflict: null, revision: 0 }],
    ["a newer time, dirty", () => view({ modifiedAtMs: 101, text: "theirs" }), true, { conflict: "changed", revision: 0 }],
    ["another size, dirty", () => view({ size: 9, text: "theirs" }), true, { conflict: "changed", revision: 0 }],
    ["gone, dirty", gone, true, { conflict: "deleted", revision: 0 }],
    ["gone, clean", gone, false, { conflict: "deleted", revision: 0 }],
    ["the same version, clean", () => view(), false, { conflict: null, revision: 0 }],
    ["a new version, clean", () => view({ modifiedAtMs: 101, text: "theirs" }), false, { conflict: null, revision: 1 }],
  ])("%s", async (_name, read, dirty, want) => {
    await editing(dirty ? "a=2\n" : null);
    observeRead(KEY, read());
    expect(edit()).toMatchObject(want);
  });

  it("never touches a dirty draft's document", async () => {
    await editing("a=2\n");
    const { seed, stateKey } = edit() ?? {};
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    expect([edit()?.seed, edit()?.stateKey, edit()?.view?.text]).toEqual([seed, stateKey, "a=1\n"]);
  });

  it("a clean document follows the file: the new text seeds a new document", async () => {
    await editing();
    const old = edit()?.stateKey;
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    expect(edit()?.seed).toBe("theirs");
    expect(edit()?.stateKey).not.toBe(old);
  });

  it.each([
    ["no longer text it can keep", () => view({ modifiedAtMs: 101, lossless: false })],
    ["now too large", () => view({ modifiedAtMs: 101, truncated: true })],
  ])("a clean document leaves edit mode when the file is %s", async (_name, read) => {
    await editing();
    observeRead(KEY, read());
    expect(edit()).toBeUndefined();
  });

  it("the band goes if the file comes back to the draft's version", async () => {
    await editing("a=2\n");
    observeRead(KEY, view({ modifiedAtMs: 101 }));
    observeRead(KEY, view());
    expect(edit()?.conflict).toBeNull();
  });

  it.each([
    ["dirty", "a=2\n"],
    ["clean", null],
  ])("a read of another file is no news about this one, %s", async (_name, text) => {
    await editing(text);
    observeRead(KEY, view({ path: "/w/other/.env", size: 9, modifiedAtMs: 500, text: "elsewhere" }));
    observeRead(KEY, view({ path: "/w/other/.env", notFound: true, text: null, lossless: false }));
    expect(edit()).toMatchObject({ conflict: null, revision: 0, path: "/w/.env", view: { path: "/w/.env" } });
  });

  it("a read that left before a clean document followed the file cannot take it back", async () => {
    await editing();
    const started = editClock();
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    const stale = view();
    noteRead(stale, started);
    observeRead(KEY, stale);
    expect(edit()).toMatchObject({ seed: "theirs", revision: 1 });
  });
});

describe("saveFile", () => {
  it("writes the draft against the baseline; what comes back is the baseline, and it stays editing", async () => {
    await editing("a=22\n");
    api.write.mockResolvedValue(written());
    await expect(saveFile(KEY)).resolves.toBe("saved");
    expect(api.write).toHaveBeenCalledWith("/w", "/w/.env", "a=22\n", expect.objectContaining({ size: 4, modifiedAtMs: 100 }), {});
    expect(edit()).toMatchObject({ dirty: false, conflict: null, busy: false, view: { text: "a=22\n", size: 5, modifiedAtMs: 200 } });
    // The document is not fed back: a new `file` prop would reset the caret and history.
    expect(edit()?.seed).toBe("a=1\n");
  });

  it("the tab's own re-read of what it wrote is no conflict", async () => {
    await editing("a=22\n");
    api.write.mockResolvedValue(written());
    await saveFile(KEY);
    noteDraft(KEY, "a=222\n");
    const after = view({ size: 5, modifiedAtMs: 200, text: "a=22\n" });
    noteRead(after, editClock());
    observeRead(KEY, after);
    expect(edit()?.conflict).toBeNull();
  });

  it("a read that left before the save and answers after it is no conflict", async () => {
    await editing("a=22\n");
    const started = editClock();
    api.write.mockResolvedValue(written());
    await saveFile(KEY);
    noteDraft(KEY, "a=222\n");
    const stale = view();
    noteRead(stale, started);
    observeRead(KEY, stale);
    expect(edit()?.conflict).toBeNull();
  });

  it("a read answering during the save says nothing", async () => {
    await editing("a=22\n");
    let finish: (answer: FileWriteView) => void = () => undefined;
    api.write.mockReturnValue(
      new Promise<FileWriteView>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = saveFile(KEY);
    observeRead(KEY, view({ modifiedAtMs: 150 }));
    expect(edit()?.conflict).toBeNull();
    finish(written());
    await saving;
  });

  it("a read that left during the write and answers after it is no conflict", async () => {
    await editing("a=22\n");
    let finish: (answer: FileWriteView) => void = () => undefined;
    api.write.mockReturnValue(
      new Promise<FileWriteView>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = saveFile(KEY);
    const started = editClock();
    finish(written());
    await saving;
    noteDraft(KEY, "a=222\n");
    const stale = view();
    noteRead(stale, started);
    observeRead(KEY, stale);
    expect(edit()?.conflict).toBeNull();
  });

  it("writes to the file the session started on", async () => {
    await editing("a=22\n");
    observeRead(KEY, view({ path: "/w/other/.env" }));
    api.write.mockResolvedValue(written());
    await saveFile(KEY);
    expect(api.write.mock.lastCall?.[1]).toBe("/w/.env");
  });

  it("what was typed during the write stays unsaved", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    api.write.mockImplementation(() => {
      lib.drafts.set(key, "a=222\n");
      return Promise.resolve(written());
    });
    await saveFile(KEY);
    expect(edit()).toMatchObject({ dirty: true, view: { text: "a=22\n" } });
  });

  it.each([
    ["changed", written({ conflict: true }), "changed"],
    ["gone", written({ conflict: true, notFound: true, size: 0, modifiedAtMs: null }), "deleted"],
  ])("a conflict (%s) keeps the draft and its baseline", async (_name, answer, conflict) => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    api.write.mockResolvedValue(answer);
    await expect(saveFile(KEY)).resolves.toBe("conflict");
    expect(edit()).toMatchObject({ conflict, dirty: true, busy: false, view: { size: 4, modifiedAtMs: 100 } });
    expect(lib.drafts.get(key)).toBe("a=22\n");
  });

  it("Overwrite forces, and a deleted file comes back as the baseline", async () => {
    await editing("a=22\n");
    api.write.mockResolvedValue(written({ conflict: true, notFound: true }));
    await saveFile(KEY);
    api.write.mockResolvedValue(written());
    await expect(saveFile(KEY, { force: true })).resolves.toBe("saved");
    expect(api.write.mock.lastCall?.[4]).toEqual({ force: true });
    expect(edit()).toMatchObject({ conflict: null, dirty: false, view: { notFound: false, modifiedAtMs: 200 } });
  });

  it.each([
    ["FailedPrecondition", new ConnectError("the file is read-only", Code.FailedPrecondition), "the file is read-only"],
    ["ResourceExhausted", new ConnectError("the disk is full", Code.ResourceExhausted), "the disk is full"],
    ["PermissionDenied", new ConnectError("macOS privacy protection blocked this", Code.PermissionDenied), "macOS privacy protection blocked this"],
  ])("a refusal (%s) shows its message and keeps the draft", async (_name, err, message) => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    api.write.mockRejectedValue(err);
    await expect(saveFile(KEY)).resolves.toBe("failed");
    expect(edit()).toMatchObject({ failure: `Could not save: ${message}`, dirty: true, busy: false });
    expect(lib.drafts.get(key)).toBe("a=22\n");
  });

  it("typing again clears the failure", async () => {
    await editing("a=22\n");
    api.write.mockRejectedValue(new Error("no"));
    await saveFile(KEY);
    noteDraft(KEY, "a=223\n");
    expect(edit()?.failure).toBeNull();
  });

  it.each([
    ["nothing to save", async () => editing()],
    ["no session", async () => Promise.resolve()],
  ])("%s writes nothing", async (_name, setup) => {
    await setup();
    await expect(saveFile(KEY)).resolves.toBe("skipped");
    expect(api.write).not.toHaveBeenCalled();
  });

  it("one write at a time", async () => {
    await editing("a=22\n");
    api.write.mockResolvedValue(written());
    const first = saveFile(KEY);
    await expect(saveFile(KEY)).resolves.toBe("skipped");
    await first;
    expect(api.write).toHaveBeenCalledTimes(1);
  });
});

describe("Discard and Reload", () => {
  it("Discard starts a new document from the baseline and the old draft goes with its editor", async () => {
    await editing("a=22\n");
    const old = edit()?.stateKey ?? "";
    await discardDraft(KEY);
    expect(edit()).toMatchObject({ dirty: false, seed: "a=1\n", revision: 1 });
    expect(edit()?.stateKey).not.toBe(old);
    detach(old);
    expect(lib.drafts.has(old)).toBe(false);
  });

  it("Reload reads the disk and takes it", async () => {
    await editing("a=22\n");
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    api.read.mockResolvedValue(view({ modifiedAtMs: 101, text: "theirs" }));
    await reloadDraft(KEY);
    expect(edit()).toMatchObject({ dirty: false, conflict: null, seed: "theirs", view: { modifiedAtMs: 101 } });
  });

  it("Discard against a changed file is that same reload", async () => {
    await editing("a=22\n");
    observeRead(KEY, view({ modifiedAtMs: 101 }));
    api.read.mockResolvedValue(view({ modifiedAtMs: 101, text: "theirs" }));
    await discardDraft(KEY);
    expect(edit()?.seed).toBe("theirs");
  });

  it.each([
    ["dirty", "a=22\n"],
    ["clean", null],
  ])("Discard against a deleted file leaves edit mode, %s", async (_name, text) => {
    await editing(text);
    observeRead(KEY, gone());
    await discardDraft(KEY);
    expect(edit()).toBeUndefined();
    expect(api.read).not.toHaveBeenCalled();
  });

  it("Discard during a conflict, the file gone since, still gives the draft up, as asked", async () => {
    await editing("a=22\n");
    observeRead(KEY, view({ modifiedAtMs: 101 }));
    api.read.mockResolvedValue(gone());
    await discardDraft(KEY);
    expect(edit()).toBeUndefined();
  });

  it("Reload never gives a draft up: a file gone by then says so, and the draft stays", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    observeRead(KEY, view({ modifiedAtMs: 101 }));
    api.read.mockResolvedValue(gone());
    await reloadDraft(KEY);
    expect(edit()).toMatchObject({ conflict: "deleted", dirty: true, busy: false, stateKey: key });
    expect(lib.drafts.get(key)).toBe("a=22\n");
  });

  it("nor does a file that is no longer text it can edit", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    observeRead(KEY, view({ modifiedAtMs: 101 }));
    api.read.mockResolvedValue(view({ modifiedAtMs: 101, lossless: false }));
    await reloadDraft(KEY);
    expect(edit()).toMatchObject({ dirty: true, stateKey: key, failure: "Could not reload: the file on disk is no longer text this tab can edit." });
  });

  it("a failed reload keeps the draft and says what failed", async () => {
    await editing("a=22\n");
    api.read.mockRejectedValue(new Error("the daemon went"));
    await reloadDraft(KEY);
    expect(edit()).toMatchObject({ dirty: true, busy: false, failure: "Could not reload: the daemon went" });
  });
});

describe("a write and a reload never overlap", () => {
  const hold = <T,>(fn: { mockReturnValue: (p: Promise<T>) => unknown }) => {
    let finish: (answer: T) => void = () => undefined;
    fn.mockReturnValue(
      new Promise<T>((resolve) => {
        finish = resolve;
      }),
    );
    return (answer: T) => {
      finish(answer);
    };
  };

  it("Reload waits out an Overwrite: the disk, the document and the baseline stay together", async () => {
    await editing("mine\n");
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs\n" }));
    const finish = hold<FileWriteView>(api.write);
    const saving = saveFile(KEY, { force: true });
    await reloadDraft(KEY);
    await discardDraft(KEY);
    expect(api.read).not.toHaveBeenCalled();
    finish(written());
    await saving;
    expect(edit()).toMatchObject({ dirty: false, conflict: null, revision: 0, view: { text: "mine\n", modifiedAtMs: 200 } });
  });

  it("Discard waits out a Save", async () => {
    await editing("mine\n");
    const finish = hold<FileWriteView>(api.write);
    const saving = saveFile(KEY);
    await discardDraft(KEY);
    expect(edit()?.revision).toBe(0);
    finish(written());
    await saving;
    expect(edit()).toMatchObject({ dirty: false, view: { text: "mine\n" } });
  });

  it("Overwrite waits out a Reload", async () => {
    await editing("mine\n");
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs\n" }));
    const finish = hold<FileReadView>(api.read);
    const reloading = reloadDraft(KEY);
    await expect(saveFile(KEY, { force: true })).resolves.toBe("skipped");
    expect(api.write).not.toHaveBeenCalled();
    finish(view({ modifiedAtMs: 101, text: "theirs\n" }));
    await reloading;
    expect(edit()).toMatchObject({ dirty: false, seed: "theirs\n", busy: false });
  });

  it("a write answering for a document the session let go touches nothing of the new one", async () => {
    await editing();
    const old = edit()?.stateKey ?? "";
    const finish = hold<FileWriteView>(api.write);
    const saving = saveFile(KEY, { force: true });
    detach(old);
    finish(written());
    await saving;
    expect(edit()).toMatchObject({ view: null, busy: false });
  });
});

describe("when the editor goes", () => {
  it("a dirty draft waits for the tab", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    detach(key);
    expect(lib.drafts.get(key)).toBe("a=22\n");
    expect(edit()?.stateKey).toBe(key);
  });

  it("a clean one leaves no contents behind, and the next read starts it again", async () => {
    await editing();
    const key = edit()?.stateKey ?? "";
    detach(key);
    expect(lib.drafts.has(key)).toBe(false);
    expect(edit()).toMatchObject({ view: null, seed: "" });
    observeRead(KEY, view());
    expect(edit()).toMatchObject({ view: { text: "a=1\n" }, seed: "a=1\n" });
  });

  it("after a save, the same: nothing lingers", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    api.write.mockResolvedValue(written());
    await saveFile(KEY);
    detach(key);
    expect(lib.drafts.has(key)).toBe(false);
  });

  it("a stopped session's draft goes", async () => {
    await editing();
    const key = edit()?.stateKey ?? "";
    stopEdit(KEY);
    detach(key);
    expect(lib.drafts.has(key)).toBe(false);
  });
});

describe("the tab going", () => {
  it("closing it ends the session and drops the draft, however it closed", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    lib.attached.delete(key);
    closePanelTab(PANEL, TAB, { keepOpen: true });
    expect(edit()).toBeUndefined();
    expect(lib.drafts.has(key)).toBe(false);
  });

  it("a removed thread's drafts go with it, and only its", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    lib.attached.delete(key);
    dropPanelDrafts("thread:other");
    expect(edit()).toBeDefined();
    dropPanelDrafts(PANEL);
    expect(edit()).toBeUndefined();
    expect(lib.drafts.has(key)).toBe(false);
  });

  it("a panel names its dirty tabs, for a reset to keep", async () => {
    await editing();
    const entry = usePanelStore.getState().byKey[PANEL];
    if (!entry) throw new Error("no panel");
    expect(unsavedTabs(PANEL, entry)).toEqual([]);
    noteDraft(KEY, "a=2\n");
    expect(unsavedTabs(PANEL, entry)).toEqual([tab]);
  });

  it("two panels showing one file have a draft each", async () => {
    await editing("a=22\n");
    const other = fileEditKey("thread:s2", TAB);
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "thread:s2": { open: true, groups: [{ tabs: [tab], activeTabId: TAB }] } } }));
    await startEdit(other, { panelKey: "thread:s2", tabId: TAB, base: "/w" }, view());
    const sessions = useFileEditStore.getState().sessions;
    expect(other).not.toBe(KEY);
    expect(sessions[other]?.stateKey).not.toBe(sessions[KEY]?.stateKey);
    expect(sessions[other]?.dirty).toBe(false);
  });
});

describe("closing a dirty tab", () => {
  it("a clean tab closes at once", async () => {
    await editing();
    expect(confirmCloseFile(PANEL, tab)).toBe(true);
  });

  it("no session closes at once", () => {
    expect(confirmCloseFile(PANEL, tab)).toBe(true);
  });

  const ask = async () => {
    await editing("a=22\n");
    const asked = confirmCloseFile(PANEL, tab);
    if (asked === true) throw new Error("did not ask");
    return { asked };
  };

  it("asks by name: Save, Discard, Keep editing", async () => {
    const { asked } = await ask();
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Save changes to .env?", confirmLabel: "Save", alternateLabel: "Discard", cancelLabel: "Keep editing" });
    answerConfirm(false);
    await asked;
  });

  it("Keep editing keeps the tab and the draft", async () => {
    const { asked } = await ask();
    answerConfirm(false);
    await expect(asked).resolves.toBe(false);
    expect(edit()?.dirty).toBe(true);
    expect(api.write).not.toHaveBeenCalled();
  });

  it("Discard closes without writing", async () => {
    const { asked } = await ask();
    answerAlternate();
    await expect(asked).resolves.toBe(true);
    expect(api.write).not.toHaveBeenCalled();
  });

  it("Save writes, then closes", async () => {
    api.write.mockResolvedValue(written());
    const { asked } = await ask();
    answerConfirm(true);
    await expect(asked).resolves.toBe(true);
    expect(api.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a conflict", () => api.write.mockResolvedValue(written({ conflict: true }))],
    ["a refusal", () => api.write.mockRejectedValue(new Error("no"))],
  ])("Save that ends in %s keeps the tab, shown", async (_name, answer) => {
    answer();
    const { asked } = await ask();
    answerConfirm(true);
    await expect(asked).resolves.toBe(false);
    expect(edit()?.dirty).toBe(true);
  });
});

describe("file.save", () => {
  const select = () => {
    useUiStore.setState({ selection: { kind: "thread", id: "s1" } });
  };

  /** The editor's DOM as CodeFile draws it, with the keyboard in it. */
  const focusOn = (stateKey: string) => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-code-editor", stateKey);
    const host = document.createElement("div");
    host.tabIndex = -1;
    wrap.append(host);
    document.body.append(wrap);
    host.focus();
    return wrap;
  };

  it("with nothing editing is handled and does nothing", () => {
    select();
    expect(presentFileSave()).toBe(true);
    expect(canSaveFile()).toBe(false);
    expect(api.write).not.toHaveBeenCalled();
  });

  it("saves the tab in front", async () => {
    select();
    await editing("a=22\n");
    expect(canSaveFile()).toBe(true);
    api.write.mockResolvedValue(written());
    presentFileSave();
    expect(api.write).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(edit()?.dirty).toBe(false);
    });
  });

  it("with the keyboard in an editor, saves that one, whatever group has focus", async () => {
    select();
    await editing("a=22\n");
    const other = fileEditKey(PANEL, "files:y");
    usePanelStore.setState({
      byKey: {
        [PANEL]: { open: true, focused: 1, groups: [{ tabs: [tab], activeTabId: TAB }, { tabs: [{ ...tab, id: "files:y" }], activeTabId: "files:y" }] },
      },
    });
    await startEdit(other, { panelKey: PANEL, tabId: "files:y", base: "/w" }, view({ path: "/w/b.txt" }));
    const b = useFileEditStore.getState().sessions[other];
    lib.drafts.set(b?.stateKey ?? "", "b\n");
    noteDraft(other, "b\n");
    noteEditor(other, { focus: vi.fn(), caret: () => null });
    const wrap = focusOn(edit()?.stateKey ?? "");
    api.write.mockResolvedValue(written());
    presentFileSave();
    wrap.remove();
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(api.write.mock.lastCall?.[1]).toBe("/w/.env");
    await vi.waitFor(() => {
      expect(edit()?.dirty).toBe(false);
    });
  });

  it("with the keyboard in a clean editor, saves nothing rather than the tab beside it", async () => {
    select();
    await editing();
    const wrap = focusOn(edit()?.stateKey ?? "");
    presentFileSave();
    wrap.remove();
    expect(api.write).not.toHaveBeenCalled();
  });

  it("a draft the user cannot see is not saved: the panel closed", async () => {
    select();
    await editing("a=22\n");
    usePanelStore.setState({ byKey: { [PANEL]: { open: false, groups: [{ tabs: [tab], activeTabId: TAB }] } } });
    expect(canSaveFile()).toBe(false);
    presentFileSave();
    expect(api.write).not.toHaveBeenCalled();
  });

  it("nor its editor gone from the screen", async () => {
    select();
    await editing("a=22\n");
    detach(edit()?.stateKey ?? "");
    expect(canSaveFile()).toBe(false);
    presentFileSave();
    expect(api.write).not.toHaveBeenCalled();
  });

  it("not a tab behind another one", async () => {
    select();
    await editing("a=22\n");
    openSurface(PANEL, { id: "other", kind: "changes", title: "Changes", params: {} });
    expect(canSaveFile()).toBe(false);
    presentFileSave();
    expect(api.write).not.toHaveBeenCalled();
  });
});

describe("the keyboard", () => {
  it("a clean re-read keeps it, and the caret, in the new editor", async () => {
    await editing();
    const wrap = document.createElement("div");
    wrap.setAttribute("data-code-editor", edit()?.stateKey ?? "");
    const host = document.createElement("div");
    host.tabIndex = -1;
    wrap.append(host);
    document.body.append(wrap);
    host.focus();
    noteEditor(KEY, { focus: vi.fn(), caret: () => ({ line: 3, character: 7 }) });
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    wrap.remove();
    const next = { focus: vi.fn(), caret: () => null };
    noteEditor(KEY, next);
    expect(next.focus).toHaveBeenCalledWith({ line: 3, character: 7 });
  });

  it("a clean re-read with the keyboard elsewhere leaves it there", async () => {
    await editing();
    observeRead(KEY, view({ modifiedAtMs: 101, text: "theirs" }));
    const next = { focus: vi.fn(), caret: () => null };
    noteEditor(KEY, next);
    expect(next.focus).not.toHaveBeenCalled();
  });
});

describe("a draft the library let go", () => {
  it("Save says so instead of doing nothing", async () => {
    await editing("a=22\n");
    lib.drafts.clear();
    await expect(saveFile(KEY)).resolves.toBe("failed");
    expect(edit()?.failure).toContain("gone");
    expect(api.write).not.toHaveBeenCalled();
  });

  it("the tab coming back says so, on the last version, not marked Unsaved", async () => {
    await editing("a=22\n");
    const key = edit()?.stateKey ?? "";
    lib.drafts.clear();
    editorOpening(KEY, key);
    expect(edit()).toMatchObject({ dirty: false, seed: "a=1\n", revision: 1 });
    expect(edit()?.failure).toContain("gone");
  });

  it("a draft still there is left alone", async () => {
    await editing("a=22\n");
    editorOpening(KEY, edit()?.stateKey ?? "");
    expect(edit()).toMatchObject({ dirty: true, failure: null, revision: 0 });
  });
});

describe("where a draft is not", () => {
  it("is in nothing persisted: not localStorage, not the panel state", async () => {
    localStorage.clear();
    await editing("SECRET=hunter2\n");
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i) ?? ""));
    expect(stored.join("")).not.toContain("hunter2");
    expect(JSON.stringify(usePanelStore.getState().byKey)).not.toContain("hunter2");
  });
});
