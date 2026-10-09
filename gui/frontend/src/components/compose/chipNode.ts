import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { AttachmentChipView } from "./AttachmentChip";

import { CHIP_NODE } from "./chipContext";

/** The inline, atomic chip node: deleted, skipped and selected as one unit. */
export const AttachmentChipNode = Node.create({
  name: CHIP_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { id: { default: "" }, name: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-attachment-chip]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-attachment-chip": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentChipView, { as: "span" });
  },
});
