import { createContext } from "react";
import type { PromptTag } from "@/lib/prompt";

/** The editor node name of an inline tag (an image chip, a skill, a file, a thread, a pull request, a citation). */
export const TAG_NODE = "promptTag";

/** The node's attributes: kind and every kind's fields (unused ones stay ""). */
export interface TagAttrs {
  kind: PromptTag["tagKind"];
  /** image: the attachment id; thread: the thread id; cite: the citation id. */
  id: string;
  /** image: the file name; skill: the skill name; thread: its name when inserted. */
  name: string;
  /** skill ("" for a user skill), file. */
  projectId: string;
  /** file: the relative path. */
  path: string;
  /** pr: "owner/repo". */
  slug: string;
  /** pr: the pull request number, as text ("" for other kinds). */
  number: string;
}

export const TAG_ATTR_DEFAULTS: TagAttrs = { kind: "image", id: "", name: "", projectId: "", path: "", slug: "", number: "" };

/** The node's attribute spec (TipTap and ProseMirror take the same shape). */
export const TAG_ATTR_SPEC = {
  kind: { default: TAG_ATTR_DEFAULTS.kind },
  id: { default: "" },
  name: { default: "" },
  projectId: { default: "" },
  path: { default: "" },
  slug: { default: "" },
  number: { default: "" },
};

export function tagAttrs(tag: PromptTag): TagAttrs {
  switch (tag.tagKind) {
    case "image":
      return { ...TAG_ATTR_DEFAULTS, kind: "image", id: tag.id, name: tag.name };
    case "skill":
      return { ...TAG_ATTR_DEFAULTS, kind: "skill", name: tag.name, projectId: tag.projectId };
    case "file":
      return { ...TAG_ATTR_DEFAULTS, kind: "file", projectId: tag.projectId, path: tag.path };
    case "thread":
      return { ...TAG_ATTR_DEFAULTS, kind: "thread", id: tag.id, name: tag.name };
    case "pr":
      return { ...TAG_ATTR_DEFAULTS, kind: "pr", slug: tag.slug, number: String(tag.number) };
    case "cite":
      return { ...TAG_ATTR_DEFAULTS, kind: "cite", id: tag.id };
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
      return { tagKind: "skill", name: s("name"), projectId: s("projectId") };
    case "file":
      return { tagKind: "file", projectId: s("projectId"), path: s("path") };
    case "thread":
      return { tagKind: "thread", id: s("id"), name: s("name") };
    case "pr":
      return { tagKind: "pr", slug: s("slug"), number: Number(s("number")) };
    case "cite":
      return { tagKind: "cite", id: s("id") };
    default:
      return { tagKind: "image", id: s("id"), name: s("name") };
  }
}

/** The draft (draftKey) the tags belong to (image chips look their attachment up by id). */
export const TagDraftContext = createContext("");

/** The draft has more than one project: a file tag's tooltip names its project. */
export const TagMultiProjectContext = createContext(false);
