import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import type { CodeFileEdit } from "@/components/code/CodeFile";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import type { ThreadView } from "@/api/threads";
import { useCodeViewStore } from "@/stores/codeView";
import { fileEditKey, useFileEditStore } from "@/stores/fileEdit";
import { canSearchFile, openFileFind, useFileFindStore } from "@/stores/fileFind";
import { openFileInPanel } from "@/stores/filePanel";
import { shownTab, tabPlace } from "@/shell/host";
import { layoutSettled, resetFakeLayout, threadSeed } from "@/test/fakeLayout";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { fileOfTab, fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { FileTab } from "./FileTab";

// readFile answers from `files`; pdf.js does not run in jsdom (no canvas), so lib/pdf is a
// fake that opens any blob as 3 pages and never draws.
const files = vi.hoisted(() => new Map<string, Partial<FileReadView>>());
const reads = vi.hoisted(() => [] as string[]);
const writes = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
const tails = vi.hoisted(() => [] as string[]);
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  writeFile: writes.fn,
  // A tail read (a .log) answers the same, and is noted.
  readFileTail: (base: string, path: string) => {
    tails.push(path.startsWith("/") ? path : `${base}/${path}`);
    return Promise.resolve({ path: path.startsWith("/") ? path : `${base}/${path}`, size: 0, truncated: false, binary: true, mime: "", modifiedAtMs: null, notFound: false, isDir: false, outsideHome: false, text: null, lossless: false, image: null, pdf: null, ...(files.get(path.startsWith("/") ? path : `${base}/${path}`) ?? { notFound: true }) });
  },
  readFile: (base: string, path: string) => {
    const abs = path.startsWith("/") ? path : `${base}/${path}`;
    reads.push(abs);
    const f = files.get(abs) ?? { notFound: true };
    const view = { path: abs, size: 0, truncated: false, binary: true, mime: "", modifiedAtMs: null, notFound: false, isDir: false, outsideHome: false, text: null, lossless: false, image: null, pdf: null, ...f };
    return held.on
      ? new Promise((resolve) => {
          held.pending.push(() => {
            resolve(view);
          });
        })
      : Promise.resolve(view);
  },
}));
// searchFiles (findMissing's retry) lists `listed`, checkout-relative, filtered by file name.
const listed = vi.hoisted(() => ({ paths: [] as string[], calls: [] as string[] }));
vi.mock("@/api/filesystem", async (orig) => ({
  ...(await orig<typeof import("@/api/filesystem")>()),
  searchFiles: (req: { projectId: string; path?: string; query: string }) => {
    listed.calls.push(`${req.projectId} ${req.path ?? ""} ${req.query}`);
    return Promise.resolve({ matches: listed.paths.filter((p) => p.endsWith(req.query)).map((path) => ({ path, isDir: false })), truncated: false });
  },
}));
const loadPdf = vi.hoisted(() =>
  vi.fn<(file: Blob) => Promise<unknown>>(() => Promise.resolve({ pages: 3, pageSize: () => Promise.resolve({ width: 300, height: 200 }), renderPage: () => Promise.reject(new Error("no canvas")), destroy: () => undefined })),
);
vi.mock("@/lib/pdf", () => ({ loadPdf }));
// The code view is @pierre/diffs' (a real browser draws and scrolls it: e2e/file-tabs.spec.ts):
// a stand-in that shows the text and the line it was asked to mark.
// With an editor on, it takes "typing" through a text box the test fills.
vi.mock("@/components/code/CodeFile", () => ({
  CodeFile: ({ contents, lang, selectedLines, edit }: { contents: string; lang?: string; selectedLines?: { start: number } | null; edit?: CodeFileEdit }) => (
    <>
      <pre data-testid="code-file" data-lang={lang} data-selected={selectedLines?.start} data-editing={edit?.active ? "" : undefined}>
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
// The library's draft: what the stand-in above was last told is what a save reads.
const draft = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("@/lib/codeEditor", () => ({ loadCodeEditor: () => Promise.resolve(), draftText: () => draft.text, forgetDraft: () => undefined, createCodeEditor: () => undefined }));
// What Copy path and Copy contents put on the clipboard.
const copied = vi.hoisted(() => ({ fn: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()) }));
vi.mock("@/lib/clipboard", () => ({ copyText: copied.fn }));
// A made-up kind beside the real ones, for what no shipped kind does yet: `.grid` files show
// a Grid mode with controls of their own, copy as tab-separated text, wrap, and never edit.
vi.mock("./previews/registry", async (orig) => {
  const real = await orig<typeof import("./previews/registry")>();
  const { createElement } = await import("react");
  const grid: import("./previews/types").PreviewKind = {
    id: "grid",
    match: { ext: ["grid"] },
    modes: [{ id: "grid", label: "Grid" }],
    Body: () => createElement("div", { "data-testid": "grid-body" }),
    meta: ({ file }) => `${String(file.size)} B · Grid`,
    Controls: ({ mode }) => createElement("span", { "data-testid": "grid-controls" }, mode),
    copy: ({ file }) => (file.text ?? "").replaceAll(",", "\t"),
    wrap: true,
    edit: false,
  };
  const kinds = [...real.PREVIEW_KINDS, grid];
  return { ...real, PREVIEW_KINDS: kinds, previewKindOf: (path: string, file: FileReadView | null) => real.previewKindOf(path, file, kinds) };
});
// Held, readFile's next answers wait for release(): a read still out while something else happens.
const held = vi.hoisted(() => ({ on: false, pending: [] as (() => void)[] }));
// The worktree detail a project's File tab watches (worktree_detail_updated re-reads it).
const detail = vi.hoisted(() => ({ computedAtMs: 1 }));
vi.mock("@/api/worktreeDetail", async (orig) => ({
  ...(await orig<typeof import("@/api/worktreeDetail")>()),
  getWorktreeDetail: () => Promise.resolve({ files: [], log: [], computedAtMs: detail.computedAtMs }),
}));

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  // PdfPages draws a page as it nears the view; nothing intersects in jsdom.
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  files.clear();
  listed.paths = [];
  listed.calls = [];
  reads.length = 0;
  tails.length = 0;
  loadPdf.mockClear();
  useCodeViewStore.setState({ diffStyle: "unified", wrap: false, preview: {} });
  useFileEditStore.setState({ sessions: {} });
  writes.fn.mockReset();
  copied.fn.mockClear();
  draft.text = null;
  held.on = false;
  held.pending = [];
  localStorage.clear();
});

const MiB = 1024 * 1024;
const open = (path: string) => render(<FileTab target={{ project: "", base: "/Users/me/w", path }} />);

describe("FileTab", () => {
  it("a path not found at the checkout opens the one file in it that ends with the path, searching once", async () => {
    files.set("/Users/me/w/gui/frontend/src/a.ts", { text: "export const a = 1;\n", binary: false, mime: "text/typescript", size: 20 });
    listed.paths = ["gui/frontend/src/a.ts", "gui/frontend/src/b.ts"];
    render(<FileTab target={{ project: "p1", base: "/Users/me/w", path: "src/a.ts", line: 1 }} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe("/Users/me/w/gui/frontend/src/a.ts");
    });
    expect(screen.queryByTestId("file-not-found")).toBeNull();
    expect(listed.calls).toEqual(["p1 /Users/me/w a.ts"]);
    // Refresh reads the file found; no second search.
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(screen.getByTestId("file-tab").getAttribute("data-loading")).toBeNull();
    });
    expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe("/Users/me/w/gui/frontend/src/a.ts");
    expect(listed.calls).toHaveLength(1);
  });

  it("a path in two places, or in a thread without a project, stays not found", async () => {
    listed.paths = ["gui/src/a.ts", "web/src/a.ts"];
    const first = render(<FileTab target={{ project: "p1", base: "/Users/me/w", path: "src/a.ts" }} />);
    expect((await screen.findByTestId("file-not-found")).textContent).toContain("~/w/src/a.ts");
    expect(listed.calls).toHaveLength(1);
    first.unmount();
    listed.calls = [];
    open("src/a.ts");
    expect(await screen.findByTestId("file-not-found")).toBeTruthy();
    expect(listed.calls).toEqual([]);
  });

  it("a PDF shows its pages filling the tab; the meta gains the page count once pdf.js opens it", async () => {
    files.set("/Users/me/w/spec.pdf", { size: Math.round(4.2 * MiB), mime: "application/pdf", pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    open("spec.pdf");
    const pages = await screen.findByTestId("pdf-pages");
    await waitFor(() => {
      expect(pages.querySelectorAll('[data-testid="pdf-page"]')).toHaveLength(3);
    });
    expect(screen.getByTestId("file-pdf")).toBeTruthy();
    expect(pages.className).toContain("flex-1");
    expect(pages.className).not.toContain("max-h-");
    expect(screen.getByTestId("file-meta").textContent).toBe("3 pages · 4.2 MB · PDF");
    // A typed copy of the bytes: pdf.js and the viewer read a PDF.
    const blob = loadPdf.mock.calls[0]?.[0];
    expect(blob?.type).toBe("application/pdf");
    expect(blob?.size).toBe(4);
    // No source mode, no wrap, no binary placeholder.
    expect(screen.queryByTestId("file-mode")).toBeNull();
    expect(screen.queryByTestId("file-wrap")).toBeNull();
    expect(screen.queryByTestId("file-binary")).toBeNull();
  });

  it("a PDF that came back truncated is too large to show and never reaches pdf.js", async () => {
    files.set("/Users/me/w/huge.pdf", { size: 48 * MiB, truncated: true, mime: "application/pdf", pdf: new Uint8Array([0x25]) });
    open("huge.pdf");
    const state = await screen.findByTestId("file-pdf-too-large");
    expect(state.textContent).toContain("PDF · 48.0 MB · too large to show");
    expect(within(state).getByRole("button", { name: "Open in editor" })).toBeTruthy();
    expect(within(state).getByRole("button", { name: "Open in Finder" })).toBeTruthy();
    expect(screen.getByTestId("file-meta").textContent).toBe("48.0 MB · PDF");
    expect(screen.queryByTestId("file-truncated")).toBeNull();
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it("an image that came back truncated is too large to show; a whole one is shown", async () => {
    files.set("/Users/me/w/huge.png", { size: 48 * MiB, truncated: true, mime: "image/png", image: new Uint8Array([0x89]) });
    files.set("/Users/me/w/big.png", { size: 2 * MiB, mime: "image/png", image: new Uint8Array([0x89]) });
    const first = open("huge.png");
    expect((await screen.findByTestId("file-image-too-large")).textContent).toContain("Image · 48.0 MB · too large to show");
    expect(screen.queryByTestId("file-image")).toBeNull();
    expect(screen.queryByTestId("file-truncated")).toBeNull();
    first.unmount();
    open("big.png");
    expect(await screen.findByTestId("file-image")).toBeTruthy();
    expect(screen.queryByTestId("file-image-too-large")).toBeNull();
  });

  // The rest moved from e2e/file-tabs.spec.ts, against the mock's files (mock/files.ts).
  const CF = "/Users/dev/src/code-foundry";
  const openIn = (path: string, line?: number) => render(<FileTab target={{ project: "repo-cf", base: CF, path, ...(line ? { line } : {}) }} />);
  const tab = () => screen.getByTestId("file-tab");
  const meta = () => screen.getByTestId("file-meta").textContent;
  const README = "# code-foundry\n\nA desktop app.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

  it("markdown: Rendered by default, Source at the line with the wrap toggle; the choice is remembered for the next markdown file", async () => {
    files.set(`${CF}/README.md`, { text: README, binary: false, mime: "text/markdown", size: README.length, modifiedAtMs: Date.now() - 120_000 });
    files.set(`${CF}/notes/plan.md`, { text: "# Plan\n", binary: false, mime: "text/markdown", size: 7 });
    const first = openIn("README.md", 3);
    const md = await screen.findByTestId("file-markdown");
    expect(tab().dataset.path).toBe(`${CF}/README.md`);
    expect(tab().dataset.mode).toBe("rendered");
    expect(within(md).getByRole("heading", { level: 1 }).textContent).toBe("code-foundry");
    expect(md.querySelector("table")).not.toBeNull();
    expect(meta()).toBe(`saved 2m ago · ${String(README.length)} B`);
    expect(screen.queryByTestId("file-wrap")).toBeNull();

    fireEvent.click(within(screen.getByTestId("file-mode")).getByText("Source"));
    expect(tab().dataset.mode).toBe("source");
    expect(screen.getByTestId("code-file").dataset.selected).toBe("3");
    expect(meta()).toBe(`7 lines · ${String(README.length)} B · Markdown`);
    fireEvent.click(screen.getByTestId("file-wrap"));
    expect(screen.getByTestId("file-wrap").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("code-foundry.codeView")).toContain('"markdown":"source"');
    first.unmount();

    // Another markdown file opens as source now; Rendered again.
    openIn("notes/plan.md");
    await screen.findByTestId("code-file");
    expect(tab().dataset.mode).toBe("source");
    fireEvent.click(within(screen.getByTestId("file-mode")).getByText("Rendered"));
    expect(await screen.findByTestId("file-markdown")).toBeTruthy();
  });

  it("a TypeScript file at a line: its folder, lines · size · language, the line marked; another line marks that one", async () => {
    const text = Array.from({ length: 80 }, (_, i) => `export const l${String(i + 1)} = ${String(i)};`).join("\n") + "\n";
    files.set(`${CF}/src/app.ts`, { text, binary: false, mime: "text/typescript", size: 2048 });
    const { rerender } = openIn("src/app.ts", 43);
    await screen.findByTestId("code-file");
    expect(screen.getByTestId("file-header-name").textContent).toBe("app.ts");
    expect(screen.getByTestId("file-header-dir").textContent).toContain("src/");
    expect(meta()).toBe("80 lines · 2 KB · TypeScript");
    expect(screen.getByTestId("code-file").dataset.selected).toBe("43");
    rerender(<FileTab target={{ project: "repo-cf", base: CF, path: `${CF}/src/app.ts`, line: 10 }} />);
    await waitFor(() => {
      expect(screen.getByTestId("code-file").dataset.selected).toBe("10");
    });
  });

  it("an image: its size once it decodes, the bytes, the extension", async () => {
    files.set(`${CF}/docs/logo.png`, { size: 79, mime: "image/png", image: new Uint8Array([0x89]) });
    openIn("docs/logo.png");
    const img = (await screen.findByTestId("file-image")).querySelector("img") as HTMLImageElement;
    expect(meta()).toBe("79 B · PNG");
    Object.defineProperty(img, "naturalWidth", { value: 2 });
    Object.defineProperty(img, "naturalHeight", { value: 2 });
    fireEvent.load(img);
    expect(meta()).toBe("2 × 2 · 79 B · PNG");
  });

  it.each([
    ["a binary", "bin/tool", { size: Math.round(2.3 * 1024 * 1024), mime: "application/octet-stream" }, "file-binary", "Binary file · 2.3 MB"],
    ["a folder", "docs", { isDir: true }, "file-folder", "This is a folder"],
    ["a truncated text read", "big.log", { text: "line\n", binary: false, truncated: true, mime: "text/plain", size: Math.round(4.2 * 1024 * 1024) }, "file-truncated", "Showing the first 1 MiB of 4.2 MB"],
  ] as const)("%s says so", async (_n, path, f, testId, want) => {
    files.set(`${CF}/${path}`, f);
    openIn(path);
    expect((await screen.findByTestId(testId)).textContent).toContain(want);
  });

  it("a missing file says so and Retry reads again; a worktree change and Refresh read again too", async () => {
    const path = `${CF}/src/later.ts`;
    openIn("src/later.ts");
    const missing = await screen.findByTestId("file-not-found");
    expect(missing.textContent).toContain("File not found");
    expect(missing.textContent).toContain("~/src/code-foundry/src/later.ts");
    files.set(path, { text: "export const later = 1;\n", binary: false, mime: "text/typescript", size: 24 });
    fireEvent.click(screen.getByTestId("file-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("code-file").textContent).toContain("export const later = 1;");
    });

    // The daemon recomputed the worktree (worktree_detail_updated): the tab reads again.
    files.set(path, { text: "export const later = 2;\n", binary: false, mime: "text/typescript", size: 24 });
    detail.computedAtMs = 2;
    act(() => {
      worktreeDetailResource.invalidate(detailKey("repo-cf", CF));
    });
    await waitFor(() => {
      expect(screen.getByTestId("code-file").textContent).toContain("export const later = 2;");
    });

    const before = reads.filter((r) => r === path).length;
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(reads.filter((r) => r === path)).toHaveLength(before + 1);
    });
  });
});

