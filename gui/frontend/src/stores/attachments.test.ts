import { beforeEach, describe, expect, it, vi } from "vitest";

const readAttachment = vi.fn();
vi.mock("@/api/threads", () => ({ readAttachment: (...a: unknown[]) => readAttachment(...a) as unknown }));
const pdfSummary = vi.fn();
vi.mock("@/lib/pdf", () => ({ pdfSummary: (...a: unknown[]) => pdfSummary(...a) as unknown }));

describe("attachments", () => {
  beforeEach(() => {
    vi.resetModules();
    readAttachment.mockReset();
    pdfSummary.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:x");
  });

  it("fetches a path once; a gone image is remembered as null", async () => {
    const { loadAttachmentUrl } = await import("./attachments");
    readAttachment.mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "image/png" }).mockResolvedValueOnce(null);
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(await loadAttachmentUrl("/att/gone.png")).toBeNull();
    expect(await loadAttachmentUrl("/att/gone.png")).toBeNull();
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch (daemon down) is asked again next time", async () => {
    const { loadAttachmentUrl } = await import("./attachments");
    readAttachment.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "image/png" });
    expect(await loadAttachmentUrl("/att/a.png")).toBeNull();
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("a PDF's blob is application/pdf (the daemon's type, else the path's); its summary is worked out once", async () => {
    const { loadAttachment, loadPdfSummary } = await import("./attachments");
    readAttachment.mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "application/pdf" }).mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "" });
    pdfSummary.mockResolvedValue({ pages: 3, thumb: null });
    expect((await loadAttachment("/att/a.pdf"))?.file.type).toBe("application/pdf");
    expect((await loadAttachment("/att/b.pdf"))?.file.type).toBe("application/pdf");
    expect(await loadPdfSummary("/att/a.pdf")).toEqual({ pages: 3, thumb: null });
    expect(await loadPdfSummary("/att/a.pdf")).toEqual({ pages: 3, thumb: null });
    expect(pdfSummary).toHaveBeenCalledTimes(1);
  });

  it("a PDF summary after a failed fetch is asked again; an unreadable PDF is remembered", async () => {
    const { loadPdfSummary } = await import("./attachments");
    readAttachment.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({ data: new Uint8Array([1]), mimeType: "application/pdf" });
    pdfSummary.mockRejectedValue(new Error("not a PDF"));
    expect(await loadPdfSummary("/att/a.pdf")).toBeNull();
    expect(await loadPdfSummary("/att/a.pdf")).toBeNull();
    expect(await loadPdfSummary("/att/a.pdf")).toBeNull();
    expect(readAttachment).toHaveBeenCalledTimes(2);
    expect(pdfSummary).toHaveBeenCalledTimes(1);
  });
});
