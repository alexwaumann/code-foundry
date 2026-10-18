import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { GetPullRequestDiffResponseSchema, GetPullRequestFileResponseSchema } from "@/gen/codefoundry/v1/gh_pb";
import type { DaemonConnection } from "./endpoint";
import { getPullRequestDiff, isTooLargeMessage, tooLargeText, toPullRequestDiffView, toPullRequestFileView } from "./prDiff";

describe("pull request diff mapping", () => {
  it("maps a diff", () => {
    const r = create(GetPullRequestDiffResponseSchema, { diff: "diff --git a/x b/x\n", headSha: "h", baseSha: "b", truncated: true, fetchedAt: timestampFromMs(5000) });
    expect(toPullRequestDiffView(r)).toEqual({ diff: "diff --git a/x b/x\n", headSha: "h", baseSha: "b", truncated: true, fetchedAtMs: 5000 });
    expect(toPullRequestDiffView(create(GetPullRequestDiffResponseSchema, {}))).toEqual({ diff: "", headSha: "", baseSha: "", truncated: false, fetchedAtMs: null });
  });

  it("decodes a file as UTF-8 and leaves binary and missing files empty", () => {
    const text = create(GetPullRequestFileResponseSchema, { contents: new TextEncoder().encode("héllo\n"), truncated: true });
    expect(toPullRequestFileView(text)).toEqual({ contents: "héllo\n", truncated: true, binary: false, notFound: false });
    const bin = create(GetPullRequestFileResponseSchema, { contents: new Uint8Array([0x89, 0, 1]), binary: true });
    expect(toPullRequestFileView(bin)).toEqual({ contents: "", truncated: false, binary: true, notFound: false });
    expect(toPullRequestFileView(create(GetPullRequestFileResponseSchema, { notFound: true }))).toMatchObject({ contents: "", notFound: true });
  });

  it("marks GitHub's refusal of a large diff", async () => {
    const conn = {
      client: () =>
        Promise.resolve({
          getPullRequestDiff: () => Promise.reject(new ConnectError("Sorry, the diff exceeded the maximum number of lines (20000)", Code.FailedPrecondition)),
        }),
    } as unknown as DaemonConnection;
    const err = await getPullRequestDiff("o/r", 1, false, conn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(isTooLargeMessage(message)).toBe(true);
    expect(tooLargeText(message)).toBe("Sorry, the diff exceeded the maximum number of lines (20000)");
    expect(isTooLargeMessage("unavailable")).toBe(false);
  });
});
