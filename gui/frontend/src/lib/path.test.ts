import { describe, expect, it } from "vitest";
import { splitPathTail } from "./path";

describe("splitPathTail", () => {
  it.each([
    ["a worktree", "~/.code-foundry/worktrees/code-foundry/cf-fix-the-thing", { head: "~/.code-foundry/worktrees/code-foundry/", tail: "cf-fix-the-thing" }],
    ["a trailing slash", "~/src/web/", { head: "~/src/", tail: "web" }],
    ["no slash", "web", { head: "", tail: "web" }],
    ["the root", "/", { head: "", tail: "/" }],
    ["one segment", "/tmp", { head: "/", tail: "tmp" }],
    ["empty", "", { head: "", tail: "" }],
  ])("%s", (_n, p, want) => {
    expect(splitPathTail(p)).toEqual(want);
  });
});
