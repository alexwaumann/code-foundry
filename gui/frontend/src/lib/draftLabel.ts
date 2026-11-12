/**
 * A composer draft's label (docs/notes/shell-model.md, "The composer > Drafts"): its first line
 * of text as a reader sees it, tags by their labels ("/review", "main.go", "#12"), whitespace
 * collapsed, cut at DRAFT_LABEL_MAX characters with an ellipsis. "" while there is no text.
 * The sidebar's draft row and the draft's tab show it.
 */
import { parsePrompt, tagLabel } from "./prompt";

/** The longest label the GUI sends (the daemon keeps at most 80). */
export const DRAFT_LABEL_MAX = 60;

export function draftLabel(text: string): string {
  for (const line of parsePrompt(text)) {
    const plain = line
      .map((p) => (p.kind === "text" ? p.text : tagLabel(p)))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    return plain.length <= DRAFT_LABEL_MAX ? plain : `${plain.slice(0, DRAFT_LABEL_MAX - 1).trimEnd()}…`;
  }
  return "";
}
