/**
 * A thread's user message as text and tags. When the composer sent it, the item
 * carries the composer's own text (UserMessageItem.composer_text): its tags are the
 * composer's tokens (lib/prompt.ts), with each attachment chip's id replaced by the
 * attachment's index in the message's attachments (sentComposerText). A chip is a PDF
 * (Claude got `[PDF: …]`) when its staged path ends in ".pdf" (the daemon names staged
 * files by their sniffed type), else its name does when the attachment is not known. The bubble draws chips from
 * those tokens only; a message without composer text (sent from the CLI) is plain text.
 * Nothing is guessed from the projected text Claude got. Pure.
 */
import { kindFromName, parsePrompt, type PromptPiece, type PromptTag, tagToken } from "./prompt";

export type MessagePiece =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string }
  | { kind: "file"; repoId: string; path: string }
  /** path "" when the chip lost its attachment before sending. */
  | { kind: "image"; name: string; path: string }
  | { kind: "pdf"; name: string; path: string };

/**
 * The composer text to store with a sent message: the draft's text with each image
 * chip's draft id replaced by its image's index in the sent attachments ("x" when the
 * chip's image is not among them), so the bubble can find the staged path again.
 */
export function sentComposerText(text: string, indexOf: (id: string) => number | undefined): string {
  return parsePrompt(text)
    .map((line) =>
      line
        .map((p) => {
          if (p.kind === "text") return p.text;
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
      return { kind: "file", repoId: tag.repoId, path: tag.path };
    case "image": {
      const i = /^\d+$/.test(tag.id) ? Number(tag.id) : -1;
      const path = attachments[i] ?? "";
      const name = tag.name.trim() || "image";
      return { kind: (path ? kindFromName(path) : kindFromName(name)) === "pdf" ? "pdf" : "image", name, path };
    }
  }
}

/** The message as text runs and tags, in order: tags from composerText's tokens only; text alone when there is none. */
export function parseUserMessage(text: string, composerText: string, attachments: readonly string[]): MessagePiece[] {
  if (!composerText) return text ? [{ kind: "text", text }] : [];
  const out: MessagePiece[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  parsePrompt(composerText).forEach((line: PromptPiece[], i) => {
    if (i > 0) pushText("\n");
    for (const p of line) {
      if (p.kind === "text") pushText(p.text);
      else out.push(tagPiece(p, attachments));
    }
  });
  return out;
}

/** The staged image and PDF paths the text refers to inline (the bubble shows the rest as tiles). */
export function inlineAttachmentPaths(pieces: readonly MessagePiece[]): Set<string> {
  return new Set(pieces.flatMap((p) => ((p.kind === "image" || p.kind === "pdf") && p.path ? [p.path] : [])));
}