describe("editing", () => {
  const ENV = "/Users/me/w/.env";
  const text = (over: Partial<FileReadView> = {}): Partial<FileReadView> => ({ text: "A=1\n", lossless: true, binary: false, mime: "text/plain", size: 4, modifiedAtMs: 100, ...over });
  const pencil = () => screen.findByTestId("file-edit");
  const status = () => screen.getByTestId("file-edit-status").textContent;
  const openTab = (path = ".env", over: Partial<FileTarget> = {}) =>
    render(
      <PanelKeyContext value="thread:a">
        <FileTab target={{ project: "", base: "/Users/me/w", path, ...over }} />
      </PanelKeyContext>,
    );
  const type = (value: string) => {
    draft.text = value;
    fireEvent.change(screen.getByTestId("draft"), { target: { value } });
  };
  const editing = async () => {
    fireEvent.click(await pencil());
    await screen.findByTestId("draft");
  };
  const refresh = async () => {
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(screen.getByTestId("file-tab").getAttribute("data-loading")).toBeNull();
    });
  };

  it.each<[string, string, Partial<FileReadView>, boolean]>([
    ["whole text", ENV, text(), true],
    ["an empty file", ENV, text({ text: "", size: 0 }), true],
    ["truncated", "/Users/me/w/big.log", text({ truncated: true, size: 4 * MiB }), false],
    ["binary", "/Users/me/w/tool", { binary: true, text: null, size: 9 }, false],
    ["a folder", "/Users/me/w/docs", { isDir: true, text: null }, false],
    ["invalid UTF-8", ENV, text({ text: "caf\ufffd", lossless: false }), false],
    ["a PDF", "/Users/me/w/spec.pdf", { mime: "application/pdf", pdf: new Uint8Array([1]), size: 1 }, false],
    ["an image", "/Users/me/w/logo.png", { mime: "image/png", image: new Uint8Array([1]), binary: true, size: 1 }, false],
  ])("the pencil, for %s", async (_name, path, f, offered) => {
    files.set(path, f);
    openTab(path);
    await waitFor(() => {
      expect(screen.getByTestId("file-tab").getAttribute("data-loading")).toBeNull();
    });
    expect(screen.queryByTestId("file-edit") !== null).toBe(offered);
  });

  it("no pencil for a file that is not there", async () => {
    openTab("nope.txt");
    await screen.findByTestId("file-not-found");
    expect(screen.queryByTestId("file-edit")).toBeNull();
  });

  it("the pencil is first in the row, pressed while editing, and turns the same view into the editor", async () => {
    files.set(ENV, text());
    openTab();
    expect((await pencil()).getAttribute("aria-pressed")).toBe("false");
    const actions = screen.getByTestId("file-edit").parentElement;
    expect(actions?.querySelector("button")).toBe(screen.getByTestId("file-edit"));
    fireEvent.click(await pencil());
    await screen.findByTestId("draft");
    expect((await pencil()).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("code-file").textContent).toBe("A=1\n");
  });

  it("clean: Editing, both buttons off; dirty: Unsaved with Save and Discard on, the meta between", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    expect(status()).toBe("Editing");
    expect(screen.getByTestId<HTMLButtonElement>("file-save").disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>("file-discard").disabled).toBe(true);
    type("A=2\n");
    expect(status()).toBe("Unsaved");
    expect(screen.getByTestId<HTMLButtonElement>("file-save").disabled).toBe(false);
    expect(screen.getByTestId<HTMLButtonElement>("file-discard").disabled).toBe(false);
    const bar = screen.getByTestId("file-header-bar").textContent;
    expect(bar.indexOf("Unsaved")).toBeLessThan(bar.indexOf("line"));
    expect(bar.indexOf("line")).toBeLessThan(bar.indexOf("Discard"));
  });

  it("the pencil on a clean document goes back to the viewer; on a dirty one it drops nothing", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    type("A=2\n");
    fireEvent.click(await pencil());
    expect(status()).toBe("Unsaved");
    expect(screen.getByTestId("code-file").getAttribute("data-editing")).toBe("");
    type("A=1\n");
    fireEvent.click(await pencil());
    expect(screen.queryByTestId("file-edit-status")).toBeNull();
    expect(screen.getByTestId("code-file").getAttribute("data-editing")).toBeNull();
  });

  it("Save writes the draft against the read, and stays in edit mode with the new baseline", async () => {
    files.set(ENV, text());
    writes.fn.mockResolvedValue({ path: ENV, size: 5, modifiedAtMs: 200, conflict: false, notFound: false });
    openTab();
    await editing();
    type("A=22\n");
    fireEvent.click(screen.getByTestId("file-save"));
    await waitFor(() => {
      expect(status()).toBe("Editing");
    });
    expect(writes.fn).toHaveBeenCalledWith("/Users/me/w", ENV, "A=22\n", expect.objectContaining({ size: 4, modifiedAtMs: 100 }), {});
    expect(screen.getByTestId("file-meta").textContent).toContain("5 B");
    // The editor keeps the text it started from: a new one would reset its document.
    expect(screen.getByTestId("code-file").textContent).toBe("A=1\n");
    // Now on disk, the re-read sees what it wrote: no band.
    files.set(ENV, text({ text: "A=22\n", size: 5, modifiedAtMs: 200 }));
    await refresh();
    expect(screen.queryByTestId("file-conflict")).toBeNull();
    expect(screen.getByTestId("draft")).toBeTruthy();
  });

  it("a read that left before a save and answers after it raises nothing", async () => {
    files.set(ENV, text());
    writes.fn.mockResolvedValue({ path: ENV, size: 5, modifiedAtMs: 200, conflict: false, notFound: false });
    openTab();
    await editing();
    type("A=22\n");
    held.on = true;
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(held.pending).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("file-save"));
    await waitFor(() => {
      expect(status()).toBe("Editing");
    });
    type("A=222\n");
    await act(async () => {
      for (const release of held.pending) release();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("file-conflict")).toBeNull();
    expect(status()).toBe("Unsaved");
  });

  it("every read while dirty leaves the editor's text alone and raises the band on a change", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    type("A=2\n");
    await refresh();
    expect(screen.queryByTestId("file-conflict")).toBeNull();
    files.set(ENV, text({ text: "theirs\n", size: 7, modifiedAtMs: 150 }));
    await refresh();
    expect((await screen.findByTestId("file-conflict")).textContent).toContain("Changed on disk");
    expect(screen.getByTestId("code-file").textContent).toBe("A=1\n");
    expect(screen.getByTestId("file-reload")).toBeTruthy();
    expect(screen.getByTestId("file-overwrite")).toBeTruthy();
  });

  it("a file deleted under a draft says so, keeps the editor, and offers only Overwrite", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    type("A=2\n");
    files.delete(ENV);
    await refresh();
    expect((await screen.findByTestId("file-conflict")).textContent).toContain("Deleted on disk");
    expect(screen.queryByTestId("file-reload")).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>("file-discard").disabled).toBe(false);
    expect(screen.queryByTestId("file-not-found")).toBeNull();
    expect(screen.getByTestId("draft")).toBeTruthy();
    writes.fn.mockResolvedValue({ path: ENV, size: 4, modifiedAtMs: 300, conflict: false, notFound: false });
    fireEvent.click(screen.getByTestId("file-overwrite"));
    await waitFor(() => {
      expect(screen.queryByTestId("file-conflict")).toBeNull();
    });
    expect(writes.fn.mock.lastCall?.[4]).toEqual({ force: true });
  });

  it("a file deleted under a clean document says so too, and Discard is there to leave", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    files.delete(ENV);
    await refresh();
    expect((await screen.findByTestId("file-conflict")).textContent).toContain("Deleted on disk");
    expect(screen.getByTestId("draft")).toBeTruthy();
    fireEvent.click(screen.getByTestId("file-discard"));
    expect(await screen.findByTestId("file-not-found")).toBeTruthy();
  });

  it("a session stays on its file: its reads have no fallback to a file of that name, and Overwrite stays there", async () => {
    const short = "/Users/me/w/src/a.ts";
    const other = "/Users/me/w/lib/src/a.ts";
    files.set(short, text({ text: "mine\n" }));
    files.set(other, text({ text: "another file\n" }));
    listed.paths = ["lib/src/a.ts"];
    writes.fn.mockResolvedValue({ path: short, size: 5, modifiedAtMs: 300, conflict: false, notFound: false });
    openTab("src/a.ts", { project: "p1" });
    await editing();
    type("mine too\n");
    files.delete(short);
    await refresh();
    expect((await screen.findByTestId("file-conflict")).textContent).toContain("Deleted on disk");
    expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe(short);
    expect(listed.calls).toEqual([]);
    expect(reads).not.toContain(other);
    fireEvent.click(screen.getByTestId("file-overwrite"));
    await waitFor(() => {
      expect(screen.queryByTestId("file-conflict")).toBeNull();
    });
    expect(writes.fn.mock.lastCall?.[1]).toBe(short);
    // Editing over, the tab is still on the file just saved, gone or not.
    files.set(short, text({ text: "mine too\n", size: 5, modifiedAtMs: 300 }));
    fireEvent.click(await pencil());
    await waitFor(() => {
      expect(screen.queryByTestId("draft")).toBeNull();
    });
    files.delete(short);
    await refresh();
    expect(screen.getByTestId("file-tab").getAttribute("data-path")).toBe(short);
    expect(listed.calls).toEqual([]);
  });

  it("the band's actions wait for a write that is out", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    type("A=2\n");
    files.set(ENV, text({ text: "theirs\n", size: 7, modifiedAtMs: 150 }));
    await refresh();
    let finish: (v: unknown) => void = () => undefined;
    writes.fn.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    // The conflict band comes with the re-read, which refresh() can return before.
    fireEvent.click(await screen.findByTestId("file-overwrite"));
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>("file-reload").disabled).toBe(true);
    });
    expect(screen.getByTestId<HTMLButtonElement>("file-overwrite").disabled).toBe(true);
    await act(async () => {
      finish({ path: ENV, size: 4, modifiedAtMs: 300, conflict: false, notFound: false });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("file-conflict")).toBeNull();
    });
  });

  it("while clean, a re-read still follows the file", async () => {
    files.set(ENV, text());
    openTab();
    await editing();
    files.set(ENV, text({ text: "theirs\n", size: 7, modifiedAtMs: 150 }));
    await refresh();
    await waitFor(() => {
      expect(screen.getByTestId("code-file").textContent).toBe("theirs\n");
    });
    expect(screen.queryByTestId("file-conflict")).toBeNull();
    expect(status()).toBe("Editing");
  });

  it("a refused save shows the daemon's words and keeps the draft", async () => {
    files.set(ENV, text());
    writes.fn.mockRejectedValue(new Error("the file is read-only: make it writable first"));
    openTab();
    await editing();
    type("A=2\n");
    fireEvent.click(screen.getByTestId("file-save"));
    expect((await screen.findByTestId("file-edit-failed")).textContent).toBe("Could not save: the file is read-only: make it writable first");
    expect(status()).toBe("Unsaved");
  });

  it("a rendered kind moves to Source for this tab only; the switch goes while dirty and comes back; Rendered leaves edit mode", async () => {
    const md = "/Users/me/w/README.md";
    files.set(md, text({ text: "# Title\n" }));
    openTab(md);
    expect(await screen.findByTestId("file-markdown")).toBeTruthy();
    await editing();
    expect(screen.getByTestId("file-tab").getAttribute("data-mode")).toBe("source");
    expect(screen.queryByTestId("file-markdown")).toBeNull();
    expect(useCodeViewStore.getState().preview.markdown).toBeUndefined();
    expect(screen.getByTestId("file-mode")).toBeTruthy();
    // Source is where it already is: nothing leaves edit mode.
    fireEvent.click(screen.getByTestId("file-mode-source"));
    expect(status()).toBe("Editing");
    type("# Other\n");
    expect(screen.queryByTestId("file-mode")).toBeNull();
    type("# Title\n");
    fireEvent.click(screen.getByTestId("file-mode-rendered"));
    expect(await screen.findByTestId("file-markdown")).toBeTruthy();
    expect(screen.queryByTestId("file-edit-status")).toBeNull();
  });

  it("a tab can open with its editor on, and the pencil can still turn it off", async () => {
    files.set(ENV, text());
    openTab(".env", { edit: true });
    await screen.findByTestId("draft");
    fireEvent.click(await pencil());
    await waitFor(() => {
      expect(screen.queryByTestId("draft")).toBeNull();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("draft")).toBeNull();
  });

  it("opening with its editor on does nothing for a file it cannot edit", async () => {
    files.set(ENV, text({ lossless: false }));
    openTab(".env", { edit: true });
    await screen.findByTestId("code-file");
    expect(screen.queryByTestId("draft")).toBeNull();
    expect(screen.queryByTestId("file-edit")).toBeNull();
  });

  it("the draft's editor stays across a remount of the tab, with its version", async () => {
    files.set(ENV, text());
    const first = openTab();
    await editing();
    type("A=2\n");
    first.unmount();
    files.set(ENV, text({ text: "theirs\n", size: 7, modifiedAtMs: 150 }));
    openTab();
    expect(screen.getByTestId("code-file").getAttribute("data-editing")).toBe("");
    expect(status()).toBe("Unsaved");
    expect((await screen.findByTestId("file-conflict")).textContent).toContain("Changed on disk");
  });
});

