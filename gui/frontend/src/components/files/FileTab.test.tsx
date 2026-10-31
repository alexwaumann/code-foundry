import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FileReadView } from "@/api/files";
import { FileTab } from "./FileTab";

// readFile answers from `files`; pdf.js does not run in jsdom (no canvas), so lib/pdf is a
// fake that opens any blob as 3 pages and never draws.
const files = vi.hoisted(() => new Map<string, Partial<FileReadView>>());
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  readFile: (base: string, path: string) => {
    const abs = path.startsWith("/") ? path : `${base}/${path}`;
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
  loadPdf.mockClear();
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
});
