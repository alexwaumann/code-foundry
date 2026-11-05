import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import type { ThreadView } from "@/api/threads";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import { PanelKeyContext } from "@/components/panel/panelKeyContext";
import { useCommandsStore } from "@/stores/commands";
import { useFileEditStore } from "@/stores/fileEdit";
import { openFileInPanel } from "@/stores/filePanel";
import { allTabs, usePanelStore } from "@/stores/panel";
import { useThreadsStore } from "@/stores/threads";
import { fileOfTab, type FileTarget } from "@/surfaces/fileTarget";
import { FileTab } from "./FileTab";

const disk = vi.hoisted(() => new Map<string, Partial<FileReadView>>());
const api = vi.hoisted(() => ({ write: vi.fn(), send: vi.fn(), searched: [] as string[] }));
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  writeFile: api.write,
  readFile: (_base: string, path: string) => {
    const f = disk.get(path) ?? { notFound: true };
    return Promise.resolve({ path, size: 0, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: null, notFound: false, isDir: false, text: null, lossless: false, image: null, pdf: null, ...f });
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
const target: FileTarget = { project: "repo", base: "/Users/me/w", path: ENV, edit: true, ask: { thread: "s-1", note: "" } };
const thread = (id: string, name: string) => ({ id, name, projectId: "repo", worktreePath: "/Users/me/w", workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [] }) as unknown as ThreadView;
const text = { text: "A=1\n", lossless: true, size: 4, modifiedAtMs: 100 };

/** The tab as the panel draws it: from the panel store, under the panel's key. */
function PanelTab() {
  const tab = usePanelStore((s) => allTabs(s.byKey[PANEL] ?? { open: false, groups: [] })[0]);
  const file = tab ? fileOfTab(tab) : null;
  return <PanelKeyContext value={PANEL}>{file && <FileTab key={tab?.id} target={file} />}</PanelKeyContext>;
}

function asked(over: Partial<FileTarget> = {}) {
  openFileInPanel(PANEL, { ...target, ...over });
  return render(<PanelTab />);
}

const band = () => screen.queryByTestId("file-request");
const type = (value: string) => {
  draft.text = value;
  fireEvent.change(screen.getByTestId("draft"), { target: { value } });
};
const tell = () => screen.getByTestId<HTMLButtonElement>("file-request-tell");

beforeEach(() => {
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
  usePanelStore.setState({ byKey: {} });
  useCommandsStore.setState({ commands: [] });
});

describe("the band", () => {
  it("names the thread, and follows a rename by id", async () => {
    asked();
    await screen.findByTestId("draft");
    expect(band()?.textContent).toContain("Set up billing asked you to edit this file");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", "Billing keys") } }));
    });
    expect(band()?.textContent).toContain("Billing keys asked you to edit this file");
  });

  it("says who asked when that is another thread than the panel's", async () => {
    asked({ ask: { thread: "s-2", note: "" } });
    await screen.findByTestId("draft");
    expect(band()?.textContent).toContain("Another asked you to edit this file");
  });

  it("shows the note as text, and none when there is none", async () => {
    const note = "**Bold** <img src=x onerror=alert(1)> [link](http://x) <b>b</b>";
    asked({ ask: { thread: "s-1", note } });
    await screen.findByTestId("draft");
    const shown = screen.getByTestId("file-request-note");
    expect(shown.textContent).toBe(note);
    expect(shown.children).toHaveLength(0);
    cleanup();
    usePanelStore.setState({ byKey: {} });
    asked();
    await screen.findByTestId("draft");
    expect(screen.queryByTestId("file-request-note")).toBeNull();
  });

  it("says nothing about who can read what", async () => {
    asked({ ask: { thread: "s-1", note: "" } });
    await screen.findByTestId("draft");
    expect(band()?.textContent).not.toMatch(/private|cannot (read|see)|can't (read|see)|hidden|secret/i);
  });

  it("carries the chord, which row two's Save gives up while it is there", async () => {
    asked();
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

  it("Dismiss hides it, sends nothing, leaves the tab editing, and it does not return", async () => {
    asked();
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

  it("Save and tell writes, tells, and goes", async () => {
    asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    fireEvent.click(tell());
    await waitFor(() => {
      expect(band()).toBeNull();
    });
    expect(api.send).toHaveBeenCalledWith({ id: "s-1", text: "I saved .env." });
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
  });

  it("a conflict leaves it up with the conflict's band, and tells nobody", async () => {
    asked();
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
    asked();
    await screen.findByTestId("draft");
    type("A=2\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    api.send.mockRejectedValue(new Error("thread s-1 not found"));
    fireEvent.click(tell());
    const failed = await screen.findByTestId("file-edit-failed");
    expect(failed.textContent).toBe("Saved, but Set up billing was not told: thread s-1 not found");
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
  });

  it("a line stays marked while the document is as it came", async () => {
    asked({ line: 2 });
    await screen.findByTestId("draft");
    expect(screen.getByTestId("code-file").hasAttribute("data-mark")).toBe(true);
    expect(screen.getByTestId("code-file").getAttribute("data-selected")).toBe("2");
    type("changed\n");
    await waitFor(() => {
      expect(screen.getByTestId("code-file").hasAttribute("data-mark")).toBe(false);
    });
  });

  it("a repeat request shows the new note over a draft, which stays", async () => {
    asked({ ask: { thread: "s-1", note: "First" } });
    await screen.findByTestId("draft");
    type("half typed\n");
    const before = useFileEditStore.getState().sessions;
    act(() => {
      openFileInPanel(PANEL, { ...target, ask: { thread: "s-1", note: "Second" } });
    });
    expect(screen.getByTestId("file-request-note").textContent).toBe("Second");
    expect(useFileEditStore.getState().sessions).toBe(before);
    expect(screen.getByTestId("file-edit-status").textContent).toBe("Unsaved");
  });
});

describe("a new file", () => {
  const fresh = () => {
    disk.delete(ENV);
    return asked({ create: true });
  };

  it("is an empty document marked New file, with no pencil, no meta and no File not found", async () => {
    fresh();
    await screen.findByTestId("draft");
    expect(screen.getByTestId("file-edit-status").textContent).toBe("New file");
    expect(screen.getByTestId("code-file").textContent).toBe("");
    expect(screen.queryByTestId("file-not-found")).toBeNull();
    expect(screen.queryByTestId("file-edit")).toBeNull();
    expect(screen.queryByTestId("file-meta")).toBeNull();
  });

  it("never goes looking for a namesake in the checkout", async () => {
    fresh();
    await screen.findByTestId("draft");
    expect(api.searched).toEqual([]);
    expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe(ENV);
  });

  it("stays New file with an unsaved dot, and Save and tell waits for something typed", async () => {
    fresh();
    await screen.findByTestId("draft");
    expect(tell().disabled).toBe(true);
    type("A=1\n");
    await waitFor(() => {
      expect(tell().disabled).toBe(false);
    });
    expect(screen.getByTestId("file-edit-status").textContent).toBe("New file");
  });

  it("becomes an ordinary editing tab once saved", async () => {
    fresh();
    await screen.findByTestId("draft");
    type("A=1\n");
    api.write.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 200, conflict: false, notFound: false });
    fireEvent.click(tell());
    await waitFor(() => {
      expect(screen.getByTestId("file-edit-status").textContent).toBe("Editing");
    });
    expect(api.write).toHaveBeenCalledWith("/Users/me/w", ENV, "A=1\n", expect.anything(), { create: true });
    expect(api.send).toHaveBeenCalledWith({ id: "s-1", text: "I saved .env." });
    expect(screen.getByTestId("file-edit")).not.toBeNull();
  });
});