describe("a file opened before its thread had a checkout", () => {
  const MAIN = "/src/web";
  const WT = "/w/web-cf-x";
  const FILE = `${MAIN}/src/app.ts`;
  const MOVED = `${WT}/src/app.ts`;
  const KEY = "thread:s";
  const body = (o: Partial<FileReadView> = {}): Partial<FileReadView> => ({ text: "A=1\n", binary: false, lossless: true, mime: "text/plain", size: 4, modifiedAtMs: 100, ...o });
  const setup = (phase: "running" | "failed" | "done") => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });
  const put = (o: Partial<ThreadView>) => {
    useThreadsStore.setState({ byId: { s: { id: "s", name: "t", projectId: "web", projectIds: ["web"], worktreePath: "", checkoutPaths: [], createdWorktree: false, branch: "", workspaceId: "", setup: setup("running"), ...o } as ThreadView }, order: ["s"] });
  };
  const landed = { worktreePath: WT, createdWorktree: true, branch: "cf/x", checkoutPaths: [{ projectId: "web", path: WT }], setup: setup("done") };
  const openHeld = async () => {
    put({});
    openFileInPanel(KEY, { project: "web", base: MAIN, path: FILE });
    await layoutSettled();
    return active();
  };
  /** The thread's File tab in front, as the layout has it. */
  const active = () => {
    const p = tabPlace(KEY);
    const tab = shownTab(p);
    const target = tab ? fileOfTab(tab) : null;
    if (!target) throw new Error("no file tab");
    return target;
  };
  const show = (target: FileTarget) =>
    render(
      <PanelKeyContext.Provider value={KEY}>
        <FileTab target={target} />
      </PanelKeyContext.Provider>,
    );

  beforeEach(async () => {
    await resetFakeLayout(threadSeed("s"));
    useProjectsStore.setState({ byId: { web: { id: "web", name: "web", path: MAIN, git: true, githubSlug: "", remotes: [], worktrees: [{ path: MAIN, branch: "main", head: "a", isMain: true }] } } as never, order: ["web"] });
    files.set(FILE, body());
  });

  afterEach(async () => {
    await layoutSettled();
    useThreadsStore.setState({ byId: {}, order: [] });
  });

  it("opens held, read-only and says so: nothing can reach the main checkout", async () => {
    const target = await openHeld();
    expect(target.heldFor).toBe("s");
    show(target);
    await screen.findByTestId("code-file");
    expect(screen.queryByTestId("file-edit")).toBeNull();
    expect(screen.getByTestId("file-held").textContent).toBe("Read-only until this thread's worktree is ready");
  });

  it("a thread asking for an edit does not open an editor on it either", async () => {
    put({});
    openFileInPanel(KEY, { project: "web", base: MAIN, path: FILE, edit: true });
    await layoutSettled();
    show(active());
    await screen.findByTestId("code-file");
    expect(useFileEditStore.getState().sessions).toEqual({});
  });

  it("a file outside the project is nothing of the checkout's, and is not held", async () => {
    put({});
    openFileInPanel(KEY, { project: "", base: "/tmp", path: "/tmp/x.md" });
    await layoutSettled();
    expect(active().heldFor).toBeUndefined();
  });

  it("a thread with its worktree opens as usual", async () => {
    put(landed);
    openFileInPanel(KEY, { project: "web", base: WT, path: MOVED });
    await layoutSettled();
    expect(active().heldFor).toBeUndefined();
  });

  it("moves to the worktree when the thread lands, and a save writes there", async () => {
    files.set(MOVED, body());
    const target = await openHeld();
    const first = show(target);
    await screen.findByTestId("code-file");
    act(() => {
      put(landed);
    });
    await waitFor(() => {
      expect(active().base).toBe(WT);
    });
    expect(active()).toMatchObject({ project: "web", base: WT, path: MOVED });
    expect(active().heldFor).toBeUndefined();
    first.unmount();

    writes.fn.mockResolvedValue({ path: MOVED, size: 5, modifiedAtMs: 200, conflict: false, notFound: false });
    show(active());
    fireEvent.click(await screen.findByTestId("file-edit"));
    await screen.findByTestId("file-edit-status");
    draft.text = "A=22\n";
    fireEvent.change(await screen.findByTestId("draft"), { target: { value: "A=22\n" } });
    fireEvent.click(screen.getByTestId("file-save"));
    await waitFor(() => {
      expect(writes.fn).toHaveBeenCalledTimes(1);
    });
    expect(writes.fn.mock.calls[0]?.slice(0, 2)).toEqual([WT, MOVED]);
  });

  it("stays read-only for good when the file is not in the worktree", async () => {
    const target = await openHeld();
    show(target);
    await screen.findByTestId("code-file");
    act(() => {
      put(landed);
    });
    await waitFor(() => {
      expect(screen.getByTestId("file-held").textContent).toBe("Read-only: this is the project's own checkout, and the file is not in this thread's worktree");
    });
    expect(screen.queryByTestId("file-edit")).toBeNull();
    expect(active().base).toBe(MAIN);
    expect(writes.fn).not.toHaveBeenCalled();
  });

  it("is the thread's own file when the thread runs right there", async () => {
    const target = await openHeld();
    show(target);
    await screen.findByTestId("code-file");
    act(() => {
      put({ worktreePath: MAIN, checkoutPaths: [{ projectId: "web", path: MAIN }], setup: setup("done") });
    });
    await waitFor(() => {
      expect(active().heldFor).toBeUndefined();
    });
    expect(active().base).toBe(MAIN);
  });

  it("still waits on a setup that failed before it had a worktree", async () => {
    const target = await openHeld();
    act(() => {
      put({ setup: setup("failed") });
    });
    show(target);
    await screen.findByTestId("code-file");
    expect(screen.getByTestId("file-held").textContent).toBe("Read-only until this thread's worktree is ready");
  });
});

