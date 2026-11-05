import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ReadFileResponseSchema, WriteFileResponseSchema } from "@/gen/codefoundry/v1/filesystem_pb";
import { DiffScope, FileVersionSchema, GetWorktreeFileDiffResponseSchema } from "@/gen/codefoundry/v1/project_pb";
import { toFileDiffView } from "./fileDiff";
import type { DaemonConnection } from "./endpoint";
import { canEdit, isImageMime, readFile, READ_MAX_BYTES, toFileReadView, writeFile, type FileReadView } from "./files";

const enc = new TextEncoder();

describe("toFileReadView", () => {
  it("decodes a text file as UTF-8", () => {
    const v = toFileReadView(
      create(ReadFileResponseSchema, { contents: enc.encode("# Héllo\n"), size: 9n, mimeType: "text/markdown", modifiedAt: 1_700_000_000_000n, resolvedPath: "/Users/dev/a/README.md" }),
    );
    expect(v).toEqual({
      path: "/Users/dev/a/README.md",
      size: 9,
      truncated: false,
      binary: false,
      mime: "text/markdown",
      modifiedAtMs: 1_700_000_000_000,
      notFound: false,
      isDir: false,
      text: "# Héllo\n",
      lossless: true,
      image: null,
      pdf: null,
    });
  });

  it("keeps an image's bytes and no text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const v = toFileReadView(create(ReadFileResponseSchema, { contents: png, size: 6n, binary: true, mimeType: "image/png", resolvedPath: "/Users/dev/a/logo.png" }));
    expect(v.text).toBeNull();
    expect(v.image).toEqual(png);
    expect(v.pdf).toBeNull();
    expect(v.modifiedAtMs).toBeNull();
  });

  it("keeps a PDF's bytes as pdf, not image; a truncated one keeps its flag and full size", () => {
    const bytes = enc.encode("%PDF-1.4\n");
    const v = toFileReadView(create(ReadFileResponseSchema, { contents: bytes, size: 9n, binary: true, mimeType: "application/pdf", resolvedPath: "/x/spec.pdf" }));
    expect([v.text, v.image, v.truncated]).toEqual([null, null, false]);
    expect(v.pdf).toEqual(bytes);
    const big = toFileReadView(create(ReadFileResponseSchema, { contents: bytes, size: 50_000_000n, truncated: true, binary: true, mimeType: "application/pdf", resolvedPath: "/x/huge.pdf" }));
    expect([big.truncated, big.size, big.pdf !== null]).toEqual([true, 50_000_000, true]);
    const gone = toFileReadView(create(ReadFileResponseSchema, { notFound: true, mimeType: "application/pdf", resolvedPath: "/x/gone.pdf" }));
    expect(gone.pdf).toBeNull();
  });

  it("keeps neither for other binaries, a folder, or a missing path", () => {
    const bin = toFileReadView(create(ReadFileResponseSchema, { contents: new Uint8Array([0, 1, 2]), size: 3n, binary: true, mimeType: "application/octet-stream", resolvedPath: "/x/tool" }));
    expect([bin.text, bin.image, bin.pdf]).toEqual([null, null, null]);
    const dir = toFileReadView(create(ReadFileResponseSchema, { isDir: true, size: 128n, resolvedPath: "/x/docs" }));
    expect([dir.isDir, dir.text, dir.image, dir.size]).toEqual([true, null, null, 128]);
    const gone = toFileReadView(create(ReadFileResponseSchema, { notFound: true, resolvedPath: "/x/nope.ts" }));
    expect([gone.notFound, gone.text, gone.path]).toEqual([true, null, "/x/nope.ts"]);
  });

  it("marks truncation with the full size", () => {
    const v = toFileReadView(create(ReadFileResponseSchema, { contents: enc.encode("a\n"), size: 4_400_000n, truncated: true, mimeType: "text/plain; charset=utf-8", resolvedPath: "/x/big.log" }));
    expect([v.truncated, v.size, v.text]).toEqual([true, 4_400_000, "a\n"]);
  });

  it("isImageMime", () => {
    expect(["image/png", "image/svg+xml", "text/plain", ""].map(isImageMime)).toEqual([true, true, false, false]);
  });

  it("readFile asks for 32 MiB (the daemon still caps text at 1 MiB)", async () => {
    const asked: unknown[] = [];
    const client = {
      readFile: (req: unknown) => {
        asked.push(req);
        return Promise.resolve(create(ReadFileResponseSchema, { resolvedPath: "/x/a.pdf", mimeType: "application/pdf", contents: new Uint8Array([1]) }));
      },
    };
    const conn = { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
    const v = await readFile("/x", "a.pdf", conn);
    expect(READ_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(asked).toEqual([{ baseDir: "/x", path: "a.pdf", maxBytes: 33_554_432n }]);
    expect(v.pdf).toEqual(new Uint8Array([1]));
  });
});

describe("lossless", () => {
  const read = (contents: Uint8Array) => toFileReadView(create(ReadFileResponseSchema, { contents, size: BigInt(contents.length), mimeType: "text/plain", resolvedPath: "/x/a" }));

  it.each([
    ["plain text", enc.encode("a=1\n"), true, "a=1\n"],
    ["CRLF and non-ASCII", enc.encode("é\r\n€\r\n"), true, "é\r\n€\r\n"],
    ["empty", new Uint8Array(), true, ""],
    ["a byte order mark", Uint8Array.of(0xef, 0xbb, 0xbf, 0x61), false, "a"],
    ["invalid UTF-8 (Latin-1)", Uint8Array.of(0x63, 0x61, 0x66, 0xe9), false, "caf\ufffd"],
    ["a sequence cut short", Uint8Array.of(0x61, 0xe2, 0x82), false, "a\ufffd"],
  ])("%s", (_name, bytes, lossless, text) => {
    const v = read(bytes);
    expect([v.lossless, v.text]).toEqual([lossless, text]);
  });

  it("is false for anything without text", () => {
    expect(toFileReadView(create(ReadFileResponseSchema, { binary: true, contents: new Uint8Array([0]) })).lossless).toBe(false);
    expect(toFileReadView(create(ReadFileResponseSchema, { notFound: true })).lossless).toBe(false);
  });
});

describe("canEdit", () => {
  const text: FileReadView = { path: "/x/a.ts", size: 2, truncated: false, binary: false, mime: "text/plain", modifiedAtMs: 1, notFound: false, isDir: false, text: "a\n", lossless: true, image: null, pdf: null };
  it.each<[string, Partial<FileReadView>, boolean]>([
    ["whole text", {}, true],
    ["empty text", { text: "", size: 0 }, true],
    ["truncated", { truncated: true }, false],
    ["binary", { binary: true, text: null, lossless: false }, false],
    ["a folder", { isDir: true, text: null, lossless: false }, false],
    ["missing", { notFound: true, text: null, lossless: false }, false],
    ["invalid UTF-8 or a BOM", { lossless: false }, false],
    ["an SVG, shown as a picture", { image: new Uint8Array([1]) }, false],
    ["a PDF", { pdf: new Uint8Array([1]) }, false],
  ])("%s", (_name, over, want) => {
    expect(canEdit({ ...text, ...over })).toBe(want);
  });
  it("no read yet", () => {
    expect(canEdit(null)).toBe(false);
  });
});

describe("writeFile", () => {
  function connected(answer: () => unknown) {
    const asked: unknown[] = [];
    const client = {
      writeFile: (req: unknown) => {
        asked.push(req);
        return answer();
      },
    };
    return { asked, conn: { client: () => Promise.resolve(client) } as unknown as DaemonConnection };
  }
  const version = { size: 5, modifiedAtMs: 1_700_000_000_000 };

  it("sends the text as UTF-8 with the version it replaces, and takes the new one", async () => {
    const { asked, conn } = connected(() => Promise.resolve(create(WriteFileResponseSchema, { resolvedPath: "/x/.env", size: 9n, modifiedAt: 1_700_000_000_500n })));
    const r = await writeFile("/x", ".env", "é=1\r\n", version, {}, conn);
    expect(asked).toEqual([{ baseDir: "/x", path: ".env", contents: enc.encode("é=1\r\n"), modifiedAt: 1_700_000_000_000n, size: 5n, force: false }]);
    expect(r).toEqual({ path: "/x/.env", size: 9, modifiedAtMs: 1_700_000_000_500, conflict: false, notFound: false });
  });

  it("force goes through; a conflict is an answer", async () => {
    const { asked, conn } = connected(() => Promise.resolve(create(WriteFileResponseSchema, { resolvedPath: "/x/a", conflict: true, notFound: true })));
    const r = await writeFile("/x", "a", "b", { size: 0, modifiedAtMs: null }, { force: true }, conn);
    expect(asked).toEqual([{ baseDir: "/x", path: "a", contents: enc.encode("b"), modifiedAt: 0n, size: 0n, force: true }]);
    expect([r.conflict, r.notFound, r.modifiedAtMs]).toEqual([true, true, null]);
  });

  it("a refusal stays an error with its message", async () => {
    const { conn } = connected(() => Promise.reject(new ConnectError("the file is read-only", Code.FailedPrecondition)));
    await expect(writeFile("/x", "a", "b", version, {}, conn)).rejects.toThrow("the file is read-only");
  });
});

describe("toFileDiffView", () => {
  it("maps both sides, the base and the status", () => {
    const v = toFileDiffView(
      create(GetWorktreeFileDiffResponseSchema, {
        old: create(FileVersionSchema, { present: true, contents: enc.encode("hello\n") }),
        new: create(FileVersionSchema, { present: true, contents: enc.encode("hello\nworld\n"), truncated: true }),
        baseRef: "origin/main",
        mergeBase: "c6d3bc2477",
        head: "ddc0461310",
        status: "M",
      }),
    );
    expect(v).toEqual({
      old: { present: true, text: "hello\n", truncated: false, binary: false },
      new: { present: true, text: "hello\nworld\n", truncated: true, binary: false },
      baseRef: "origin/main",
      mergeBase: "c6d3bc2477",
      head: "ddc0461310",
      status: "M",
      error: "",
    });
  });

  it("an absent side, a binary side, and an error with no sides", () => {
    const added = toFileDiffView(create(GetWorktreeFileDiffResponseSchema, { new: create(FileVersionSchema, { present: true, binary: true, contents: new Uint8Array([0x89, 0]) }), status: "A" }));
    expect(added.old).toEqual({ present: false, text: "", truncated: false, binary: false });
    expect(added.new).toEqual({ present: true, text: "", truncated: false, binary: true });
    const err = toFileDiffView(create(GetWorktreeFileDiffResponseSchema, { error: "the worktree has no base branch to compare with" }));
    expect([err.old.present, err.new.present, err.error]).toEqual([false, false, "the worktree has no base branch to compare with"]);
  });

  it("DiffScope values the request uses exist", () => {
    expect([DiffScope.WORKING, DiffScope.BRANCH]).toEqual([1, 2]);
  });
});
