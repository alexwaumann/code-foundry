import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAttachment = vi.fn();
vi.mock("@/api/threads", () => ({ readAttachment: (...a: unknown[]) => readAttachment(...a) as unknown }));
vi.mock("@/lib/pdf", () => ({ pdfSummary: vi.fn() }));

const MiB = 1024 * 1024;

// A Blob whose size is its data's length in MiB: a few bytes stand for a big file.
class BigBlob {
  readonly size: number;
  readonly type: string;
  constructor(parts: Uint8Array[], opts: { type: string }) {
    this.size = (parts[0]?.length ?? 0) * MiB;
    this.type = opts.type;
  }
}

/** Files of `mib` MiB at any path, each with its own object URL. */
function serve(mib: number) {
  readAttachment.mockImplementation(() => Promise.resolve({ data: new Uint8Array(mib), mimeType: "image/png" }));
}

let n = 0;
const revoked: string[] = [];

beforeEach(() => {
  vi.resetModules();
  readAttachment.mockReset();
  vi.stubGlobal("Blob", BigBlob);
  n = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:${String(++n)}`);
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("attachment cache budget", () => {
  it("drops the least recently used files past the budget and revokes their URLs", async () => {
    const { loadAttachment, FILE_BUDGET } = await import("./attachments");
    serve(100);
    expect(FILE_BUDGET).toBe(256 * MiB);
    await loadAttachment("/a"); // blob:1
    await loadAttachment("/b"); // blob:2
    await loadAttachment("/a"); // a hit: /a is now the most recent
    await loadAttachment("/c"); // 300 MiB: /b goes
    expect(revoked).toEqual(["blob:2"]);
    expect(readAttachment).toHaveBeenCalledTimes(3);
    // /b comes back with a fresh fetch and URL; /a (older now) goes.
    expect((await loadAttachment("/b"))?.url).toBe("blob:4");
    expect(revoked).toEqual(["blob:2", "blob:1"]);
  });

  it("never drops a file a mounted component shows; drops it once unmounted and over budget", async () => {
    const { loadAttachment, useAttachment } = await import("./attachments");
    serve(200);
    function Img({ path }: { path: string }) {
      const { url } = useAttachment(path);
      return <span data-testid="url">{url ?? ""}</span>;
    }
    const view = render(<Img path="/shown" />);
    await act(async () => {
      await loadAttachment("/shown");
    });
    expect(view.getByTestId("url").textContent).toBe("blob:1");
    // 400 MiB, but /shown is pinned and /other is the one just asked for: both stay for now.
    expect((await loadAttachment("/other"))?.url).toBe("blob:2");
    expect(revoked).toEqual([]);
    // The next load makes room: /other (unpinned) goes, /shown stays on screen.
    await loadAttachment("/third");
    expect(revoked).toEqual(["blob:2"]);
    expect(view.getByTestId("url").textContent).toBe("blob:1");
    // Unmounted, /shown counts as just used: /third (older) goes first.
    view.unmount();
    expect(revoked).toEqual(["blob:2", "blob:3"]);
    await loadAttachment("/next");
    expect(revoked).toEqual(["blob:2", "blob:3", "blob:1"]);
  });
});
