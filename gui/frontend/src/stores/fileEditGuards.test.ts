import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import { answerAlternate, answerConfirm, useConfirmStore } from "./confirm";
import { fileEditKey, noteDraft, startEdit, useFileEditStore } from "./fileEdit";
import { guardArchive, guardRemoveSpaceArchive, threadsArchived } from "./fileEditGuards";
import { applyLayoutOp } from "@/api/layout";
import { openTab } from "@/shell/host";
import { fileTab } from "@/surfaces/fileTarget";
import { layoutSettled, resetFakeLayout } from "@/test/fakeLayout";
import { useLayoutStore } from "./layout";
import { useThreadsStore } from "./threads";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
const lib = vi.hoisted(() => ({ drafts: new Map<string, string>() }));
vi.mock("@/lib/codeEditor", () => ({
  loadCodeEditor: () => Promise.resolve(),
  draftText: (k: string) => lib.drafts.get(k) ?? null,
  forgetDraft: (k: string) => lib.drafts.delete(k),
}));
const api = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@/api/files", async (orig) => ({ ...(await orig<typeof import("@/api/files")>()), writeFile: api.write }));

const view: FileReadView = { path: "/w/.env", realPath: "", mode: 0, size: 4, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 100, notFound: false, isDir: false, outsideHome: false, text: "a=1\n", lossless: true, image: null, pdf: null };
const tab = fileTab({ project: "", base: "/w", path: ".env" });
const PANEL = "thread:s-1";
const KEY = fileEditKey(PANEL, tab.id);
const ctx = { activeThreadId: "s-1" };

/** Thread s-1's .env with unsaved edits, its tab open or (`putAway`) closed with its thread. */
async function dirty(putAway = false): Promise<void> {
  openTab(PANEL, tab);
  await layoutSettled();
  await startEdit(KEY, { panelKey: PANEL, tabId: tab.id, base: "/w" }, view);
  const s = useFileEditStore.getState().sessions[KEY];
  lib.drafts.set(s?.stateKey ?? "", "a=22\n");
  noteDraft(KEY, "a=22\n");
  if (putAway) {
    await applyLayoutOp({ op: "close_thread", thread: "s-1" });
    await layoutSettled();
  }
}

const thread = (id: string, archived: boolean) => ({ id, name: `Thread ${id}`, archivedAtMs: archived ? 1 : null });

beforeEach(async () => {
  await resetFakeLayout("spaces");
  api.write.mockReset();
  useThreadsStore.setState({ order: ["s-1", "s-3"], byId: { "s-1": thread("s-1", false), "s-3": thread("s-3", false) } as never });
});

afterEach(() => {
  lib.drafts.clear();
  useFileEditStore.setState({ sessions: {} });
  useConfirmStore.setState({ pending: null });
});

describe("archiving a thread with unsaved files", () => {
  it.each([
    ["archived=true", { archived: "true" }, ["s-1"]],
    ["the toggle on a live thread", {}, ["s-1"]],
    ["archived=false", { archived: "false" }, []],
    ["ids", { ids: "s-1,s-3" }, ["s-1", "s-3"]],
  ])("archives the threads %s names", (_name, args, want) => {
    expect(threadsArchived(args, ctx)).toEqual(want);
  });

  it("the toggle on an archived thread unarchives it: nothing to ask", () => {
    useThreadsStore.setState({ byId: { "s-1": thread("s-1", true) } as never });
    expect(threadsArchived({}, ctx)).toEqual([]);
  });

  it("asks for each dirty file, open or put away; Keep editing stops the archive and keeps the edits", async () => {
    await dirty(true);
    const asked = guardArchive({ archived: "true" }, ctx);
    if (asked === true) throw new Error("did not ask");
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).toMatchObject({ title: "Save changes to .env?", message: "Archiving “Thread s-1” closes this file for good. Unsaved edits are lost if you discard them.", alternateLabel: "Discard", cancelLabel: "Keep editing" });
    });
    answerConfirm(false);
    await expect(asked).resolves.toBe(false);
    expect(useFileEditStore.getState().sessions[KEY]?.dirty).toBe(true);
  });

  it("Discard lets the archive go and the edits go with it", async () => {
    await dirty();
    const asked = guardArchive({ archived: "true" }, ctx);
    if (asked === true) throw new Error("did not ask");
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerAlternate();
    await expect(asked).resolves.toBe(true);
    expect(useFileEditStore.getState().sessions[KEY]).toBeUndefined();
    expect(api.write).not.toHaveBeenCalled();
  });

  it("another thread's archive, an unarchive or a clean file asks nothing", async () => {
    await dirty();
    expect(guardArchive({ archived: "true" }, { activeThreadId: "s-3" })).toBe(true);
    expect(guardArchive({ archived: "false" }, ctx)).toBe(true);
    noteDraft(KEY, "a=1\n");
    expect(guardArchive({ archived: "true" }, ctx)).toBe(true);
  });
});

describe("removing a space with its threads archived", () => {
  it("asks about its threads' dirty files, not another space's", async () => {
    await dirty();
    expect(useLayoutStore.getState().currentSpaceId).toBe("sp-main");
    expect(guardRemoveSpaceArchive("sp-review")).toBe(true);
    const asked = guardRemoveSpaceArchive("sp-main");
    if (asked === true) throw new Error("did not ask");
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.message).toBe("Removing this space archives its threads, which closes this file for good. Unsaved edits are lost if you discard them.");
    });
    answerConfirm(false);
    await expect(asked).resolves.toBe(false);
  });
});
