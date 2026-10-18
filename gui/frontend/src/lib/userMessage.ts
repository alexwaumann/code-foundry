/**
 * A thread's user message as text and tags. When the composer sent it, the item
 * carries the composer's own text (UserMessageItem.composer_text): its tags are the
 * composer's tokens (lib/prompt.ts), with each attachment chip's id replaced by the
 * attachment's index in the message's attachments (sentComposerText). A chip is a PDF
 * (Claude got `[PDF: …]`) when its staged path ends in ".pdf" (the daemon names staged
 * files by their sniffed type), else its name does when the attachment is not known. The bubble draws chips from
 * those tokens only; a message without composer text (sent from the CLI) is plain text.
 * Nothing is guessed from the projected text Claude got, with one exception: a citation
 * is sent as its self-contained link (lib/citation.ts) in both texts, so its chip is read
 * from the link wherever it is, a message without composer text included. Pure.
 */
import { citeLink, splitCiteLinks, type CitationBody } from "./citation";
import { kindFromName, parsePrompt, type PromptPiece, type PromptTag, tagToken } from "./prompt";

export type MessagePiece =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string }
  | { kind: "file"; projectId: string; path: string }
  /** name: the thread's name when the tag was inserted (the bubble shows the current one when known). */
  | { kind: "thread"; id: string; name: string }
  | { kind: "pr"; slug: string; number: number }
  /** Text quoted from one of Claude's answers, with the user's comment. */
  | { kind: "cite"; cite: CitationBody }
  /** path "" when the chip lost its attachment before sending. */
  | { kind: "image"; name: string; path: string }
  | { kind: "pdf"; name: string; path: string };

/**
 * The composer text to store with a sent message: the draft's text with each image
 * chip's draft id replaced by its image's index in the sent attachments ("x" when the
 * chip's image is not among them), so the bubble can find the staged path again; each
 * citation token replaced by its link (lib/citation.ts citeLink; dropped when `cite`
 * does not know it, as the projection drops it).
 */
export function sentComposerText(text: string, indexOf: (id: string) => number | undefined, cite: (id: string) => CitationBody | undefined = () => undefined): string {
  return parsePrompt(text)
    .map((line) =>
      line
        .map((p) => {
          if (p.kind === "text") return p.text;
          if (p.tagKind === "cite") {
            const c = cite(p.id);
            return c ? citeLink(c) : "";
          }
          if (p.tagKind !== "image") return tagToken(p);
          const i = indexOf(p.id);
          return tagToken({ ...p, id: i === undefined || i < 0 ? "x" : String(i) });
        })
        .join(""),
    )
    .join("\n");
}

function tagPiece(tag: PromptTag, attachments: readonly string[]): MessagePiece {
  switch (tag.tagKind) {
    case "skill":
      return { kind: "skill", name: tag.name };
    case "file":
      return { kind: "file", projectId: tag.projectId, path: tag.path };
    case "thread":
      return { kind: "thread", id: tag.id, name: tag.name };
    case "pr":
      return { kind: "pr", slug: tag.slug, number: tag.number };
    case "cite":
      // A draft token in stored composer text (not sent through sentComposerText): no body.
      return { kind: "text", text: "" };
    case "image": {
      const i = /^\d+$/.test(tag.id) ? Number(tag.id) : -1;
      const path = attachments[i] ?? "";
      const name = tag.name.trim() || "image";
      return { kind: (path ? kindFromName(path) : kindFromName(name)) === "pdf" ? "pdf" : "image", name, path };
    }
  }
}

/**
 * The message as text runs and tags, in order: tags from composerText's tokens only, and
 * citations from their links in either text; text alone when there is no composer text.
 */
export function parseUserMessage(text: string, composerText: string, attachments: readonly string[]): MessagePiece[] {
  const out: MessagePiece[] = [];
  const pushRaw = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  const pushText = (t: string) => {
    for (const p of splitCiteLinks(t)) {
      if (p.kind === "text") pushRaw(p.text);
      else out.push(p);
    }
  };
  if (!composerText) {
    pushText(text);
    return out;
  }
  // Text runs are joined first: a link is never split by a tag, but lines are.
  let run = "";
  parsePrompt(composerText).forEach((line: PromptPiece[], i) => {
    if (i > 0) run += "\n";
    for (const p of line) {
      if (p.kind === "text") {
        run += p.text;
        continue;
      }
      pushText(run);
      run = "";
      const piece = tagPiece(p, attachments);
      if (piece.kind === "text") pushRaw(piece.text);
      else out.push(piece);
    }
  });
  pushText(run);
  return out;
}

/** The staged image and PDF paths the text refers to inline (the bubble shows the rest as tiles). */
export function inlineAttachmentPaths(pieces: readonly MessagePiece[]): Set<string> {
  return new Set(pieces.flatMap((p) => ((p.kind === "image" || p.kind === "pdf") && p.path ? [p.path] : [])));
}
