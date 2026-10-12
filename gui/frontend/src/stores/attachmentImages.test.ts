import { beforeEach, describe, expect, it, vi } from "vitest";

const readAttachment = vi.fn();
vi.mock("@/api/session", () => ({ readAttachment: (...a: unknown[]) => readAttachment(...a) as unknown }));

describe("loadAttachmentUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    readAttachment.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:x");
  });

  it("fetches a path once; a gone image is remembered as null", async () => {
    const { loadAttachmentUrl } = await import("./attachmentImages");
    readAttachment.mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "image/png" }).mockResolvedValueOnce(null);
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(await loadAttachmentUrl("/att/gone.png")).toBeNull();
    expect(await loadAttachmentUrl("/att/gone.png")).toBeNull();
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch (daemon down) is asked again next time", async () => {
    const { loadAttachmentUrl } = await import("./attachmentImages");
    readAttachment.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ data: new Uint8Array([1]), mimeType: "image/png" });
    expect(await loadAttachmentUrl("/att/a.png")).toBeNull();
    expect(await loadAttachmentUrl("/att/a.png")).toBe("blob:x");
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });
});
