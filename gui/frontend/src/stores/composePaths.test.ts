import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { addAttachmentPaths, getDraft, settlePdf, updateDraft, useComposeStore } from "./compose";

// pdf.js does not run in the test: a PDF's thumbnail never arrives.
vi.mock("@/lib/pdf", () => ({ pdfSummary: vi.fn(() => new Promise(() => undefined)) }));

const MB = 1024 * 1024;

/** What the fake daemon has: source path → staged path, type and size; anything else is refused. */
const daemon = vi.hoisted(() => ({
  files: new Map<string, { staged: string; type: string; size: number }>(),
  refuse: new Map<string, Error>(),
  staged: [] as string[],
}));

vi.mock("@/api/threads", async (orig) => ({
  ...(await orig<typeof import("@/api/threads")>()),
  stageAttachmentPath: (path: string) => {
    const err = daemon.refuse.get(path);
    if (err) return Promise.reject(err);
    const f = daemon.files.get(path);
    if (!f) return Promise.reject(new ConnectError(`attachment "${path}" does not exist`, Code.NotFound));
    daemon.staged.push(path);
    return Promise.resolve(f.staged);
  },
}));
vi.mock("./attachments", () => ({
  loadAttachment: (staged: string) => {
    const f = [...daemon.files.values()].find((x) => x.staged === staged);
    return Promise.resolve(f ? { url: "blob:cache", file: { type: f.type, size: f.size } } : null);
  },
}));

// A Blob stand-in: the store only reads the type and size of what it stages.
class FakeFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  constructor(parts: { size: number }[], name: string, opts: { type: string }) {
    this.name = name;
    this.type = opts.type;
    this.size = parts[0]?.size ?? 0;
  }
}

function put(path: string, staged: string, type: string, size = 1000) {
  daemon.files.set(path, { staged, type, size });
}

beforeEach(() => {
  vi.stubGlobal("File", FakeFile);
  URL.createObjectURL = vi.fn(() => "blob:draft");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  daemon.files.clear();
  daemon.refuse.clear();
  daemon.staged = [];
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

describe("addAttachmentPaths", () => {
  it("stages each path and adds it already staged, named like the source, with a staged PDF's count", async () => {
    put("/Users/me/red square.png", "/h/att/1.png", "image/png");
    put("/Users/me/spec.pdf", "/h/att/2-3p.pdf", "application/pdf");
    const added = await addAttachmentPaths("k", ["/Users/me/red square.png", "/Users/me/spec.pdf"]);
    expect(added.map((a) => [a.file.name, a.kind, a.stagedPath, a.pages])).toEqual([
      ["red square.png", "image", "/h/att/1.png", null],
      ["spec.pdf", "pdf", "/h/att/2-3p.pdf", 3],
    ]);
    expect(getDraft("k").attachments).toHaveLength(2);
    expect(getDraft("k").notice).toBeNull();
  });

  it("an estimated count (~) is no count: pdf.js counts it later", async () => {
    put("/a/x.pdf", "/h/att/3-~4p.pdf", "application/pdf");
    const [a] = await addAttachmentPaths("k", ["/a/x.pdf"]);
    expect(a?.pages).toBeNull();
  });

  it("shows the daemon's refusals by name and adds the rest", async () => {
    put("/a/ok.png", "/h/att/4.png", "image/png");
    daemon.refuse.set("/a/fake.png", new ConnectError('attachment type "text/plain; charset=utf-8" (want image/png, …)', Code.InvalidArgument));
    const added = await addAttachmentPaths("k", ["/a/fake.png", "/a/ok.png", "/a/gone.png"]);
    expect(added.map((a) => a.file.name)).toEqual(["ok.png"]);
    expect(getDraft("k").notice).toBe('fake.png: attachment type "text/plain; charset=utf-8" (want image/png, …) · gone.png: attachment "/a/gone.png" does not exist');
  });

  it("stages no more than the count cap allows", async () => {
    for (let i = 0; i < 12; i++) put(`/a/${String(i)}.png`, `/h/att/${String(i)}.png`, "image/png");
    updateDraft("k", { attachments: [] });
    const added = await addAttachmentPaths("k", Array.from({ length: 12 }, (_, i) => `/a/${String(i)}.png`));
    expect(added).toHaveLength(10);
    expect(daemon.staged).toHaveLength(10);
    expect(getDraft("k").notice).toBe("At most 10 attachments per message; 2 not attached");
  });

  it("holds images and counted short PDFs to the inline cap; a long PDF gets the page-by-page notice", async () => {
    put("/a/big.png", "/h/att/b.png", "image/png", 9 * MB);
    put("/a/short.pdf", "/h/att/s-2p.pdf", "application/pdf", 15 * MB + 1);
    put("/a/long.pdf", "/h/att/l-30p.pdf", "application/pdf", 19 * MB);
    const added = await addAttachmentPaths("k", ["/a/big.png", "/a/short.pdf", "/a/long.pdf"]);
    expect(added.map((a) => a.file.name)).toEqual(["big.png", "long.pdf"]);
    expect(getDraft("k").notice).toBe("Attachments sent with one message must total under 24 MB; short.pdf not attached · long.pdf has 30 pages; Claude reads it page by page");
  });

  it("pdf.js's count later neither removes a staged PDF nor repeats the notice", async () => {
    put("/a/long.pdf", "/h/att/l-30p.pdf", "application/pdf", 1000);
    const [a] = await addAttachmentPaths("k", ["/a/long.pdf"]);
    updateDraft("k", { notice: null });
    settlePdf(a?.id ?? "", { pages: 30, thumb: "data:image/png;base64,x" });
    expect(getDraft("k").attachments[0]?.thumb).toBe("data:image/png;base64,x");
    expect(getDraft("k").notice).toBeNull();
  });

  it("nothing to attach: the draft is untouched", async () => {
    updateDraft("k", { notice: "earlier" });
    expect(await addAttachmentPaths("k", [])).toEqual([]);
    expect(getDraft("k").notice).toBe("earlier");
  });
});
