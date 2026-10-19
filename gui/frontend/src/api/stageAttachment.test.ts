import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { StageAttachmentResponseSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import type { DaemonConnection } from "./endpoint";
import { OutdatedDaemonError } from "./errors";
import { stageAttachment, stageAttachmentPath } from "./threads";

/** A connection whose ThreadService client records StageAttachment requests and answers with path (or fails with err). */
function fakeConn(path: string, err?: Error) {
  const calls: unknown[] = [];
  const client = {
    stageAttachment: (req: unknown) => {
      calls.push(req);
      return err === undefined ? Promise.resolve(create(StageAttachmentResponseSchema, { path })) : Promise.reject(err);
    },
  };
  const conn = { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
  return { conn, calls };
}

describe("stageAttachment", () => {
  it("uploads the bytes with the name, type and page hint", async () => {
    const { conn, calls } = fakeConn("/h/.code-foundry/attachments/ab.png");
    const file = { name: "shot.png", type: "image/png", arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) };
    expect(await stageAttachment(file, null, conn)).toBe("/h/.code-foundry/attachments/ab.png");
    expect(calls).toEqual([{ name: "shot.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]), pages: 0 }]);
  });
});

describe("stageAttachmentPath", () => {
  it.each([
    ["no hint", null, 0],
    ["a hint", 12, 12],
  ] as const)("sends only the path and %s", async (_name, pages, want) => {
    const { conn, calls } = fakeConn("/h/.code-foundry/attachments/cd-12p.pdf");
    expect(await stageAttachmentPath("/Users/me/Desktop/doc.pdf", pages, conn)).toBe("/h/.code-foundry/attachments/cd-12p.pdf");
    expect(calls).toEqual([{ path: "/Users/me/Desktop/doc.pdf", pages: want }]);
  });

  it("fails with OutdatedDaemonError on an older daemon", async () => {
    const { conn } = fakeConn("", new ConnectError("HTTP 404", Code.Unimplemented));
    await expect(stageAttachmentPath("/a.png", null, conn)).rejects.toBeInstanceOf(OutdatedDaemonError);
  });

  it("passes the daemon's refusal through", async () => {
    const err = new ConnectError('invalid argument: attachment type "text/plain; charset=utf-8"', Code.InvalidArgument);
    const { conn } = fakeConn("", err);
    await expect(stageAttachmentPath("/a.txt", null, conn)).rejects.toBe(err);
  });
});
