import { describe, expect, it } from "vitest";
import { markdownBlocks } from "./markdownBlocks";

describe("markdownBlocks", () => {
  it.each<[string, string, string[]]>([
    ["one paragraph", "a\nb", ["a\nb"]],
    ["paragraphs", "a\n\nb\n\n\nc", ["a\n\n", "b\n\n\n", "c"]],
    ["no cut until the next block begins", "a\n\n", ["a\n\n"]],
    ["a heading then text", "# T\n\nbody", ["# T\n\n", "body"]],
    ["blank lines inside a fence stay", "```go\na\n\nb\n```\n\nafter", ["```go\na\n\nb\n```\n\n", "after"]],
    ["an open fence holds everything", "```\na\n\nb", ["```\na\n\nb"]],
    ["a longer fence closes only on its own length", "````\n```\n\nx\n````\n\ny", ["````\n```\n\nx\n````\n\n", "y"]],
    ["tildes do not close backticks", "```\n~~~\n\nx\n```\n\ny", ["```\n~~~\n\nx\n```\n\n", "y"]],
    ["a loose list stays one block", "- a\n\n- b\n\n1. c\n\n2) d", ["- a\n\n- b\n\n1. c\n\n2) d"]],
    ["a list after a paragraph is a new block", "a\n\n- b\n\n- c\n\nd", ["a\n\n", "- b\n\n- c\n\n", "d"]],
    ["a list interrupting a paragraph continues it", "a\n- b\n\n- c", ["a\n- b\n\n- c"]],
    ["a list item's continuation stays", "- a\n\n  more\n\nnext", ["- a\n\n  more\n\n", "next"]],
    ["an indented code block stays", "text\n\n    code\n\n    more", ["text\n\n    code\n\n    more"]],
    ["leading blank lines are no cut", "\n\na", ["\n\na"]],
    ["a fenced block inside a list", "- x\n  ```\n\n  y\n  ```\n\nz", ["- x\n  ```\n\n  y\n  ```\n\n", "z"]],
  ])("%s", (_, text, want) => {
    const got = markdownBlocks(text);
    expect(got).toEqual(want);
    expect(got.join("")).toBe(text);
  });

  it("cuts are stable as the text grows", () => {
    const full = "# Title\n\nSome text.\n\n```sh\nls\n\npwd\n```\n\n- a\n- b\n\nEnd.";
    let prev: string[] = [];
    for (let n = 1; n <= full.length; n++) {
      const blocks = markdownBlocks(full.slice(0, n));
      // Every finished block (all but the last) stays as it was.
      expect(blocks.slice(0, prev.length - 1)).toEqual(prev.slice(0, -1));
      prev = blocks;
    }
    expect(prev).toEqual(["# Title\n\n", "Some text.\n\n", "```sh\nls\n\npwd\n```\n\n", "- a\n- b\n\n", "End."]);
  });
});
