import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { versionStamp, type FileReadView, type FileWriteView } from "@/api/files";
import type { ThreadView } from "@/api/threads";
import { fileOfTab, fileTab } from "@/surfaces/fileTarget";
import { applyLayoutOp } from "@/api/layout";
import { answerAlternate, answerConfirm, useConfirmStore } from "./confirm";
import { discardDraft, editorDetached, fileEditKey, noteDraft, noteEditor, observeRead, reloadDraft, saveFile, startEdit, useFileEditStore } from "./fileEdit";
import { openFileInPanel } from "./filePanel";
import { canTell, confirmCloseFile, dismissAsk, fileFacts, presentFileSave, saveAndTell, savedMessage } from "./fileRequest";
import { findTab, shownTab, tabPlace, targetOf, type Tab } from "@/shell/host";
import { fakeLayoutState, layoutSettled, resetFakeLayout, threadSeed } from "@/test/fakeLayout";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

// The library's memory: a draft per key.
const lib = vi.hoisted(() => ({ drafts: new Map<string, string>() }));
vi.mock("@/lib/codeEditor", () => ({
  loadCodeEditor: () => Promise.resolve(),
  draftText: (k: string) => lib.drafts.get(k) ?? null,
  forgetDraft: (k: string) => {
    lib.drafts.delete(k);
  },
}));

// What happened, in order: the two calls this store is about.
const calls = vi.hoisted(() => [] as string[]);
const api = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(), send: vi.fn() }));
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  writeFile: (...args: unknown[]) => {
    calls.push("write");
    return api.write(...args) as Promise<FileWriteView>;
  },
  readFile: api.read,
}));
vi.mock("./commands", async (orig) => ({
  ...(await orig<typeof import("./commands")>()),
  invokeConfirmed: (name: string, args: Record<string, string>) => {
    calls.push(`send ${name}`);
    return api.send(args) as Promise<unknown>;
  },
  refreshCommands: () => Promise.resolve(),
}));

const SECRET = "API_KEY=sk-live-4242\n";
const ENV = "/w/.env";
const PANEL = "thread:s-1";
const ASK = { id: "ask-1", thread: "s-1", note: "Put the key on line 2" };
const view = (over: Partial<FileReadView> = {}): FileReadView => ({ path: ENV, realPath: "", mode: 0, size: 4, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 100, notFound: false, isDir: false, outsideHome: false, text: "a=1\n", lossless: true, image: null, pdf: null, ...over });
const missing = () => view({ notFound: true, text: null, lossless: false, size: 0, modifiedAtMs: null });
const written = (over: Partial<FileWriteView> = {}): FileWriteView => ({ path: ENV, size: SECRET.length, modifiedAtMs: 200, conflict: false, notFound: false, ...over });

const target = { project: "repo", base: "/w", path: ENV, edit: true, ask: ASK };
const tabId = fileTab(target).id;
const KEY = fileEditKey(PANEL, tabId);
const edit = () => useFileEditStore.getState().sessions[KEY];
/** The request's File tab once the layout has every update sent so far. */
const tab = async (): Promise<Tab> => {
  await layoutSettled();
  const t = findTab(PANEL, tabId);
  if (!t) throw new Error("no tab");
  return t;
};

/** A thread's request open on `read`, the editor on screen, the document `text` if given. */
async function asked(text: string | null = null, read = view(), over: Partial<typeof target> = {}): Promise<void> {
  openFileInPanel(PANEL, { ...target, ...over });
  await layoutSettled();
  await startEdit(KEY, { panelKey: PANEL, tabId, base: "/w" }, read, { create: true });
  const s = edit();
  if (!s) throw new Error("no session");
  lib.drafts.set(s.stateKey, text ?? s.seed);
  noteEditor(KEY, { focus: vi.fn(), caret: () => null, select: vi.fn() });
  if (text !== null) noteDraft(KEY, text);
}

