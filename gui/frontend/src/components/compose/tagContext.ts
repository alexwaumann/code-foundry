import { createContext } from "react";
import type { PromptTag } from "@/lib/prompt";

/** The editor node name of an inline tag (an image chip, a skill, a file). */
export const TAG_NODE = "promptTag";

/** The node's attributes: kind and every kind's fields (unused ones stay ""). */
export interface TagAttrs {
  kind: PromptTag["tagKind"];
  /** image: the attachment id. */
  id: string;
  /** image: the file name; skill: the skill name. */
  name: string;
  /** skill ("" for a user skill), file. */
  repoId: string;
  /** file: the relative path. */
  path: string;
}

export const TAG_ATTR_DEFAULTS: TagAttrs = { kind: "image", id: "", name: "", repoId: "", path: "" };

/** The node's attribute spec (TipTap and ProseMirror take the same shape). */
export const TAG_ATTR_SPEC = {
  kind: { default: TAG_ATTR_DEFAULTS.kind },
  id: { default: "" },
  name: { default: "" },
  repoId: { default: "" },
  path: { default: "" },
};

export function tagAttrs(tag: PromptTag): TagAttrs {
  switch (tag.tagKind) {
    case "image":
      return { ...TAG_ATTR_DEFAULTS, kind: "image", id: tag.id, name: tag.name };
    case "skill":
      return { ...TAG_ATTR_DEFAULTS, kind: "skill", name: tag.name, repoId: tag.repoId };
    case "file":
      return { ...TAG_ATTR_DEFAULTS, kind: "file", repoId: tag.repoId, path: tag.path };
  }
}

/** The tag a node's attributes describe. */
export function tagOf(attrs: Record<string, unknown>): PromptTag {
  const s = (k: keyof TagAttrs) => {
    const v = attrs[k];
    return typeof v === "string" ? v : "";
  };
  switch (s("kind")) {
    case "skill":
      return { tagKind: "skill", name: s("name"), repoId: s("repoId") };
    case "file":
      return { tagKind: "file", repoId: s("repoId"), path: s("path") };
    default:
      return { tagKind: "image", id: s("id"), name: s("name") };
  }
}

/** The draft (draftKey) the tags belong to (image chips look their attachment up by id). */
export const TagDraftContext = createContext("");

/** The draft has more than one project: a file tag's tooltip names its project. */
export const TagMultiProjectContext = createContext(false);