describe("find in the file", () => {
  const target = (path: string): FileTarget => ({ project: "", base: "/Users/me/w", path });
  const keyOf = (path: string) => fileEditKey("thread:a", fileTab(target(path)).id);
  const openTab = (path: string) =>
    render(
      <PanelKeyContext value="thread:a">
        <FileTab target={target(path)} />
      </PanelKeyContext>,
    );
  const loaded = () =>
    waitFor(() => {
      expect(screen.getByTestId("file-tab").getAttribute("data-loading")).toBeNull();
    });
  const count = () => screen.getByTestId("file-find-count").textContent;

  afterEach(() => {
    useFileFindStore.setState({ byTab: {} });
  });

  it("a text file can search: cmd+F's bar sits under the header and counts the file's matches", async () => {
    files.set("/Users/me/w/a.ts", { text: "const a = 1;\nconst b = a;\n", lossless: true, binary: false, mime: "text/typescript", size: 26 });
    openTab("a.ts");
    await loaded();
    expect(canSearchFile()).toBe(true);
    expect(screen.queryByTestId("file-find")).toBeNull();
    act(() => {
      openFileFind(keyOf("a.ts"));
    });
    const input = await screen.findByTestId("file-find-input");
    expect(document.activeElement).toBe(input);
    // The bar comes right after the header's rows, before the bands and the code.
    expect(screen.getByTestId("file-find").previousElementSibling?.querySelector('[data-testid="file-edit"]')).not.toBeNull();
    fireEvent.change(input, { target: { value: "const" } });
    await waitFor(() => {
      expect(count()).toBe("1 of 2");
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(count()).toBe("2 of 2");
    });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => {
      expect(count()).toBe("1 of 2");
    });
  });

  it("the bar, its query and its match stay across the pencil, and the count follows the draft", async () => {
    files.set("/Users/me/w/.env", { text: "A=1\nB=2\n", lossless: true, binary: false, mime: "text/plain", size: 8, modifiedAtMs: 1 });
    openTab(".env");
    await loaded();
    act(() => {
      openFileFind(keyOf(".env"));
    });
    fireEvent.change(await screen.findByTestId("file-find-input"), { target: { value: "=" } });
    fireEvent.keyDown(screen.getByTestId("file-find-input"), { key: "Enter" });
    await waitFor(() => {
      expect(count()).toBe("2 of 2");
    });
    fireEvent.click(screen.getByTestId("file-edit"));
    await screen.findByTestId("draft");
    expect(screen.getByTestId("file-find-input")).toHaveProperty("value", "=");
    expect(count()).toBe("2 of 2");
    draft.text = "A=1\nB=2\nC=3\n";
    fireEvent.change(screen.getByTestId("draft"), { target: { value: draft.text } });
    await waitFor(() => {
      expect(count()).toBe("2 of 3");
    });
  });

  it("Escape closes the bar and gives the keyboard back to the code", async () => {
    files.set("/Users/me/w/a.ts", { text: "x\n", lossless: true, binary: false, mime: "text/typescript", size: 2 });
    openTab("a.ts");
    await loaded();
    act(() => {
      openFileFind(keyOf("a.ts"));
    });
    fireEvent.keyDown(await screen.findByTestId("file-find-input"), { key: "Escape" });
    expect(screen.queryByTestId("file-find")).toBeNull();
    expect(useFileFindStore.getState().byTab[keyOf("a.ts")]).toBeUndefined();
    expect(document.activeElement).toBe(screen.getByTestId("file-code"));
  });

  it.each<[string, string, Partial<FileReadView>]>([
    ["an HTML page shown rendered (a frame of its own)", "/Users/me/w/page.html", { text: "<p>hi</p>", lossless: true, binary: false, mime: "text/html", size: 9 }],
    ["an image", "/Users/me/w/logo.png", { mime: "image/png", image: new Uint8Array([1]), binary: true, size: 1 }],
    ["a binary", "/Users/me/w/tool", { binary: true, text: null, size: 9 }],
  ])("nothing to search in %s: no bar, and cmd+F stays the thread's", async (_name, path, f) => {
    files.set(path, f);
    openTab(path.slice("/Users/me/w/".length));
    await loaded();
    expect(canSearchFile()).toBe(false);
    act(() => {
      openFileFind(keyOf(path.slice("/Users/me/w/".length)));
    });
    expect(screen.queryByTestId("file-find")).toBeNull();
  });
});

