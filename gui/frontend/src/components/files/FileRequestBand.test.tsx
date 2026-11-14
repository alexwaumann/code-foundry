import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import type { ThreadView } from "@/api/threads";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { useCommandsStore } from "@/stores/commands";
import { useFileEditStore } from "@/stores/fileEdit";
import { openFileInPanel } from "@/stores/filePanel";
import { useTabPlace } from "@/shell/host";
import { layoutSettled, resetFakeLayout, threadSeed } from "@/test/fakeLayout";
import { useThreadsStore } from "@/stores/threads";
import { fileOfTab, type FileAsk, type FileTarget } from "@/surfaces/fileTarget";
import { FileTab } from "./FileTab";

const disk = vi.hoisted(() => new Map<string, Partial<FileReadView>>());
const api = vi.hoisted(() => ({ write: vi.fn(), send: vi.fn(), searched: [] as string[] }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  writeFile: api.write,
  readFile: (_base: string, path: string) => {
    const f = disk.get(path) ?? { notFound: true };
    return Promise.resolve({ path, realPath: path, mode: 0o600, size: 0, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: null, notFound: false, isDir: false, outsideHome: false, text: null, lossless: false, image: null, pdf: null, ...f });
  },
}));
vi.mock("@/api/filesystem", async (orig) => ({
  ...(await orig<typeof import("@/api/filesystem")>()),
  searchFiles: (req: { query: string }) => {
    api.searched.push(req.query);
    return Promise.resolve({ matches: [{ path: "elsewhere/.env", isDir: false }], truncated: false });
  },
}));
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  invokeConfirmed: (_name: string, args: unknown) => api.send(args) as Promise<unknown>,
  refreshCommands: () => Promise.resolve(),
}));
// The editor is the library's; here a text box the test types in.
const draft = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("@/lib/codeEditor", () => ({ loadCodeEditor: () => Promise.resolve(), draftText: () => draft.text, forgetDraft: () => undefined, createCodeEditor: () => undefined }));
vi.mock("@/components/code/CodeFile", () => ({
  CodeFile: ({ contents, selectedLines, edit }: { contents: string; selectedLines?: { start: number } | null; edit?: CodeFileEdit }) => (
    <>
      <pre data-testid="code-file" data-selected={selectedLines?.start} data-mark={edit?.mark ? "" : undefined}>
        {contents}
      </pre>
      {edit?.active && (
        <textarea
          data-testid="draft"
          onChange={(e) => {
            edit.onChange(e.target.value);
          }}
        />
      )}
    </>
  ),
}));

const PANEL = "thread:s-1";
const ENV = "/Users/me/w/.env";
const ask = (over: Partial<FileAsk> = {}): FileAsk => ({ id: "ask-1", thread: "s-1", note: "", ...over });
const target: FileTarget = { project: "repo", base: "/Users/me/w", path: ENV, edit: true, ask: ask() };
const thread = (id: string, name: string) => ({ id, name, projectId: "repo", worktreePath: "/Users/me/w", workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [] }) as unknown as ThreadView;
const text = { text: "A=1\n", lossless: true, size: 4, modifiedAtMs: 100 };

/** The tab as a pane draws it: from the layout, under the thread's key. */
function PanelTab() {
  const tab = useTabPlace(PANEL, (p) => p.tabs[0]);
  const file = tab ? fileOfTab(tab) : null;
  return <PanelKeyContext value={PANEL}>{file && <FileTab key={tab?.id} target={file} />}</PanelKeyContext>;
}

/** Opens the request's tab and draws it once the layout has it. */
async function asked(over: Partial<FileTarget> = {}) {
  openFileInPanel(PANEL, { ...target, ...over });
  const r = render(<PanelTab />);
  await reopened();
  return r;
}

/** Waits for the layout to answer what was sent (a repeat request's tab update). */
async function reopened(): Promise<void> {
  await act(async () => {
    await layoutSettled();
  });
}

const band = () => screen.queryByTestId("file-request");
const type = (value: string) => {
  draft.text = value;
  fireEvent.change(screen.getByTestId("draft"), { target: { value } });
};
const tell = () => screen.getByTestId<HTMLButtonElement>("file-request-tell");

