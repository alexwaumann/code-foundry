import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  ListDirectoriesResponseSchema,
  ListSkillsResponseSchema,
  SearchFilesResponseSchema,
  SkillSchema,
  SkillScope,
  SuggestIncludeIgnoredResponseSchema,
} from "@/gen/codefoundry/v1/filesystem_pb";
import { listingMessage } from "@/components/palette/usePathListing";
import type { DaemonConnection } from "./endpoint";
import { OUTDATED_DAEMON_MESSAGE, OutdatedDaemonError } from "./errors";
import { listSkills, PathRejectedError, searchFiles, suggestIncludeIgnored, toDirectoryListingView, toFileSearchView, toSkillView } from "./filesystem";

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
      { name: "review", description: "Review it.", scope: SkillScope.PROJECT, projectId: "r-1", path: "/w/.claude/skills/review/SKILL.md" },
      { name: "review", description: "Review it.", scope: "project", projectId: "r-1", path: "/w/.claude/skills/review/SKILL.md" },
    ],
    [
      "user scope, no description",
      { name: "commit", scope: SkillScope.USER, path: "/h/.claude/commands/commit.md" },
      { name: "commit", description: "", scope: "user", projectId: "", path: "/h/.claude/commands/commit.md" },
    ],
  ] as const)("%s", (_name, init, want) => {
    expect(toSkillView(create(SkillSchema, init))).toEqual(want);
  });
});

describe("toFileSearchView", () => {
  it("maps matches in order", () => {
    const res = create(SearchFilesResponseSchema, {
      matches: [{ path: "src", isDir: true }, { path: "src/index.ts" }, { path: ".env", ignored: true }],
      truncated: true,
    });
    expect(toFileSearchView(res)).toEqual({
      matches: [
        { path: "src", isDir: true, ignored: false },
        { path: "src/index.ts", isDir: false, ignored: false },
        { path: ".env", isDir: false, ignored: true },
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

describe("listSkills and searchFiles requests", () => {
  /** A connection whose FilesystemService client records requests and answers with res (or fails with err). */
  function fakeConn(res: unknown, err?: Error) {
    const calls: { method: string; req: unknown }[] = [];
    const handler = (method: string) => (req: unknown) => {
      calls.push({ method, req });
      return err === undefined ? Promise.resolve(res) : Promise.reject(err);
    };
    const client = { listSkills: handler("listSkills"), searchFiles: handler("searchFiles"), suggestIncludeIgnored: handler("suggestIncludeIgnored") };
    const conn = { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
    return { conn, calls };
  }

  it("listSkills sends each source (no path: the main worktree) and maps the skills", async () => {
    const { conn, calls } = fakeConn(
      create(ListSkillsResponseSchema, { skills: [{ name: "commit", scope: SkillScope.USER, path: "/h/.claude/skills/commit/SKILL.md" }] }),
    );
    const got = await listSkills([{ projectId: "r-1" }, { projectId: "r-2", path: "/w/r-2" }], true, conn);
    expect(calls).toEqual([
      {
        method: "listSkills",
        req: {
          sources: [
            { projectId: "r-1", path: "" },
            { projectId: "r-2", path: "/w/r-2" },
          ],
          includeUser: true,
        },
      },
    ]);
    expect(got).toEqual([{ name: "commit", description: "", scope: "user", projectId: "", path: "/h/.claude/skills/commit/SKILL.md" }]);
  });

  it("searchFiles defaults path and limit to the proto's zero values", async () => {
    const { conn, calls } = fakeConn(create(SearchFilesResponseSchema, { matches: [{ path: "a.ts" }] }));
    const got = await searchFiles({ projectId: "r-1", query: "a" }, conn);
    expect(calls).toEqual([{ method: "searchFiles", req: { projectId: "r-1", path: "", query: "a", limit: 0 } }]);
    expect(got).toEqual({ matches: [{ path: "a.ts", isDir: false, ignored: false }], truncated: false });
  });

  it("suggestIncludeIgnored sends the project and text (limit 0 by default) and maps the answer", async () => {
    const { conn, calls } = fakeConn(
      create(SuggestIncludeIgnoredResponseSchema, {
        suggestions: [{ path: "dist", isDir: true, fileCount: 1000, fileCountCapped: true, included: true, matchesText: true, pathPositions: [0, 1] }],
        truncated: true,
        textFiles: 3,
        textFilesCapped: false,
        textError: "",
      }),
    );
    const got = await suggestIncludeIgnored({ projectId: "r-1", text: "di" }, conn);
    expect(calls).toEqual([{ method: "suggestIncludeIgnored", req: { projectId: "r-1", text: "di", limit: 0 } }]);
    expect(got).toEqual({ suggestions: [{ path: "dist", isDir: true, fileCount: 1000, fileCountCapped: true, included: true, pathPositions: [0, 1] }], textFiles: 3, textFilesCapped: false, textError: "" });
  });

  it.each([
    ["listSkills", (conn: DaemonConnection) => listSkills([], true, conn)],
    ["searchFiles", (conn: DaemonConnection) => searchFiles({ projectId: "r-1", query: "" }, conn)],
  ] as const)("%s on an older daemon fails with OutdatedDaemonError", async (_name, call) => {
    const { conn } = fakeConn(undefined, new ConnectError("HTTP 404", Code.Unimplemented));
    await expect(call(conn)).rejects.toBeInstanceOf(OutdatedDaemonError);
  });

  it("other errors pass through", async () => {
    const err = new ConnectError("project zz not found", Code.NotFound);
    const { conn } = fakeConn(undefined, err);
    await expect(searchFiles({ projectId: "zz", query: "" }, conn)).rejects.toBe(err);
  });
});