describe("previews", () => {
  const W = "/Users/me/w";
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"/>\n';
  const tab = () => screen.getByTestId("file-tab");
  const meta = () => screen.getByTestId("file-meta").textContent;
  const loaded = () =>
    waitFor(() => {
      expect(tab().getAttribute("data-loading")).toBeNull();
    });
  const decode = (w: number, h: number) => {
    const img = screen.getByTestId("file-image").querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: w });
    Object.defineProperty(img, "naturalHeight", { value: h });
    fireEvent.load(img);
  };

  it("an SVG: Image first, its size once it decodes, no wrap and no pencil; Source is its text; the choice is remembered for SVGs only", async () => {
    files.set(`${W}/logo.svg`, { text: SVG, lossless: true, binary: false, mime: "image/svg+xml", size: 1024, image: new Uint8Array([0x3c]) });
    files.set(`${W}/b.svg`, { text: SVG, lossless: true, binary: false, mime: "image/svg+xml", size: 1024, image: new Uint8Array([0x3c]) });
    const first = open("logo.svg");
    await screen.findByTestId("file-image");
    expect(tab().dataset.kind).toBe("svg");
    expect(tab().dataset.mode).toBe("image");
    expect(within(screen.getByTestId("file-mode")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Image", "Source"]);
    expect(meta()).toBe("1 KB · SVG");
    decode(512, 512);
    expect(meta()).toBe("512 × 512 · 1 KB · SVG");
    expect(screen.queryByTestId("file-wrap")).toBeNull();
    expect(screen.queryByTestId("file-edit")).toBeNull();

    fireEvent.click(screen.getByTestId("file-mode-source"));
    expect(screen.getByTestId("code-file").textContent).toBe(SVG);
    expect(screen.getByTestId("code-file").dataset.lang).toBe("xml");
    expect(meta()).toBe("1 line · 1 KB · SVG");
    expect(screen.getByTestId("file-wrap")).toBeTruthy();
    expect(screen.queryByTestId("file-edit")).toBeNull();
    expect(useCodeViewStore.getState().preview).toEqual({ svg: "source" });
    first.unmount();

    open("b.svg");
    await screen.findByTestId("code-file");
    fireEvent.click(screen.getByTestId("file-mode-image"));
    expect(await screen.findByTestId("file-image")).toBeTruthy();
    // Back in Image: the meta waits for this picture's size, not the last mode's.
    expect(meta()).toBe("1 KB · SVG");
  });

  it("a truncated SVG is too large to show as a picture; Source shows what came back", async () => {
    files.set(`${W}/huge.svg`, { text: "<svg>", binary: false, truncated: true, mime: "image/svg+xml", size: 4 * MiB, image: new Uint8Array([0x3c]) });
    open("huge.svg");
    expect((await screen.findByTestId("file-svg-too-large")).textContent).toContain("Image · 4.0 MB · too large to show");
    fireEvent.click(screen.getByTestId("file-mode-source"));
    expect(screen.getByTestId("code-file").textContent).toBe("<svg>");
    expect(screen.getByTestId("file-truncated")).toBeTruthy();
  });

  it("Copy contents sits after Copy path, copies the text and shows a check for a moment", async () => {
    files.set(`${W}/a.ts`, { text: "export const a = 1;\n", binary: false, mime: "text/typescript", size: 20 });
    open("a.ts");
    await screen.findByTestId("code-file");
    const actions = [...screen.getByTestId("file-header").querySelectorAll("button[data-testid]")].map((b) => b.getAttribute("data-testid"));
    expect(actions.indexOf("file-copy-contents")).toBe(actions.indexOf("file-copy-path") + 1);
    const button = screen.getByTestId("file-copy-contents");
    expect(button.getAttribute("aria-label")).toBe("Copy contents");
    fireEvent.click(button);
    await waitFor(() => {
      expect(button.getAttribute("aria-label")).toBe("Copied");
    });
    expect(copied.fn).toHaveBeenCalledWith("export const a = 1;\n");
    expect(screen.getByTestId("file-copy-path").getAttribute("aria-label")).toBe("Copy path");
  });

  it("Copy contents copies the text from a preview too (rendered markdown, an SVG's picture)", async () => {
    files.set(`${W}/README.md`, { text: "# Title\n", binary: false, mime: "text/markdown", size: 8 });
    const first = open("README.md");
    await screen.findByTestId("file-markdown");
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenCalledWith("# Title\n");
    });
    first.unmount();
    files.set(`${W}/logo.svg`, { text: SVG, binary: false, mime: "image/svg+xml", size: 64, image: new Uint8Array([0x3c]) });
    open("logo.svg");
    await screen.findByTestId("file-image");
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith(SVG);
    });
  });

  it("a CSV's Table copies tab-separated text, its Source the file; a JSON's Tree copies the file; a cut JSON is code", async () => {
    const CSV = 'id,label\n1,"a, b"\n';
    files.set(`${W}/t.csv`, { text: CSV, lossless: true, binary: false, mime: "text/csv", size: CSV.length });
    const first = open("t.csv");
    await screen.findByTestId("file-table");
    expect(within(screen.getByTestId("file-mode")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Table", "Source"]);
    expect(meta()).toBe("1 row · 2 columns · 18 B · CSV");
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith("id\tlabel\n1\ta, b\n");
    });
    fireEvent.click(screen.getByTestId("file-mode-source"));
    fireEvent.click(await screen.findByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith(CSV);
    });
    first.unmount();
    files.set(`${W}/p.json`, { text: '{"a":1}\n', lossless: true, binary: false, mime: "application/json", size: 8 });
    const second = open("p.json");
    await screen.findByTestId("file-json-tree");
    expect(meta()).toBe("1 key · 8 B · JSON");
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith('{"a":1}\n');
    });
    second.unmount();
    files.set(`${W}/big.json`, { text: '{"a": [1,', binary: false, truncated: true, mime: "application/json", size: 4 * MiB });
    open("big.json");
    await screen.findByTestId("code-file");
    expect(tab().dataset.kind).toBeUndefined();
    expect(screen.getByTestId("file-truncated")).toBeTruthy();
  });

  it.each<[string, string, Partial<FileReadView>]>([
    ["an image", "logo.png", { mime: "image/png", image: new Uint8Array([1]), size: 1 }],
    ["a PDF", "spec.pdf", { mime: "application/pdf", pdf: new Uint8Array([1]), size: 1 }],
    ["a binary", "tool", { size: 9 }],
    ["a truncated read", "big.txt", { text: "line\n", binary: false, truncated: true, mime: "text/plain", size: 4 * MiB }],
    ["a folder", "docs", { isDir: true }],
  ])("no Copy contents for %s", async (_name, path, f) => {
    files.set(`${W}/${path}`, f);
    open(path);
    await loaded();
    expect(screen.getByTestId("file-copy-path")).toBeTruthy();
    expect(screen.queryByTestId("file-copy-contents")).toBeNull();
  });

  it("a .log is read from its end: Rendered | Source, the tail notice, its lines in the meta, and no Copy contents for the cut read", async () => {
    const text = "09:14:02 INFO one\n09:14:03 \u001b[31mERROR\u001b[0m two\n";
    files.set(`${W}/logs/server.log`, { text, lossless: true, binary: false, mime: "text/plain; charset=utf-8", size: 38 * MiB, truncatedStart: true, offset: 38 * MiB - 40 });
    open("logs/server.log");
    await screen.findByTestId("file-log");
    expect(tails).toContain(`${W}/logs/server.log`);
    expect(reads).not.toContain(`${W}/logs/server.log`);
    expect(tab().dataset.kind).toBe("log");
    expect(within(screen.getByTestId("file-mode")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Rendered", "Source"]);
    expect(meta()).toBe("2 lines · 38.0 MB · Log");
    expect(screen.getByTestId("file-truncated-start").textContent).toBe("Showing the last 1 MiB of 38.0 MB");
    expect(screen.queryByTestId("file-truncated")).toBeNull();
    expect(screen.queryByTestId("file-copy-contents")).toBeNull();
    expect(screen.getByTestId("file-wrap")).toBeTruthy();
    // A tail read is not editable (api/files canEdit).
    expect(screen.queryByTestId("file-edit")).toBeNull();
    fireEvent.click(screen.getByTestId("file-mode-source"));
    expect(screen.getByTestId("code-file").textContent).toBe(text);
    expect(screen.getByTestId("file-truncated-start")).toBeTruthy();
  });

  it("a whole .log: Copy contents copies what Rendered shows (no escapes), Source the text as written", async () => {
    const text = "\u001b[32mok\u001b[0m\n 10%\r100%\n";
    files.set(`${W}/run.log`, { text, lossless: true, binary: false, mime: "text/plain", size: text.length });
    open("run.log");
    await screen.findByTestId("file-log");
    expect(screen.queryByTestId("file-truncated-start")).toBeNull();
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith("ok\n100%\n");
    });
    fireEvent.click(screen.getByTestId("file-mode-source"));
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith(text);
    });
  });

  it("a .txt with escape sequences is terminal output, read whole; one without stays the code view", async () => {
    files.set(`${W}/run.txt`, { text: "\u001b[1mPASS\u001b[0m all\n", lossless: true, binary: false, mime: "text/plain", size: 20 });
    files.set(`${W}/notes.txt`, { text: "ERROR: not a log\n", lossless: true, binary: false, mime: "text/plain", size: 17 });
    const first = open("run.txt");
    await screen.findByTestId("file-log");
    expect(tab().dataset.kind).toBe("ansi");
    expect(reads).toContain(`${W}/run.txt`);
    expect(meta()).toBe("1 line · 20 B · Terminal output");
    first.unmount();
    open("notes.txt");
    await screen.findByTestId("code-file");
    expect(tab().dataset.kind).toBeUndefined();
    expect(screen.queryByTestId("file-mode")).toBeNull();
    expect(meta()).toBe("1 line · 17 B · Plain text");
    expect(tails).not.toContain(`${W}/notes.txt`);
  });

  it("no Copy contents for a file that is not there", async () => {
    open("nope.txt");
    await screen.findByTestId("file-not-found");
    expect(screen.queryByTestId("file-copy-contents")).toBeNull();
  });

  it("while editing, Copy contents copies the draft", async () => {
    files.set(`${W}/.env`, { text: "A=1\n", lossless: true, binary: false, mime: "text/plain", size: 4, modifiedAtMs: 100 });
    render(
      <PanelKeyContext value="thread:a">
        <FileTab target={{ project: "", base: W, path: ".env" }} />
      </PanelKeyContext>,
    );
    fireEvent.click(await screen.findByTestId("file-edit"));
    const box = await screen.findByTestId("draft");
    draft.text = "A=2\n";
    fireEvent.change(box, { target: { value: "A=2\n" } });
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenCalledWith("A=2\n");
    });
  });

  it("a kind's own controls, copy, wrap and no pencil: in its preview mode only, Source copies the text", async () => {
    files.set(`${W}/t.grid`, { text: "a,b\n1,2\n", lossless: true, binary: false, mime: "text/plain", size: 8 });
    open("t.grid");
    await screen.findByTestId("grid-body");
    expect(within(screen.getByTestId("file-header-bar")).getByTestId("grid-controls").textContent).toBe("grid");
    expect(meta()).toBe("8 B · Grid");
    expect(screen.getByTestId("file-wrap")).toBeTruthy();
    expect(screen.queryByTestId("file-edit")).toBeNull();
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenCalledWith("a\tb\n1\t2\n");
    });

    fireEvent.click(screen.getByTestId("file-mode-source"));
    expect(screen.queryByTestId("grid-controls")).toBeNull();
    expect(screen.queryByTestId("file-edit")).toBeNull();
    fireEvent.click(screen.getByTestId("file-copy-contents"));
    await waitFor(() => {
      expect(copied.fn).toHaveBeenLastCalledWith("a,b\n1,2\n");
    });
  });

  it("a remembered mode the switch does not have opens the kind's first", async () => {
    useCodeViewStore.setState({ preview: { markdown: "raw" } });
    files.set(`${W}/README.md`, { text: "# Title\n", binary: false, mime: "text/markdown", size: 8 });
    open("README.md");
    await screen.findByTestId("file-markdown");
    expect(tab().dataset.mode).toBe("rendered");
  });
});