const sentArgs = (): unknown[] => api.send.mock.calls.map((c) => c[0] as unknown);

beforeEach(async () => {
  await resetFakeLayout(threadSeed("s-1"));
  calls.length = 0;
  lib.drafts.clear();
  api.write.mockReset();
  api.read.mockReset();
  api.send.mockReset();
  api.send.mockResolvedValue({ ok: true });
  useFileEditStore.setState({ sessions: {} });
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Set up billing", projectId: "repo", worktreePath: "/w", workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [] } as unknown as ThreadView }, order: ["s-1"] });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

// A tab's params update still on its way would land on the next test's layout.
afterEach(async () => {
  await layoutSettled();
});

describe("a request as the daemon writes it (view.open.file --edit, shell-22-retire-verbs.md)", () => {
  // The daemon's open_surface: the tab linked to the thread, the request whole in its params
  // (internal/command fileAskParams), the asker another thread than the tab's.
  it("the tab reads the asker and id from its params, and Save and tell answers that asker", async () => {
    useThreadsStore.setState((st) => ({ byId: { ...st.byId, "s-2": { ...st.byId["s-1"], id: "s-2", name: "Lead" } as ThreadView }, order: ["s-1", "s-2"] }));
    await applyLayoutOp({
      op: "open_surface",
      tab: { kind: "file", thread: "s-1", params: { path: ENV, project: "repo", base: "/w", edit: "1", asker: "s-2", askId: "d4e5f6a1b2c3", note: "Put the key on line 2", focus: "1" } },
      focus: true,
    });
    await layoutSettled();
    const t = await tab();
    expect(fileOfTab(t)).toMatchObject({ edit: true, ask: { id: "d4e5f6a1b2c3", thread: "s-2", note: "Put the key on line 2" } });
    await startEdit(KEY, { panelKey: PANEL, tabId, base: "/w" }, view(), { create: true });
    lib.drafts.set(edit()?.stateKey ?? "", SECRET);
    noteDraft(KEY, SECRET);
    api.write.mockResolvedValue(written());
    await expect(saveAndTell(KEY)).resolves.toBe("saved");
    expect(sentArgs()).toEqual([{ id: "s-2", text: "I saved .env. Continue without reading its values." }]);
    // The request is over: every param the daemon wrote for it goes, focus with them.
    const after = (await tab()).params;
    for (const k of ["edit", "asker", "askId", "note", "focus"]) expect(after[k]).toBeUndefined();
    expect(after.path).toBe(ENV);
  });
});

describe("Save and tell", () => {
  it("writes, then sends one ordinary message, and the request is over", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    await expect(saveAndTell(KEY)).resolves.toBe("saved");
    expect(calls).toEqual(["write", "send thread.send"]);
    expect(sentArgs()).toEqual([{ id: "s-1", text: "I saved .env. Continue without reading its values." }]);
    expect((await tab()).params.asker).toBeUndefined();
    expect((await tab()).params.note).toBeUndefined();
    expect((await tab()).params.edit).toBeUndefined();
    expect(edit()?.dirty).toBe(false);
  });

  it("the message holds nothing from the file: no contents, no size, no line text", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    await saveAndTell(KEY);
    const sent = JSON.stringify(sentArgs());
    for (const leak of ["API_KEY", "sk-live", "4242", String(SECRET.length)]) expect(sent).not.toContain(leak);
  });

  it.each([
    ["a project's file by its path in the checkout", "/w/config/.env", "repo", "/w", "I saved config/.env. Continue without reading its values."],
    ["a file outside the checkout under home", "/Users/me/.aws/credentials", "repo", "/w", "I saved ~/.aws/credentials. Continue without reading its values."],
    ["a thread without a project", "/Users/me/.aws/credentials", "", "/Users/me", "I saved ~/.aws/credentials. Continue without reading its values."],
  ])("names %s", (_name, path, project, base, want) => {
    expect(savedMessage(path, project, base)).toBe(want);
  });

  it("a conflict sends nothing, and the request stands", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written({ conflict: true }));
    await expect(saveAndTell(KEY)).resolves.toBe("conflict");
    expect(calls).toEqual(["write"]);
    expect((await tab()).params.asker).toBe("s-1");
    expect(edit()?.conflict).toBe("changed");
  });

  it("a failed write sends nothing, and the request stands", async () => {
    await asked(SECRET);
    api.write.mockRejectedValue(new Error("read-only"));
    await expect(saveAndTell(KEY)).resolves.toBe("failed");
    expect(calls).toEqual(["write"]);
    expect((await tab()).params.asker).toBe("s-1");
    expect(edit()?.failure).toContain("Could not save");
  });

  it("a send that fails leaves the save standing and says so", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    api.send.mockRejectedValue(new Error("thread s-1 not found"));
    await expect(saveAndTell(KEY)).resolves.toBe("untold");
    expect(edit()).toMatchObject({ dirty: false, failure: expect.stringContaining('Saved, but Thread "Set up billing" was not told') as string });
    expect(edit()?.failure).toContain("not found");
    expect((await tab()).params.asker).toBeUndefined();
  });

  it("a removed thread's name reaches the band cleaned and cut", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    api.send.mockResolvedValue({ message: `thread Sess\u202eion${"x".repeat(400)} (s-1) was removed\nno report`, resultJson: "", exitCode: 1 });
    await saveAndTell(KEY);
    const failure = edit()?.failure ?? "";
    expect(failure).toContain("thread Session");
    expect(failure).not.toContain("\u202e");
    expect(failure.length).toBeLessThan(280);
  });

  it("a thread that is gone is said too, by what is left of it", async () => {
    await asked(SECRET);
    useThreadsStore.setState({ byId: {}, order: [] });
    api.write.mockResolvedValue(written());
    api.send.mockRejectedValue(new Error("no such thread"));
    await expect(saveAndTell(KEY)).resolves.toBe("untold");
    expect(edit()?.failure).toContain("Saved, but the thread was not told");
  });

  it("a removed thread answers with a failing result, not an error: that is a failure too", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    api.send.mockResolvedValue({ message: "thread Set up billing (s-1) was removed at 2026-11-04 22:44:22\nno report\ncost: $0.07", resultJson: "", exitCode: 1 });
    await expect(saveAndTell(KEY)).resolves.toBe("untold");
    expect(edit()?.failure).toBe('Saved, but Thread "Set up billing" was not told: thread Set up billing (s-1) was removed at 2026-11-04 22:44:22');
  });

  it("twice in a row writes and sends once", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    await Promise.all([saveAndTell(KEY), saveAndTell(KEY)]);
    await saveAndTell(KEY);
    expect(calls).toEqual(["write", "send thread.send"]);
  });

  it("after row two's Save only tells: a write landed for this request", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    await saveFile(KEY);
    expect(calls).toEqual(["write"]);
    expect((await tab()).params.asker).toBe("s-1");
    await saveAndTell(KEY);
    expect(calls).toEqual(["write", "send thread.send"]);
  });

  it("after Overwrite too", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written({ conflict: true }));
    await saveFile(KEY);
    expect((await tab()).params.askSaved).toBeUndefined();
    api.write.mockResolvedValue(written());
    await saveFile(KEY, { force: true });
    expect((await tab()).params.askSaved).toBe(`${String(SECRET.length)}:200`);
    await expect(saveAndTell(KEY)).resolves.toBe("saved");
  });

  describe("'saved' means what is on disk is our write, since this request", () => {
    const told = () => calls.filter((c) => c.startsWith("send"));

    /** Row two's Save landed, and the request stands. */
    async function savedByRowTwo(): Promise<void> {
      await asked(SECRET);
      api.write.mockResolvedValue(written());
      await saveFile(KEY);
      expect((await tab()).params.askSaved).toBeTruthy();
      calls.length = 0;
    }

    it("saved, the file deleted, a reload: New file has nothing to tell", async () => {
      await savedByRowTwo();
      useFileEditStore.setState({ sessions: {} });
      await startEdit(KEY, { panelKey: PANEL, tabId, base: "/w" }, missing(), { create: true });
      const s = edit();
      expect(s?.creating).toBe(true);
      if (s) lib.drafts.set(s.stateKey, "");
      noteEditor(KEY, { focus: vi.fn(), caret: () => null, select: vi.fn() });
      presentFileSave();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([]);
    });

    it("even a stamp that matched a blank document tells nothing", async () => {
      await asked(null, missing());
      const s = edit();
      if (!s?.view) throw new Error("no view");
      expect(canTell(s, { ...ASK, saved: versionStamp(s.view) })).toBe(false);
    });

    it("saved, more typed, an outside write, Reload: the disk holds theirs", async () => {
      await savedByRowTwo();
      const s = edit();
      if (s) lib.drafts.set(s.stateKey, "more\n");
      noteDraft(KEY, "more\n");
      observeRead(KEY, view({ text: "THEIRS=1\n", size: 9, modifiedAtMs: 300 }));
      expect(edit()?.conflict).toBe("changed");
      api.read.mockResolvedValue(view({ text: "THEIRS=1\n", size: 9, modifiedAtMs: 300 }));
      await reloadDraft(KEY);
      expect(edit()).toMatchObject({ dirty: false, conflict: null });
      await expect(saveAndTell(KEY)).resolves.toBe("skipped");
      expect(told()).toEqual([]);
    });

    it("saved, an outside write a clean document follows, cmd+S: nothing to tell", async () => {
      await savedByRowTwo();
      observeRead(KEY, view({ text: "THEIRS=1\n", size: 9, modifiedAtMs: 300 }));
      expect(edit()?.seed).toBe("THEIRS=1\n");
      presentFileSave();
      await new Promise((r) => setTimeout(r, 20));
      expect(told()).toEqual([]);
    });

    it("saved, the tab left and came back to the same version: it can still tell", async () => {
      await savedByRowTwo();
      const before = edit();
      if (before) editorDetached(KEY, before.stateKey);
      expect(edit()?.view).toBeNull();
      observeRead(KEY, view({ text: SECRET, size: SECRET.length, modifiedAtMs: 200 }));
      await expect(saveAndTell(KEY)).resolves.toBe("saved");
      expect(told()).toHaveLength(1);
    });

    it("saved, more typed, Discard: the disk is still our write", async () => {
      await savedByRowTwo();
      const s = edit();
      if (s) lib.drafts.set(s.stateKey, "more\n");
      noteDraft(KEY, "more\n");
      await discardDraft(KEY);
      await expect(saveAndTell(KEY)).resolves.toBe("saved");
    });
  });

  it("a write that failed did not land: nothing to tell", async () => {
    await asked(SECRET);
    api.write.mockRejectedValue(new Error("read-only"));
    await saveFile(KEY);
    expect((await tab()).params.askSaved).toBeUndefined();
  });

  it("on an untouched document there is nothing to say: no write, no message, and the request stands", async () => {
    await asked();
    await expect(saveAndTell(KEY)).resolves.toBe("skipped");
    expect(calls).toEqual([]);
    expect((await tab()).params.asker).toBe("s-1");
  });

  it.each([
    ["while a write is out", { busy: true }],
    ["with a conflict up", { conflict: "changed" as const }],
    ["with nothing written", { dirty: false }],
  ])("cannot run %s", async (_name, over) => {
    await asked("typed\n");
    const s = edit();
    if (!s) throw new Error("no session");
    expect(canTell(s, ASK)).toBe(true);
    expect(canTell({ ...s, ...over }, ASK)).toBe(false);
    useFileEditStore.setState({ sessions: { [KEY]: { ...s, ...over } } });
    await expect(saveAndTell(KEY)).resolves.toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("a newer request that came during the write stands", async () => {
    await asked(SECRET);
    let done: (v: FileWriteView) => void = () => undefined;
    api.write.mockReturnValue(new Promise<FileWriteView>((r) => {
      done = r;
    }));
    const told = saveAndTell(KEY);
    openFileInPanel(PANEL, { ...target, ask: { ...ASK, id: "ask-2", note: "And line 3" } });
    await layoutSettled();
    done(written());
    await told;
    expect((await tab()).params.note).toBe("And line 3");
    expect((await tab()).params.askSaved).toBeUndefined();
  });

  it("a newer request whose tab update has not landed when the write answers stands", async () => {
    await asked(SECRET);
    let done: (v: FileWriteView) => void = () => undefined;
    api.write.mockReturnValue(new Promise<FileWriteView>((r) => {
      done = r;
    }));
    const told = saveAndTell(KEY);
    openFileInPanel(PANEL, { ...target, ask: { ...ASK, id: "ask-2", note: "And line 3" } });
    done(written());
    await told;
    expect((await tab()).params.note).toBe("And line 3");
  });
});

