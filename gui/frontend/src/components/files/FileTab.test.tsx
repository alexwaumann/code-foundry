import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import { useCodeViewStore } from "@/stores/codeView";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { FileTab } from "./FileTab";

// readFile answers from `files`; pdf.js does not run in jsdom (no canvas), so lib/pdf is a
// fake that opens any blob as 3 pages and never draws.
const files = vi.hoisted(() => new Map<string, Partial<FileReadView>>());
const reads = vi.hoisted(() => [] as string[]);
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  readFile: (base: string, path: string) => {
    const abs = path.startsWith("/") ? path : `${base}/${path}`;
    reads.push(abs);
    const f = files.get(abs) ?? { notFound: true };
    return Promise.resolve({ path: abs, size: 0, truncated: false, binary: true, mime: "", modifiedAtMs: null, notFound: false, isDir: false, text: null, image: null, pdf: null, ...f });
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
vi.mock("@/components/code/CodeFile", () => ({
  CodeFile: ({ contents, selectedLines }: { contents: string; selectedLines?: { start: number } | null }) => (
    <pre data-testid="code-file" data-selected={selectedLines?.start}>
      {contents}
    </pre>
  ),
}));
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
  loadPdf.mockClear();
  useCodeViewStore.setState({ diffStyle: "unified", wrap: false, preview: { markdown: "rendered", html: "rendered" } });
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
