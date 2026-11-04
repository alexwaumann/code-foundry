import { getSchema } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { dictatedSlice } from "./dictatedSlice";

const schema = getSchema([Document, Paragraph, Text]);

/** The paragraphs after inserting `text` at `caret` in a one-paragraph prompt, and the text left of the new caret. */
function insert(prompt: string, caret: number, text: string): { lines: string[]; left: string } {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, prompt ? [schema.text(prompt)] : [])]);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret + 1) });
  const tr = state.tr.replace(state.selection.from, state.selection.to, dictatedSlice(schema, text));
  const end = tr.mapping.map(state.selection.to);
  tr.setSelection(TextSelection.create(tr.doc, end));
  const lines: string[] = [];
  tr.doc.forEach((n) => lines.push(n.textContent));
  const { $from } = tr.selection;
  return { lines, left: $from.parent.textBetween(0, $from.parentOffset) };
}

describe("dictatedSlice", () => {
  it.each([
    { name: "plain text", prompt: "one", caret: 3, text: " two", lines: ["one two"], left: "one two" },
    { name: "a line break alone", prompt: "one", caret: 3, text: "\n", lines: ["one", ""], left: "" },
    { name: "a paragraph alone", prompt: "one", caret: 3, text: "\n\n", lines: ["one", "", ""], left: "" },
    { name: "a break inside the phrase", prompt: "", caret: 0, text: "one\ntwo", lines: ["one", "two"], left: "two" },
    { name: "a break ending the phrase", prompt: "", caret: 0, text: "one\n", lines: ["one", ""], left: "" },
    { name: "a break starting the phrase", prompt: "one", caret: 3, text: "\ntwo", lines: ["one", "two"], left: "two" },
    { name: "the rest of the line moves down", prompt: "one two", caret: 3, text: "\n", lines: ["one", " two"], left: "" },
    { name: "the caret stays before the rest", prompt: "onetwo", caret: 3, text: "\nmid ", lines: ["one", "mid two"], left: "mid " },
  ])("$name", ({ prompt, caret, text, lines, left }) => {
    expect(insert(prompt, caret, text)).toEqual({ lines, left });
  });

  it("leaves a chip's token as text", () => {
    const slice = dictatedSlice(schema, "@[file](a.go)");
    expect(slice.content.textBetween(0, slice.content.size)).toBe("@[file](a.go)");
  });
});
