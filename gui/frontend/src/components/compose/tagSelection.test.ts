import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { TAG_ATTR_SPEC, TAG_NODE, tagAttrs, tagOf } from "./tagContext";
import { selectedChipId } from "./tagSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*" },
    text: { group: "inline" },
    [TAG_NODE]: {
      group: "inline",
      inline: true,
      atom: true,
      selectable: true,
      attrs: TAG_ATTR_SPEC,
    },
  },
});

const image = (id: string, name: string) => schema.node(TAG_NODE, tagAttrs({ tagKind: "image", id, name }));

// <p>ab[chip a1]c[chip a2][skill]</p>: a=1, b=2, chip a1 at 3..4, c 4..5, chip a2 at 5..6, skill 6..7.
const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [
    schema.text("ab"),
    image("a1", "x.png"),
    schema.text("c"),
    image("a2", "y.png"),
    schema.node(TAG_NODE, tagAttrs({ tagKind: "skill", name: "deploy", projectId: "r1" })),
  ]),
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
    { name: "a skill tag has no preview", sel: () => NodeSelection.create(doc, 6), want: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(selectedChipId(c.sel())).toBe(c.want);
    });
  }
});

describe("tag attributes", () => {
  it.each([
    { tagKind: "image", id: "a1", name: "x.png" },
    { tagKind: "skill", name: "deploy", projectId: "" },
    { tagKind: "file", projectId: "r1", path: "src/" },
    { tagKind: "thread", id: "s-0123456789ab", name: "Fix resize race" },
    { tagKind: "pr", slug: "alexwaumann/code-foundry", number: 185 },
  ] as const)("round-trip a $tagKind tag", (tag) => {
    expect(tagOf({ ...tagAttrs(tag) })).toEqual(tag);
  });
});
