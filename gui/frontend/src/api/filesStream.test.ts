import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { PreviewFileResponseSchema, ReadFileResponseSchema, StreamFileResponseSchema } from "@/gen/codefoundry/v1/filesystem_pb";
import type { DaemonConnection } from "./endpoint";
import { OutdatedDaemonError } from "./errors";
import { blankFile, canEdit, mediaKind, previewFile, readFileTail, streamFile, toFileReadView } from "./files";

const enc = new TextEncoder();

/** A connection whose FilesystemService answers `methods`, recording what each was asked. */
function connected(methods: Record<string, () => Promise<unknown>>) {
  const asked: [string, unknown][] = [];
  const client = Object.fromEntries(
    Object.entries(methods).map(([name, answer]) => [
      name,
      (req: unknown) => {
        asked.push([name, req]);
        return answer();
      },
    ]),
  );
  const conn = { client: () => Promise.resolve(client), resolveEndpoint: () => Promise.resolve({ baseUrl: "http://127.0.0.1:7777", token: "t" }) } as unknown as DaemonConnection;
  return { asked, conn };
}

describe("readFileTail", () => {
  it("asks for the tail and says where the text starts", async () => {
    const { asked, conn } = connected({
      readFile: () =>
        Promise.resolve(create(ReadFileResponseSchema, { contents: enc.encode("newest\n"), size: 38_000_000n, truncatedStart: true, offset: 37_999_993n, mimeType: "text/plain", resolvedPath: "/x/server.log" })),
    });
    const v = await readFileTail("/x", "server.log", conn);
    expect(asked).toEqual([["readFile", { baseDir: "/x", path: "server.log", maxBytes: 33_554_432n, tail: true }]]);
    expect([v.text, v.truncatedStart, v.offset, v.truncated, v.size]).toEqual(["newest\n", true, 37_999_993, false, 38_000_000]);
    expect(canEdit(v)).toBe(false);
  });

  it("a daemon older than the RPC is outdated", async () => {
    const { conn } = connected({ readFile: () => Promise.reject(new ConnectError("no", Code.Unimplemented)) });
    await expect(readFileTail("/x", "a.log", conn)).rejects.toBeInstanceOf(OutdatedDaemonError);
  });
});

describe("media reads", () => {
  it("a video read has no bytes, no text, and is not editable", () => {
    const v = toFileReadView(create(ReadFileResponseSchema, { size: 3_100_000n, binary: true, media: true, mimeType: "video/webm", resolvedPath: "/x/demo.webm" }));
    expect([v.media, v.binary, v.text, v.image, v.pdf, v.size, v.mime]).toEqual([true, true, null, null, null, 3_100_000, "video/webm"]);
    expect(canEdit(v)).toBe(false);
  });

  it("a view made by hand without the new fields edits as before", () => {
    const { truncatedStart: _t, offset: _o, media: _m, ...old } = blankFile("/x/a.txt");
    expect(canEdit(old)).toBe(true);
    expect(canEdit({ ...old, truncatedStart: true })).toBe(false);
    expect(canEdit({ ...old, media: true })).toBe(false);
  });

  it.each([
    ["video/mp4", "video"],
    ["video/quicktime", "video"],
    ["audio/mpeg", "audio"],
    ["audio/mp4", "audio"],
    ["image/png", null],
    ["text/plain", null],
    ["", null],
  ])("mediaKind(%s) is %s", (mime, kind) => {
    expect(mediaKind(mime)).toBe(kind);
  });
});

describe("streamFile", () => {
  it("joins the grant's URL to the daemon's base URL", async () => {
    const { asked, conn } = connected({
      streamFile: () => Promise.resolve(create(StreamFileResponseSchema, { url: "/media/abc/a%20b.mp4", mimeType: "video/mp4", size: 2700n, modifiedAt: 1_700_000_000_000n })),
    });
    const s = await streamFile("/x", "a b.mp4", conn);
    expect(asked).toEqual([["streamFile", { baseDir: "/x", path: "a b.mp4" }]]);
    expect(s).toEqual({ url: "http://127.0.0.1:7777/media/abc/a%20b.mp4", mime: "video/mp4", size: 2700, modifiedAtMs: 1_700_000_000_000 });
  });

  it("a refusal stays an error with its message; an old daemon is outdated", async () => {
    const refused = connected({ streamFile: () => Promise.reject(new ConnectError("/x/a.txt is not a video or audio file", Code.InvalidArgument)) });
    await expect(streamFile("/x", "a.txt", refused.conn)).rejects.toThrow("is not a video or audio file");
    const old = connected({ streamFile: () => Promise.reject(new ConnectError("no", Code.Unimplemented)) });
    await expect(streamFile("/x", "a.mp4", old.conn)).rejects.toBeInstanceOf(OutdatedDaemonError);
  });
});

describe("previewFile", () => {
  // A new daemon answers on the grant's own origin; one from before grant hosts (an update can
  // leave it running beside this GUI) ignores grantHost and answers on the preview route.
  it.each([
    ["a daemon with grant hosts", "http://0123456789abcdef0123456789abcdef.localhost:4242/a%20b.html"],
    ["a daemon from before grant hosts", "http://127.0.0.1:4242/preview/0123456789abcdef0123456789abcdef/a%20b.html"],
    ["a daemon with no pages listener", "/preview/g/a%20b.html", "http://127.0.0.1:7777/preview/g/a%20b.html"],
  ])("asks for the grant's own origin and loads what %s answers", async (_name, url, want = url) => {
    const { asked, conn } = connected({ previewFile: () => Promise.resolve(create(PreviewFileResponseSchema, { url, scope: "/x" })) });
    const p = await previewFile("/x", "a b.html", conn);
    expect(asked).toEqual([["previewFile", { baseDir: "/x", path: "a b.html", grantHost: true }]]);
    expect(p.url).toBe(want);
  });
});
