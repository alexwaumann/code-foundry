/**
 * The composer prompt's text model. The draft keeps the prompt as a plain string in which
 * each inline image chip is a Markdown image token pointing at a draft attachment:
 *
 *   Compare ![shot.png](cf-attachment://a3) with the current header
 *
 * The editor (components/compose/PromptEditor.tsx) parses the string into its document
 * and serializes it back on every edit; on send, projectPrompt turns each token into
 * `[Image: <name>; ref=<staged path>]` for Claude. Pure functions only.
 */

export const ATTACHMENT_SCHEME = "cf-attachment://";

export type PromptPiece = { kind: "text"; text: string } | { kind: "chip"; id: string; name: string };

const TOKEN = /!\[([^\]\n]*)\]\(cf-attachment:\/\/([A-Za-z0-9_-]+)\)/g;

/** A chip label safe inside the token and the projection: no brackets, semicolons or newlines. */
export function cleanLabel(name: string): string {
  return name.replace(/[[\];\r\n]+/g, " ").trim() || "image";
}

/** The token for an attachment chip. */
export function chipToken(id: string, name: string): string {
  return `![${cleanLabel(name)}](${ATTACHMENT_SCHEME}${id})`;
}

/** One line (no newlines) as text runs and chips. */
export function parseLine(line: string): PromptPiece[] {
  const out: PromptPiece[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push({ kind: "text", text: line.slice(last, m.index) });
    out.push({ kind: "chip", id: m[2] ?? "", name: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}

/** The prompt as lines of pieces (a line per editor paragraph). */
export function parsePrompt(text: string): PromptPiece[][] {
  return text.split("\n").map(parseLine);
}

/** The inverse of parsePrompt. */
export function serializePrompt(lines: readonly (readonly PromptPiece[])[]): string {
  return lines.map((pieces) => pieces.map((p) => (p.kind === "text" ? p.text : chipToken(p.id, p.name))).join("")).join("\n");
}

/** Attachment ids the prompt references, in order of first appearance. */
export function referencedIds(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[2] ?? ""))];
}

export function isReferenced(text: string, id: string): boolean {
  return referencedIds(text).includes(id);
}

/** The prompt without its chips: is there prose to put a chip into? */
export function proseOf(text: string): string {
  return text.replace(TOKEN, "");
}

/**
 * Removes every reference to an attachment, each with one adjacent space (the following
 * one, else the preceding one), and trims trailing whitespace.
 */
export function removeReferences(text: string, id: string): string {
  const matches = [...text.matchAll(TOKEN)].filter((m) => m[2] === id);
  let out = text;
  for (const m of matches.reverse()) {
    let start = m.index;
    let end = start + m[0].length;
    if (out[end] === " ") end++;
    else if (start > 0 && out[start - 1] === " ") start--;
    out = out.slice(0, start) + out.slice(end);
  }
  return matches.length > 0 ? out.trimEnd() : text;
}

/**
 * The prompt Claude gets: each chip becomes `[Image: <name>; ref=<ref>]` at its position
 * (ref is the staged path). A chip whose attachment is gone keeps only its name.
 */
export function projectPrompt(text: string, lookup: (id: string) => { name: string; ref: string } | undefined): string {
  return text.replace(TOKEN, (_m, label: string, id: string) => {
    const a = lookup(id);
    if (!a) return `[Image: ${cleanLabel(label)}]`;
    return `[Image: ${cleanLabel(a.name)}; ref=${a.ref}]`;
  });
}

/** "58 KB" below 1 MiB (at least 1 KB), else "1.4 MB". */
export function formatAttachmentSize(bytes: number): string {
  const MiB = 1024 * 1024;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  return `${String(Math.max(1, Math.ceil(bytes / 1024)))} KB`;
}

/** "a-very-long-screenshot-name….png": at most `max` characters, keeping up to `tail` at the end. */
export function middleTruncate(name: string, max = 36, tail = 14): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const end = Math.min(tail, max - 2);
  return `${chars.slice(0, max - 1 - end).join("")}…${chars.slice(chars.length - end).join("")}`;
}

/**
 * Where and what to insert for new chips, given the prompt (T3 Code's rule): chips go in
 * only when the prompt already has prose or a selection is being replaced; a leading
 * space when the previous character is not whitespace, always a trailing one.
 */
export function chipInsertText(tokens: readonly string[], before: string, opts: { hasProse: boolean; replacingSelection: boolean }): string | null {
  if (tokens.length === 0 || !(opts.hasProse || opts.replacingSelection)) return null;
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  return `${lead}${tokens.join(" ")} `;
}