beforeEach(async () => {
  await resetFakeLayout(threadSeed("s-1"));
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", "Set up billing"), "s-2": thread("s-2", "Another") }, order: ["s-1", "s-2"] });
  useCommandsStore.setState({ commands: [{ name: "file.save", keybindings: ["cmd+s"] } as never] });
  disk.set(ENV, text);
  api.write.mockReset();
  api.send.mockReset();
  api.send.mockResolvedValue({ ok: true });
  api.searched = [];
  draft.text = null;
});

afterEach(() => {
  cleanup();
  disk.clear();
  useFileEditStore.setState({ sessions: {} });
  useCommandsStore.setState({ commands: [] });
});

describe("the band", () => {
  it("names the thread, and follows a rename by id", async () => {
    await asked();
    await screen.findByTestId("draft");
    expect(band()?.textContent).toContain('Thread "Set up billing" asked you to edit this file');
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", "Billing keys") } }));
    });
    expect(band()?.textContent).toContain('Thread "Billing keys" asked you to edit this file');
  });

  it("says who asked when that is another thread than the panel's", async () => {
    await asked({ ask: ask({ thread: "s-2" }) });
    await screen.findByTestId("draft");
    expect(band()?.textContent).toContain('Thread "Another" asked you to edit this file');
  });

  it("shows the note as text, and none when there is none", async () => {
    const note = "**Bold** <img src=x onerror=alert(1)> [link](http://x) <b>b</b>";
    await asked({ ask: ask({ note }) });
    await screen.findByTestId("draft");
    const shown = screen.getByTestId("file-request-note");
    expect(shown.textContent).toBe(note);
    expect(shown.children).toHaveLength(0);
    expect(shown.tagName).toBe("BLOCKQUOTE");
    cleanup();
    await resetFakeLayout(threadSeed("s-1"));
    await asked();
    await screen.findByTestId("draft");
    expect(screen.queryByTestId("file-request-note")).toBeNull();
  });

  it("gives a note and a name no layout of their own, whatever reached the tab", async () => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", `Code Foundry\n\n\u202e${"x".repeat(80)}`) } }));
    await asked({ ask: ask({ note: `Code Foundry${"\n".repeat(60)}Session\u202e expired${"\u0301".repeat(400)}` }) });
    await screen.findByTestId("draft");
    expect(screen.getByTestId("file-request-note").textContent).toBe("Code Foundry Session expired\u0301\u0301\u0301");
    expect(band()?.textContent).toContain(`Thread "Code Foundry ${"x".repeat(35)}…" asked you to edit this file`);
    expect(band()?.textContent).not.toContain("\u202e");
  });

  it("says nothing about who can read what", async () => {
    await asked({ ask: ask() });
    await screen.findByTestId("draft");
    expect(band()?.textContent).not.toMatch(/private|cannot (read|see)|can't (read|see)|hidden|secret/i);
  });

  it("carries the chord, which row two's Save gives up while it is there", async () => {
    await asked();
    await screen.findByTestId("draft");
    expect(tell().textContent).toContain("Save and tell thread");
    expect(tell().textContent).toContain("⌘S");
    expect(screen.getByTestId("file-save").textContent).toBe("Save");
    fireEvent.click(screen.getByTestId("file-request-dismiss"));
    await waitFor(() => {
      expect(band()).toBeNull();
    });
    expect(screen.getByTestId("file-save").textContent).toContain("⌘S");
  });

  it("a clean document never saved for this request has nothing to tell: only Dismiss", async () => {
    await asked();
    await screen.findByTestId("draft");
    expect(tell().disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("file-request-dismiss").disabled).toBe(false);
  });

  it("row two's Save opens the way: the thread can be told, truthfully", async () => {
    await asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    fireEvent.click(screen.getByTestId("file-save"));
    await waitFor(() => {
      expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
    });
    expect(api.send).not.toHaveBeenCalled();
    expect(tell().disabled).toBe(false);
    fireEvent.click(tell());
    await waitFor(() => {
      expect(api.send).toHaveBeenCalledTimes(1);
    });
    expect(api.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a link", { realPath: "/Users/me/Public/drop.txt", mode: 0o644 }, ["This path is a link: the file is really ~/Public/drop.txt.", "Group and others can read this file (0644)."]],
    ["group only", { mode: 0o640 }, ["Group can read this file (0640)."]],
    ["others only", { mode: 0o604 }, ["Others can read this file (0604)."]],
    ["neither", { mode: 0o600 }, []],
  ])("states where the file really is and who can read it: %s", async (_name, facts, want) => {
    disk.set(ENV, { ...text, ...facts });
    await asked();
    await screen.findByTestId("draft");
    expect(screen.queryAllByTestId("file-request-fact").map((p) => p.textContent)).toEqual(want);
  });

  it("a link's target is shown cleaned, cut, and said to be unusual; the facts lead the note", async () => {
    disk.set(ENV, { ...text, realPath: `/Users/me/${"d/".repeat(480)}\u202edrop.txt`, mode: 0o600 });
    await asked({ ask: ask({ note: "The note" }) });
    await screen.findByTestId("draft");
    const [fact] = screen.getAllByTestId("file-request-fact");
    expect(fact?.textContent).toContain("/drop.txt (its name has characters not shown here).");
    expect(fact?.textContent).toContain("…");
    expect(fact?.textContent).not.toContain("\u202e");
    expect(fact?.textContent.length).toBeLessThan(160);
    const box = screen.getByTestId("file-request-details");
    expect(box.contains(screen.getByTestId("file-request-note"))).toBe(true);
    expect(box.firstElementChild).toBe(fact);
    expect(box.contains(screen.getByTestId("file-request-tell"))).toBe(false);
  });

  it("a plain link is said plainly", async () => {
    disk.set(ENV, { ...text, realPath: "/Users/me/Public/drop.txt" });
    await asked();
    await screen.findByTestId("draft");
    expect(screen.getByTestId("file-request-fact").textContent).toBe("This path is a link: the file is really ~/Public/drop.txt.");
  });

  it("the facts go with the band", async () => {
    disk.set(ENV, { ...text, mode: 0o644 });
    await asked();
    await screen.findByTestId("draft");
    fireEvent.click(screen.getByTestId("file-request-dismiss"));
    await waitFor(() => {
      expect(band()).toBeNull();
    });
    expect(screen.queryAllByTestId("file-request-fact")).toEqual([]);
  });

  it("Dismiss hides it, sends nothing, leaves the tab editing, and it does not return", async () => {
    await asked();
    await screen.findByTestId("draft");
    type("typed\n");
    fireEvent.click(screen.getByTestId("file-request-dismiss"));
    await waitFor(() => {
      expect(band()).toBeNull();
    });
    expect(screen.getByTestId("draft")).not.toBeNull();
    expect(api.send).not.toHaveBeenCalled();
    cleanup();
    render(<PanelTab />);
    await screen.findByTestId("draft");
    expect(band()).toBeNull();
  });

  it("a chmod or a re-link shows on the next read, the draft untouched", async () => {
    disk.set(ENV, { ...text, mode: 0o600 });
    await asked();
    await screen.findByTestId("draft");
    type("half typed\n");
    expect(screen.queryAllByTestId("file-request-fact")).toEqual([]);
    disk.set(ENV, { ...text, mode: 0o644, realPath: "/Users/me/Public/drop.txt" });
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(screen.getAllByTestId("file-request-fact")).toHaveLength(2);
    });
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Unsaved");
    expect(screen.queryByTestId("file-conflict")).toBeNull();
  });

  it("Save and tell writes, tells, and goes", async () => {
    await asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    fireEvent.click(tell());
    await waitFor(() => {
      expect(band()).toBeNull();
    });
    expect(api.send).toHaveBeenCalledWith({ id: "s-1", text: "I saved .env. Continue without reading its values." });
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
  });

  it("a conflict leaves it up with the conflict's band, and tells nobody", async () => {
    await asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 9, modifiedAtMs: 300, conflict: true, notFound: false });
    fireEvent.click(tell());
    await screen.findByTestId("file-conflict");
    expect(band()).not.toBeNull();
    expect(tell().disabled).toBe(true);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("a send that fails says so in the tab, and the save stands", async () => {
    await asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    api.send.mockRejectedValue(new Error("thread s-1 not found"));
    fireEvent.click(tell());
    const failed = await screen.findByTestId("file-edit-failed");
    expect(failed.textContent).toBe('Saved, but Thread "Set up billing" was not told: thread s-1 not found');
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
  });

  it("a line stays marked while the document is as it came", async () => {
    await asked({ line: 2 });
    await screen.findByTestId("draft");
    expect(screen.getByTestId("code-file").hasAttribute("data-mark")).toBe(true);
    expect(screen.getByTestId("code-file").getAttribute("data-selected")).toBe("2");
    type("changed\n");
    await waitFor(() => {
      expect(screen.getByTestId("code-file").hasAttribute("data-mark")).toBe(false);
    });
  });

  it("a repeat request shows the new note over a draft, which stays", async () => {
    await asked({ ask: ask({ note: "First" }) });
    await screen.findByTestId("draft");
    type("half typed\n");
    const before = useFileEditStore.getState().sessions;
    openFileInPanel(PANEL, { ...target, ask: ask({ id: "ask-2", note: "Second" }) });
    await reopened();
    expect(screen.getByTestId("file-request-note").textContent).toBe("Second");
    expect(useFileEditStore.getState().sessions).toBe(before);
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Unsaved");
  });
});

