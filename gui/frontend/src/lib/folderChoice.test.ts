import { describe, expect, it } from "vitest";
import { folderChoiceHeading, workspaceChoiceLine } from "./folderChoice";

describe("folder choice lines", () => {
  it.each([
    [1, "The 1 repo inside becomes a project; this folder is its root for instructions and skills.", "has a git repository inside."],
    [3, "The 3 repos inside become projects; this folder is their shared root for instructions and skills.", "has 3 git repositories inside."],
  ])("%i repos", (n, line, heading) => {
    expect(workspaceChoiceLine(n)).toBe(line);
    expect(folderChoiceHeading(n)).toBe(heading);
  });
});
