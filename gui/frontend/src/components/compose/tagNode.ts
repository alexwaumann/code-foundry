import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TAG_ATTR_SPEC, TAG_NODE } from "./tagContext";
import { TagView } from "./TagView";

/**
 * The inline, atomic tag node (an image chip, a skill, a file): deleted, skipped and
 * selected as one unit. `kind` picks the view (TagView).
 */
export const TagNode = Node.create({
  name: TAG_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return TAG_ATTR_SPEC;
  },
  parseHTML() {
    return [{ tag: "span[data-prompt-tag]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-prompt-tag": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TagView, { as: "span" });
  },
});
