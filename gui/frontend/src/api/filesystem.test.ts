import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ListDirectoriesResponseSchema } from "@/gen/codefoundry/v1/filesystem_pb";
import { listingMessage } from "@/components/palette/usePathListing";
import { OUTDATED_DAEMON_MESSAGE } from "./errors";
import { PathRejectedError, toDirectoryListingView } from "./filesystem";

describe("toDirectoryListingView", () => {
  it("maps entries and the completion", () => {
    const res = create(ListDirectoriesResponseSchema, {
      entries: [
        { path: "/Users/me/src/app", name: "app", isGit: true, registered: true },
        { path: "/Users/me/src/apple", name: "apple" },
      ],
      completion: "~/src/app",
      truncated: true,
    });
    expect(toDirectoryListingView(res)).toEqual({
      entries: [
        { path: "/Users/me/src/app", name: "app", isGit: true, registered: true },
        { path: "/Users/me/src/apple", name: "apple", isGit: false, registered: false },
      ],
      completion: "~/src/app",
      truncated: true,
    });
  });
});

describe("listingMessage", () => {
  it.each([
    ["a refused prefix says why", new PathRejectedError("/etc/ is outside your home directory"), "/etc/ is outside your home directory"],
    ["an outdated daemon asks for a restart", new ConnectError("HTTP 404", Code.Unimplemented), OUTDATED_DAEMON_MESSAGE],
    ["anything else stays quiet", new ConnectError("down", Code.Unavailable), null],
  ])("%s", (_name, err, want) => {
    expect(listingMessage(err)).toBe(want);
  });
});
