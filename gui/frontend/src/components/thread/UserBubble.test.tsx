import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UserBubble } from "./UserBubble";

// readAttachment serves a PDF (an empty type, so the store types it from the ".pdf" path)
// and an image; pdf.js does not run in jsdom, so lib/pdf is a fake with 2 pages.
const readAttachment = vi.hoisted(() =>
  vi.fn((path: string) => Promise.resolve(path.endsWith(".pdf") ? { data: new Uint8Array(1536), mimeType: "" } : { data: new Uint8Array([1]), mimeType: "image/png" })),
);
vi.mock("@/api/threads", () => ({ readAttachment }));
const pdfSummary = vi.hoisted(() => vi.fn<(file: Blob) => Promise<{ pages: number; thumb: string }>>(() => Promise.resolve({ pages: 2, thumb: "data:image/png;base64,AA==" })));
const loadPdf = vi.hoisted(() =>
  vi.fn<(file: Blob) => Promise<unknown>>(() => Promise.resolve({ pages: 2, pageSize: () => Promise.resolve({ width: 300, height: 200 }), renderPage: () => Promise.reject(new Error("no canvas")), destroy: () => undefined })),
);
vi.mock("@/lib/pdf", () => ({ pdfSummary, loadPdf }));

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:x");
  // PdfPages draws a page as it nears the view; nothing intersects in jsdom.
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
});

const chip = (i: string, name: string) => `![${name}](cf-attachment://${i})`;

describe("UserBubble", () => {
  it("a PDF the text refers to is a chip with its pages; one it does not is a PDF tile; the list says files", async () => {
    const atts = ["/att/0a.pdf", "/att/1b.pdf", "/att/2c.png"];
    render(<UserBubble text="(projected)" composerText={`Summarize ${chip("0", "spec.pdf")} and ${chip("2", "shot.png")}`} attachments={atts} createdAtMs={null} />);
    const pdf = await screen.findByRole("button", { name: "PDF spec.pdf, 2 pages" });
    expect(pdf.getAttribute("data-tag-kind")).toBe("pdf");
    expect(pdf.textContent).toBe("spec.pdf2 pages");
    expect(pdf.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(screen.getByRole("button", { name: "Image shot.png" }).getAttribute("data-tag-kind")).toBe("image");
    // Only the unreferenced PDF is a tile.
    const list = screen.getByRole("list", { name: "Attached files" });
    const tiles = list.querySelectorAll('[data-testid="thread-attachment"]');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.getAttribute("data-kind")).toBe("pdf");
    expect(tiles[0]?.textContent).toBe("PDF");
    await screen.findByRole("button", { name: "Preview 1b.pdf, PDF, 2 pages, 2 KB" });
    // The blob is typed from the path, so pdf.js and the viewer read it as a PDF.
    expect(pdfSummary.mock.calls.map(([f]) => f.type)).toEqual(["application/pdf", "application/pdf"]);
  });

  it("a click on the chip opens the lightbox: name, size and pages, and the page stack", async () => {
    render(<UserBubble text="(projected)" composerText={`See ${chip("0", "spec.pdf")}`} attachments={["/att/0a.pdf"]} createdAtMs={null} />);
    expect(screen.queryByRole("list")).toBeNull();
    const pdf = await screen.findByRole("button", { name: "PDF spec.pdf, 2 pages" });
    act(() => {
      fireEvent.click(pdf);
    });
    const dialog = await screen.findByTestId("thread-attachment-preview");
    expect(dialog.getAttribute("data-kind")).toBe("pdf");
    expect(screen.getByTestId("thread-attachment-preview-name").textContent).toBe("spec.pdf");
    expect(screen.getByTestId("thread-attachment-preview-size").textContent).toBe("2 KB · 2 pages");
    await waitFor(() => {
      expect(dialog.querySelectorAll('[data-testid="pdf-page"]')).toHaveLength(2);
    });
    expect(loadPdf.mock.calls.at(-1)?.[0].type).toBe("application/pdf");
  });

  it("the page count in a staged name wins over pdf.js's, also when pdf.js cannot read the file", async () => {
    pdfSummary.mockImplementation((f: Blob) => (f.size === 1536 ? Promise.reject(new Error("unreadable")) : Promise.resolve({ pages: 2, thumb: "data:image/png;base64,AA==" })));
    render(<UserBubble text="(projected)" composerText={`See ${chip("0", "long.pdf")}`} attachments={["/att/3c-7p.pdf", "/att/4d-~9p.pdf"]} createdAtMs={null} />);
    const pdf = await screen.findByRole("button", { name: "PDF long.pdf, 7 pages" });
    expect(pdf.getAttribute("data-pages")).toBe("7");
    // An estimate in the name is not shown as a count.
    const tile = screen.getByRole("list", { name: "Attached files" }).querySelector('[data-testid="thread-attachment"]');
    await screen.findByRole("button", { name: "Preview 4d-~9p.pdf, PDF, 2 KB" });
    expect(tile?.hasAttribute("data-pages")).toBe(false);
    pdfSummary.mockImplementation(() => Promise.resolve({ pages: 2, thumb: "data:image/png;base64,AA==" }));
  });

  it("a PDF the daemon no longer has is a dashed chip that does not open", async () => {
    readAttachment.mockImplementationOnce(() => Promise.resolve(null as never));
    render(<UserBubble text="" composerText={`See ${chip("0", "old.pdf")}`} attachments={["/att/gone.pdf"]} createdAtMs={null} />);
    const pdf = await screen.findByRole("button", { name: "PDF old.pdf" });
    await waitFor(() => {
      expect(pdf.className).toContain("border-dashed");
    });
    expect((pdf as HTMLButtonElement).disabled).toBe(true);
  });
});
