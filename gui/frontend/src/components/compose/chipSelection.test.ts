import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CHIP_NODE } from "./chipContext";
import { selectedChipId } from "./chipSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*" },
    text: { group: "inline" },
    [CHIP_NODE]: { group: "inline", inline: true, atom: true, selectable: true, attrs: { id: { default: "" }, name: { default: "" } } },
  },
});

// <p>ab[chip a1]c[chip a2]</p>: a=1, b=2, chip a1 at 3..4, c 4..5, chip a2 at 5..6.
const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("ab"), schema.node(CHIP_NODE, { id: "a1", name: "x.png" }), schema.text("c"), schema.node(CHIP_NODE, { id: "a2", name: "y.png" })]),
]);

describe("selectedChipId", () => {
  const cases: { name: string; sel: () => Parameters<typeof selectedChipId>[0]; want: string | null }[] = [
    { name: "node selection of a chip", sel: () => NodeSelection.create(doc, 3), want: "a1" },
    { name: "node selection of the last chip", sel: () => NodeSelection.create(doc, 5), want: "a2" },
    { name: "text range over exactly one chip", sel: () => TextSelection.create(doc, 3, 4), want: "a1" },
    { name: "backwards text range over one chip", sel: () => TextSelection.create(doc, 4, 3), want: "a1" },
    { name: "caret before a chip", sel: () => TextSelection.create(doc, 3), want: null },
    { name: "range over the chip and text", sel: () => TextSelection.create(doc, 3, 5), want: null },
    { name: "range over text before the chip", sel: () => TextSelection.create(doc, 2, 4), want: null },
    { name: "range over plain text", sel: () => TextSelection.create(doc, 1, 3), want: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(selectedChipId(c.sel())).toBe(c.want);
    });
  }
});
