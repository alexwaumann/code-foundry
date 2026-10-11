import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ListDirectoriesResponseSchema, SearchFilesResponseSchema, SkillSchema, SkillScope } from "@/gen/codefoundry/v1/filesystem_pb";
import { listingMessage } from "@/components/palette/usePathListing";
import { OUTDATED_DAEMON_MESSAGE } from "./errors";
import { PathRejectedError, toDirectoryListingView, toFileSearchView, toSkillView } from "./filesystem";

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

describe("toSkillView", () => {
  it.each([
    [
      "project scope",
      { name: "review", description: "Review it.", scope: SkillScope.PROJECT, repoId: "r-1", path: "/w/.claude/skills/review/SKILL.md" },
      { name: "review", description: "Review it.", scope: "project", repoId: "r-1", path: "/w/.claude/skills/review/SKILL.md" },
    ],
    [
      "user scope, no description",
      { name: "commit", scope: SkillScope.USER, path: "/h/.claude/commands/commit.md" },
      { name: "commit", description: "", scope: "user", repoId: "", path: "/h/.claude/commands/commit.md" },
    ],
  ] as const)("%s", (_name, init, want) => {
    expect(toSkillView(create(SkillSchema, init))).toEqual(want);
  });
});

describe("toFileSearchView", () => {
  it("maps matches in order", () => {
    const res = create(SearchFilesResponseSchema, {
      matches: [{ path: "src", isDir: true }, { path: "src/index.ts" }],
      truncated: true,
    });
    expect(toFileSearchView(res)).toEqual({
      matches: [
        { path: "src", isDir: true },
        { path: "src/index.ts", isDir: false },
      ],
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
