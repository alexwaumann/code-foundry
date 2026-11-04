import { Fragment, Slice, type Schema } from "@tiptap/pm/model";

/** Dictated text as a slice that merges into the paragraph at the caret: a line break starts a paragraph, as Shift+Enter does. Never chips. */
export function dictatedSlice(schema: Schema, text: string): Slice {
  return Slice.maxOpen(Fragment.from(text.split("\n").map((line) => schema.node("paragraph", null, line ? [schema.text(line)] : []))));
}
