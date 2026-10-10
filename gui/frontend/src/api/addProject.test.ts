import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GitHubRepositorySchema, RepositoryVisibility } from "@/gen/codefoundry/v1/repo_pb";
import { appendProgress, toGitHubRepoView, type CloneProgressView } from "./addProject";

describe("toGitHubRepoView", () => {
  it("maps the proto, visibility included", () => {
    const v = toGitHubRepoView(
      create(GitHubRepositorySchema, {
        owner: "Octo",
        name: "old",
        description: "retired",
        visibility: RepositoryVisibility.INTERNAL,
        isArchived: true,
        isFork: true,
        url: "https://github.com/Octo/old",
        clonePath: "/Users/me/.code-foundry/projects/Octo/old",
        clonePathExists: true,
      }),
    );
    expect(v).toEqual({
      owner: "Octo",
      name: "old",
      slug: "Octo/old",
      description: "retired",
      visibility: "internal",
      archived: true,
      fork: true,
      url: "https://github.com/Octo/old",
      clonePath: "/Users/me/.code-foundry/projects/Octo/old",
      clonePathExists: true,
    });
    expect(toGitHubRepoView(create(GitHubRepositorySchema, {})).visibility).toBe("");
  });
});

describe("appendProgress", () => {
  const line = (text: string, transient = false): CloneProgressView => ({ line: text, transient });
  const cases: { name: string; start: CloneProgressView[]; add: CloneProgressView; want: string[] }[] = [
    { name: "appends a final line", start: [line("a")], add: line("b"), want: ["a", "b"] },
    { name: "a transient line is replaced by the next", start: [line("a"), line("1%", true)], add: line("50%", true), want: ["a", "50%"] },
    { name: "and by the final one", start: [line("a"), line("50%", true)], add: line("100%, done."), want: ["a", "100%, done."] },
    { name: "a transient line after a final one is appended", start: [line("a")], add: line("1%", true), want: ["a", "1%"] },
  ];
  it.each(cases)("$name", ({ start, add, want }) => {
    expect(appendProgress(start, add).map((l) => l.line)).toEqual(want);
  });
  it("keeps the last max lines", () => {
    let lines: CloneProgressView[] = [];
    for (let i = 0; i < 10; i++) lines = appendProgress(lines, line(String(i)), 4);
    expect(lines.map((l) => l.line)).toEqual(["6", "7", "8", "9"]);
  });
});
