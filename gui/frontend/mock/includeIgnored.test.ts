import { describe, expect, it } from "vitest";
import { searchFiles } from "./filesystem";
import {
  checkIncludeSetting,
  includedIgnored,
  splitIncludeSetting,
  suggestIncludeIgnored,
} from "./includeIgnored";

// The mock mirrors the daemon's rules in small (internal/fsx/include_test.go is the real test);
// these pin what PR 2's GUI builds against.
const projects = new Map([
  [
    "repo-cf",
    {
      id: "repo-cf",
      name: "code-foundry",
      path: "/Users/dev/src/code-foundry",
      includeIgnored: ["docs/scratch/"],
    },
  ],
  [
    "plain",
    { id: "plain", name: "plain", path: "/Users/dev/plain", git: false },
  ],
]);
const req = {
  projectId: "repo-cf",
  path: "",
  query: "",
  limit: 0,
  sources: [],
  filesOnly: true,
};

describe("include patterns in the mock", () => {
  it("lists the setting's and the project's ignored files, marked, but not inside other ignored folders", () => {
    const res = searchFiles(
      projects,
      { ...req, query: "env" },
      splitIncludeSetting(".env*"),
    );
    const got = (res.matches ?? []).map((m) =>
      m.ignored ? `${m.path ?? ""} (ignored)` : (m.path ?? ""),
    );
    expect(got).toEqual(
      expect.arrayContaining([
        ".env (ignored)",
        ".env.local (ignored)",
        "src/.env.test (ignored)",
      ]),
    );
    expect(got.some((p) => p.startsWith("node_modules/"))).toBe(false);
    const scratch = searchFiles(projects, { ...req, query: "plan" }, []);
    expect((scratch.matches ?? []).map((m) => [m.path, m.ignored])).toEqual([
      ["docs/scratch/plan.md", true],
    ]);
    const plain = searchFiles(
      projects,
      { ...req, projectId: "plain", query: "env" },
      [".env*"],
    );
    expect(plain.matches ?? []).toEqual([]);
  });

  it("reaches into a collapsed folder only by its path", () => {
    expect(includedIgnored("repo-cf", ["*.js"])).toEqual([]);
    expect(includedIgnored("repo-cf", ["dist/*.js"])).toEqual([
      "dist/index.js",
    ]);
    expect(includedIgnored("repo-cf", ["node_modules"])).toHaveLength(3);
  });

  it("reads none and refuses what the daemon refuses", () => {
    expect(splitIncludeSetting("none")).toEqual([]);
    expect(splitIncludeSetting(".env*, CLAUDE.local.md, .env*")).toEqual([
      ".env*",
      "CLAUDE.local.md",
    ]);
    expect(() => {
      checkIncludeSetting("!x");
    }).toThrow("starts with !");
    expect(() => {
      checkIncludeSetting("../x");
    }).toThrow('".." segment');
  });

  it("suggests entries, counts folders and the typed pattern", () => {
    const res = suggestIncludeIgnored(
      "repo-cf",
      true,
      [".env*"],
      "node_modules/",
      0,
    );
    expect(res.suggestions[0]).toMatchObject({
      path: "node_modules",
      isDir: true,
      fileCount: 3,
      matchesText: true,
      included: false,
    });
    expect(res.textFiles).toBe(3);
    expect(
      suggestIncludeIgnored("repo-cf", true, [".env*"], ".env", 0)
        .suggestions[0],
    ).toMatchObject({ path: ".env", included: true });
    expect(
      suggestIncludeIgnored("repo-cf", true, [], "/x", 0).textError,
    ).toContain("relative to the project");
    expect(() => suggestIncludeIgnored("plain", false, [], "", 0)).toThrow(
      "not a git repository",
    );
  });
});
