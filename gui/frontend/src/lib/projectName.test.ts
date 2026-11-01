import { describe, expect, it } from "vitest";
import { projectRenameError } from "./projectName";

const others = [
  { id: "aaaaaaaaaaaa", name: "web" },
  { id: "bbbbbbbbbbbb", name: "api" },
];

describe("projectRenameError", () => {
  it.each([
    ["shop", ""],
    ["  shop  ", ""],
    ["", "Name it."],
    ["   ", "Name it."],
    ["x".repeat(101), "At most 100 bytes."],
    ["a\nb", "One line."],
    ["web/site", "No / or , in a project name."],
    ["web,site", "No / or , in a project name."],
    ["~", "No / or , in a project name."],
    ["Workspace", "“workspace” is reserved."],
    ["API", "A project named “api” exists."],
    ["BBBBBBBBBBBB", "“BBBBBBBBBBBB” is another project’s id."],
  ])("%j → %j", (name, want) => {
    expect(projectRenameError(name, others)).toBe(want);
  });
});
