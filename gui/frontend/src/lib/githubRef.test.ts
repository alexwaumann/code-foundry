import { describe, expect, it } from "vitest";
import { parseGitHubInput, type GitHubInput } from "./githubRef";

const repo = (owner: string, name: string): GitHubInput => ({ kind: "repo", owner, name });
const search = (query: string): GitHubInput => ({ kind: "search", query });

describe("parseGitHubInput", () => {
  const cases: [string, GitHubInput | string][] = [
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    // owner/repo
    ["alexwaumann/code-foundry", repo("alexwaumann", "code-foundry")],
    ["  Octo-Org/Hello.World  ", repo("Octo-Org", "Hello.World")],
    ["owner/repo.git", repo("owner", "repo")],
    // URLs
    ["https://github.com/owner/repo", repo("owner", "repo")],
    ["https://github.com/owner/repo.git", repo("owner", "repo")],
    ["https://github.com/owner/repo/", repo("owner", "repo")],
    ["HTTPS://WWW.GitHub.com/owner/repo", repo("owner", "repo")],
    ["https://github.com/owner/repo/tree/main/docs", repo("owner", "repo")],
    ["https://github.com/owner/repo?tab=readme#top", repo("owner", "repo")],
    ["github.com/owner/repo", repo("owner", "repo")],
    // refused forms: the message says what is accepted
    ["git@github.com:owner/repo.git", "SSH URLs are not supported"],
    ["ssh://git@github.com/owner/repo", "SSH URLs are not supported"],
    ["http://github.com/owner/repo", "Only https:// URLs"],
    ["https://gitlab.com/owner/repo", "not gitlab.com"],
    ["gitlab.com/owner/repo", "not gitlab.com"],
    ["https://github.com/owner", "does not name a repository"],
    ["https://github.com/", "does not name a repository"],
    ["https://github.com/-bad/repo", "not a valid owner/repo"],
    // everything else searches
    ["code foundry", search("code foundry")],
    ["terminal emulator language:zig", search("terminal emulator language:zig")],
    ["foundry", search("foundry")],
    ["a/b/c", search("a/b/c")],
    ["c++/rust", search("c++/rust")],
    ["user:alexwaumann", search("user:alexwaumann")],
  ];
  it.each(cases)("%j", (input, want) => {
    const got = parseGitHubInput(input);
    if (typeof want === "string") {
      expect(got.kind).toBe("error");
      expect(got.kind === "error" ? got.message : "").toContain(want);
    } else {
      expect(got).toEqual(want);
    }
  });
});