describe("fileFacts", () => {
  it("a new file through a linked folder is one too; a mode of 0 says nothing", () => {
    expect(fileFacts(view({ realPath: "/Users/me/Public/.env", mode: 0 }))).toEqual(["This path is a link: the file is really ~/Public/.env."]);
    expect(fileFacts(view({ realPath: "", mode: 0 }))).toEqual([]);
    expect(fileFacts(view({ realPath: ENV, mode: 0o600 }))).toEqual([]);
  });
});

describe("Dismiss", () => {
  it("ends the request, sends nothing, and editing goes on", async () => {
    await asked("typed\n");
    dismissAsk(KEY);
    expect((await tab()).params.asker).toBeUndefined();
    expect(edit()?.dirty).toBe(true);
    expect(calls).toEqual([]);
    api.write.mockResolvedValue(written());
    await saveAndTell(KEY);
    expect(calls).toEqual([]);
  });
});

describe("a request's life", () => {
  it("nothing of a finished request is left for a reload to find", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    await saveAndTell(KEY);
    await layoutSettled();
    const stored = JSON.stringify(fakeLayoutState());
    expect(stored).not.toContain(ASK.note);
    expect(stored).not.toContain('"asker"');
  });

  it("a repeat request shows the new note and leaves the draft alone", async () => {
    await asked("half typed\n");
    const before = edit();
    openFileInPanel(PANEL, { ...target, ask: { ...ASK, id: "ask-2", note: "Line 3 too" }, line: 3 });
    await layoutSettled();
    expect((await tab()).params.note).toBe("Line 3 too");
    expect((await tab()).params.line).toBe("3");
    expect(edit()).toBe(before);
    expect(shownTab(tabPlace(PANEL))?.id).toBe(tabId);
  });

  it("opening the file another way keeps the request", async () => {
    await asked();
    openFileInPanel(PANEL, { project: "repo", base: "/w", path: ENV, line: 7 });
    expect((await tab()).params).toMatchObject({ asker: "s-1", note: ASK.note, edit: "1", line: "7" });
  });

  it("the tab's close asks to save and tell, and that closes it having told", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    const closing = confirmCloseFile(PANEL, await tab());
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.confirmLabel).toBe("Save and tell thread");
    });
    answerConfirm(true);
    await expect(closing).resolves.toBe(true);
    expect(calls).toEqual(["write", "send thread.send"]);
  });

  it("the close dialog's Discard sends nothing", async () => {
    await asked(SECRET);
    const closing = confirmCloseFile(PANEL, await tab());
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerAlternate();
    await expect(closing).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it("a told-nobody close keeps the tab, to say so", async () => {
    await asked(SECRET);
    api.write.mockResolvedValue(written());
    api.send.mockRejectedValue(new Error("gone"));
    const closing = confirmCloseFile(PANEL, await tab());
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerConfirm(true);
    await expect(closing).resolves.toBe(false);
  });
});

