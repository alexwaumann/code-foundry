import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

// The draft verbs as the shell runs them (shell/commands.ts runLayoutCommand).
const runs: { name: string; args: Record<string, string> }[] = [];
const runLayoutCommand = vi.hoisted(() => vi.fn());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runLayoutCommand }));

const { CLEAR_MS, LABEL_MS, STORAGE_KEY, composerTextChanged, readStored, readStoredTexts, resetComposerDrafts, startComposerDrafts } = await import("./composerDrafts");
const { clearDraft, getDraft, updateDraft, useComposeStore } = await import("@/stores/compose");
const { useThreadsStore } = await import("@/stores/threads");
const { threadDraftKey } = await import("@/lib/threadDraft");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");

/**
 * A compose tab becoming a draft as the user types (docs/notes/shell-16-sidebar.md): which verb
 * runs when, where the text is, and what is kept across a reload.
 */

const DRAFTS = (list: { id: string; label: string }[]) =>
  layoutOf([space(pane("p-1", [tab("t-c", "compose", "", { key: "compose", params: list[0] ? { draft: list[0].id } : {} })]), "p-1", { drafts: list.map((d) => ({ ...d, params: {} })) })]);

let stop: () => void = () => undefined;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runs.length = 0;
  runLayoutCommand.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ rev: 1, changed: true });
  });
  localStorage.clear();
  resetComposerDrafts();
  useComposeStore.setState({ drafts: {} });
  resetLayout();
  useThreadsStore.setState({ byId: {}, order: [], loaded: false });
  await seedLayout(DRAFTS([]));
});

afterEach(() => {
  stop();
  stop = () => undefined;
  vi.useRealTimers();
  resetLayout();
});

/** The draft id the start chose. */
const started = () => runs.find((r) => r.name === "composer.draft.start")?.args.id ?? "";