describe("a repeat request", () => {
  it("brings editing and the band back after the pencil turned them off, the same note or not", async () => {
    await asked({ ask: ask({ note: "Same" }) });
    await screen.findByTestId("draft");
    fireEvent.click(screen.getByTestId("file-edit"));
    await waitFor(() => {
      expect(screen.queryByTestId("draft")).toBeNull();
    });
    expect(band()).toBeNull();
    openFileInPanel(PANEL, { ...target, ask: ask({ id: "ask-2", note: "Same" }) });
    await reopened();
    await screen.findByTestId("draft");
    expect(band()).not.toBeNull();
  });

  it("forgets that a write landed for the one before: this one has none", async () => {
    await asked({ ask: ask({ saved: "4:100" }) });
    await screen.findByTestId("draft");
    expect(tell().disabled).toBe(false);
    openFileInPanel(PANEL, { ...target, ask: ask({ id: "ask-2" }) });
    await reopened();
    expect(tell().disabled).toBe(true);
  });
});

describe("a new file", () => {
  const fresh = () => {
    disk.delete(ENV);
    return asked();
  };

  it("a file deleted before the tab opened takes this path, so the request can be answered", async () => {
    disk.delete(ENV);
    await asked();
    await screen.findByTestId("draft");
    expect(band()).not.toBeNull();
    expect(screen.getByTestId("file-edit-status").textContent).toBe("New file");
  });

  it("is an empty document marked New file, with no pencil, no meta and no File not found", async () => {
    await fresh();
    await screen.findByTestId("draft");
    expect(screen.getByTestId("file-edit-status").textContent).toBe("New file");
    expect(screen.getByTestId("code-file").textContent).toBe("");
    expect(screen.queryByTestId("file-not-found")).toBeNull();
    expect(screen.queryByTestId("file-edit")).toBeNull();
    expect(screen.queryByTestId("file-meta")).toBeNull();
  });

  it("never goes looking for a namesake in the checkout", async () => {
    await fresh();
    await screen.findByTestId("draft");
    expect(api.searched).toEqual([]);
    expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe(ENV);
  });

  it("stays New file with an unsaved dot, and Save and tell waits for something typed", async () => {
    await fresh();
    await screen.findByTestId("draft");
    expect(tell().disabled).toBe(true);
    type("A=1\n");
    await waitFor(() => {
      expect(tell().disabled).toBe(false);
    });
    expect(screen.getByTestId("file-edit-status").textContent).toBe("New file");
  });

  it("becomes an ordinary editing tab once saved", async () => {
    await fresh();
    await screen.findByTestId("draft");
    type("A=1\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    fireEvent.click(tell());
    await waitFor(() => {
      expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
    });
    expect(api.write).toHaveBeenCalledWith("/Users/me/w", ENV, "A=1\n", expect.anything(), { create: true });
    expect(api.send).toHaveBeenCalledWith({ id: "s-1", text: "I saved .env. Continue without reading its values." });
    expect(screen.getByTestId("file-edit")).not.toBeNull();
  });
});