describe("cmd+S", () => {
  it("on an untouched file does nothing, as anywhere, and the request stands", async () => {
    await asked();
    presentFileSave();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    expect((await tab()).params.asker).toBe("s-1");
  });

  it("is Save and tell while the request stands, a plain save after", async () => {
    await asked("one\n");
    expect(targetOf(useUiStore.getState().selection)).toBe(PANEL);
    api.write.mockResolvedValue(written());
    presentFileSave();
    await vi.waitFor(() => {
      expect(calls).toEqual(["write", "send thread.send"]);
    });
    calls.length = 0;
    const s = edit();
    if (s) lib.drafts.set(s.stateKey, "two\n");
    noteDraft(KEY, "two\n");
    presentFileSave();
    await vi.waitFor(() => {
      expect(calls).toEqual(["write"]);
    });
  });
});

describe("a new file", () => {
  const fresh = (text: string | null = null) => asked(text, missing());

  it("is an empty document marked as such", async () => {
    await fresh();
    expect(edit()).toMatchObject({ creating: true, seed: "", dirty: false, view: { text: "", notFound: false } });
  });

  it("nothing typed can be neither saved nor told, and writes nothing", async () => {
    await fresh();
    await expect(saveAndTell(KEY)).resolves.toBe("skipped");
    await expect(saveFile(KEY)).resolves.toBe("skipped");
    expect(confirmCloseFile(PANEL, await tab())).toBe(true);
    expect(calls).toEqual([]);
  });

  it("saves with create, then tells, and is an ordinary file after", async () => {
    await fresh(SECRET);
    api.write.mockResolvedValue(written());
    await saveAndTell(KEY);
    expect(calls).toEqual(["write", "send thread.send"]);
    expect(api.write).toHaveBeenCalledWith("/w", ENV, SECRET, expect.anything(), { create: true });
    expect(edit()).toMatchObject({ creating: false, dirty: false });
  });

  it("a file that appeared is a conflict: nothing replaced, nothing sent", async () => {
    await fresh(SECRET);
    api.write.mockResolvedValue(written({ conflict: true }));
    await expect(saveAndTell(KEY)).resolves.toBe("conflict");
    expect(calls).toEqual(["write"]);
    expect(edit()).toMatchObject({ conflict: "changed", creating: true, dirty: true });
  });

  it("Overwrite after that goes with force, not create", async () => {
    await fresh(SECRET);
    api.write.mockResolvedValue(written({ conflict: true }));
    await saveFile(KEY);
    api.write.mockResolvedValue(written());
    await saveFile(KEY, { force: true });
    expect(api.write).toHaveBeenLastCalledWith("/w", ENV, SECRET, expect.anything(), { force: true });
    expect(edit()).toMatchObject({ creating: false, conflict: null });
  });

  it("a read finding nothing is what it expects", async () => {
    await fresh("typed\n");
    observeRead(KEY, missing());
    expect(edit()).toMatchObject({ conflict: null, dirty: true, creating: true });
  });

  it("a read finding a file raises the conflict over a draft", async () => {
    await fresh("typed\n");
    observeRead(KEY, view());
    expect(edit()).toMatchObject({ conflict: "changed", dirty: true, creating: true });
  });

  it("a clean document follows a file that appeared, as an ordinary session", async () => {
    await fresh();
    observeRead(KEY, view());
    expect(edit()).toMatchObject({ creating: false, seed: "a=1\n", conflict: null });
  });

  it("the conflict goes if the file does", async () => {
    await fresh("typed\n");
    observeRead(KEY, view());
    observeRead(KEY, missing());
    expect(edit()).toMatchObject({ conflict: null, creating: true });
  });
});