describe("a compose tab's draft", () => {
  it("starts on the first text: its own key, the tab and a label; the target's text is not kept", async () => {
    stop = startComposerDrafts();
    updateDraft("web", { text: "Fix the stale badge\nmore later" });
    composerTextChanged("t-c", "", "web");
    await act(() => vi.advanceTimersByTimeAsync(0));
    const id = started();
    expect(id).toMatch(/^d-[a-z2-7]{8}$/);
    expect(runs).toEqual([{ name: "composer.draft.start", args: { tab: "t-c", id, label: "Fix the stale badge" } }]);
    expect(getDraft(`draft:${id}`).text).toBe("Fix the stale badge\nmore later");
    expect(useComposeStore.getState().drafts.web).toBeUndefined();
  });

  it("puts the text back when the daemon refuses the start", async () => {
    runLayoutCommand.mockResolvedValueOnce(null);
    stop = startComposerDrafts();
    updateDraft("web", { text: "hello" });
    composerTextChanged("t-c", "", "web");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getDraft("web").text).toBe("hello");
    expect(Object.keys(useComposeStore.getState().drafts)).toEqual(["web"]);
  });

  it("relabels once the typing pauses, and only when the label changed", async () => {
    await seedLayout(DRAFTS([{ id: "d-1", label: "Fix" }]));
    stop = startComposerDrafts();
    for (const text of ["Fix t", "Fix th", "Fix the badge"]) {
      updateDraft("draft:d-1", { text });
      composerTextChanged("t-c", "d-1", "web");
      await act(() => vi.advanceTimersByTimeAsync(LABEL_MS / 5));
    }
    await act(() => vi.advanceTimersByTimeAsync(LABEL_MS));
    expect(runs).toEqual([{ name: "composer.draft.label", args: { draft: "d-1", label: "Fix the badge" } }]);
    // A change past the first line does not change the label.
    updateDraft("draft:d-1", { text: "Fix the badge\nwith more" });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(LABEL_MS * 2));
    expect(runs).toHaveLength(1);
  });

  it("clears an emptied draft after a pause, unless typed into again", async () => {
    await seedLayout(DRAFTS([{ id: "d-1", label: "Fix" }]));
    stop = startComposerDrafts();
    updateDraft("draft:d-1", { text: "" });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(CLEAR_MS / 2));
    updateDraft("draft:d-1", { text: "F" });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(CLEAR_MS * 2));
    expect(runs.map((r) => r.name)).not.toContain("composer.draft.clear");
    updateDraft("draft:d-1", { text: "  " });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(CLEAR_MS * 2));
    expect(runs.at(-1)).toEqual({ name: "composer.draft.clear", args: { draft: "d-1" } });
    // Its text goes once the layout shows it cleared.
    await act(async () => {
      await seedLayout({ ...DRAFTS([]), rev: 2 });
    });
    expect(useComposeStore.getState().drafts["draft:d-1"]).toBeUndefined();
  });

  it("text typed while the clear is on its way is kept: it starts a new draft on the same tab", async () => {
    await seedLayout(DRAFTS([{ id: "d-1", label: "Fix" }]));
    stop = startComposerDrafts();
    let answer: (v: unknown) => void = () => undefined;
    runLayoutCommand.mockImplementationOnce((name: string, args: Record<string, string>) => {
      runs.push({ name, args });
      return new Promise((r) => (answer = r));
    });
    updateDraft("draft:d-1", { text: "" });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(CLEAR_MS * 2));
    expect(runs.at(-1)).toEqual({ name: "composer.draft.clear", args: { draft: "d-1" } });
    // Typed again before the clear answered; the layout then shows the tab as the empty composer.
    updateDraft("draft:d-1", { text: "Second thoughts" });
    composerTextChanged("t-c", "d-1", "web");
    await act(async () => {
      await seedLayout({ ...DRAFTS([]), rev: 2 });
    });
    answer({ rev: 2, changed: true });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const id = started();
    expect(id).toMatch(/^d-/);
    expect(runs.at(-1)).toEqual({ name: "composer.draft.start", args: { tab: "t-c", id, label: "Second thoughts" } });
    expect(getDraft(`draft:${id}`).text).toBe("Second thoughts");
  });

  it("the same when the clear answers before the layout shows it", async () => {
    await seedLayout(DRAFTS([{ id: "d-1", label: "Fix" }]));
    stop = startComposerDrafts();
    updateDraft("draft:d-1", { text: "" });
    composerTextChanged("t-c", "d-1", "web");
    await act(() => vi.advanceTimersByTimeAsync(CLEAR_MS * 2));
    updateDraft("draft:d-1", { text: "Again" });
    await act(async () => {
      await seedLayout({ ...DRAFTS([]), rev: 2 });
    });
    const id = started();
    expect(getDraft(`draft:${id}`).text).toBe("Again");
  });

  it("keeps the drafts' text in storage and puts it back at start", async () => {
    await seedLayout(DRAFTS([{ id: "d-1", label: "Fix" }]));
    stop = startComposerDrafts();
    updateDraft("draft:d-1", { text: "Fix the badge" });
    updateDraft("web", { text: "not a draft" });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readStoredTexts()).toEqual({ "d-1": "Fix the badge" });
    stop();
    // A reload: the store starts empty, the text comes back for the draft the layout lists.
    useComposeStore.setState({ drafts: {} });
    stop = startComposerDrafts();
    expect(getDraft("draft:d-1").text).toBe("Fix the badge");
  });

  it("keeps a thread's unsent text in storage and puts it back at start; sending clears it", async () => {
    useThreadsStore.setState({ byId: { "s-1": { id: "s-1", archivedAtMs: null } }, order: ["s-1"], loaded: true } as never);
    stop = startComposerDrafts();
    updateDraft(threadDraftKey("s-1"), { text: "And the tests too" });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readStored().threads).toEqual({ "s-1": "And the tests too" });
    stop();
    // A reload: the text comes back in the thread's composer (and the floating one, which shares its key).
    useComposeStore.setState({ drafts: {} });
    stop = startComposerDrafts();
    expect(getDraft(threadDraftKey("s-1")).text).toBe("And the tests too");
    // Sent: the send clears the draft, and storage follows.
    clearDraft(threadDraftKey("s-1"));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readStored().threads).toEqual({});
  });

  it("drops a thread's unsent text when the thread is archived or removed, once the threads are known", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, texts: {}, threads: { "s-1": "keep", "s-2": "archived", "s-3": "removed" } }));
    useThreadsStore.setState({ byId: {}, order: [], loaded: false } as never);
    stop = startComposerDrafts();
    // Before the list is in, nothing is known to be gone.
    expect(getDraft(threadDraftKey("s-3")).text).toBe("removed");
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", archivedAtMs: null }, "s-2": { id: "s-2", archivedAtMs: 5 } }, order: ["s-1", "s-2"], loaded: true } as never);
    });
    expect(getDraft(threadDraftKey("s-1")).text).toBe("keep");
    expect(useComposeStore.getState().drafts[threadDraftKey("s-2")]).toBeUndefined();
    expect(useComposeStore.getState().drafts[threadDraftKey("s-3")]).toBeUndefined();
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": { id: "s-1", archivedAtMs: 9 } } } as never);
    });
    expect(useComposeStore.getState().drafts[threadDraftKey("s-1")]).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readStored()).toEqual({ texts: {}, threads: {} });
  });

  it("drops a draft's text once the layout no longer lists it (sent, discarded, cleared elsewhere)", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, texts: { "d-1": "kept", "d-gone": "stale" } }));
    await seedLayout(DRAFTS([{ id: "d-1", label: "kept" }]));
    stop = startComposerDrafts();
    expect(getDraft("draft:d-1").text).toBe("kept");
    expect(useComposeStore.getState().drafts["draft:d-gone"]).toBeUndefined();
    await act(async () => {
      await seedLayout({ ...DRAFTS([]), rev: 2 });
    });
    expect(useComposeStore.getState().drafts["draft:d-1"]).toBeUndefined();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(readStoredTexts()).toEqual({});
  });

  it("keeps a draft being started though the layout does not list it yet", async () => {
    runLayoutCommand.mockImplementation(() => new Promise(() => undefined));
    stop = startComposerDrafts();
    updateDraft("web", { text: "hello" });
    composerTextChanged("t-c", "", "web");
    await act(async () => {
      await seedLayout({ ...DRAFTS([]), rev: 2 });
    });
    const id = Object.keys(useComposeStore.getState().drafts).find((k) => k.startsWith("draft:")) ?? "";
    expect(getDraft(id).text).toBe("hello");
    expect(useLayoutStore.getState().rev).toBe(2);
  });
});
