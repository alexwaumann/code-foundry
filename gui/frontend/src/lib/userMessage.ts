/**
 * A rendered thread's user message as text and tags. The daemon stores what the composer
 * sent: its tokens already projected for Claude (lib/prompt.ts projectPrompt), so a skill
 * is "/name", a file "@cf-file://<repo>/<encoded path>" and an image chip
 * "[Image: <name>; ref=<staged path>]". This reads them back into the composer's tags so
 * the bubble shows the same chips (purple skill, blue file, green image). Skills are
 * recognised by shape: a "/name" word (one segment, starting with a letter) at the start
 * or after whitespace, followed by whitespace or the end. Pure.
 */
import { FILE_SCHEME } from "./prompt";

export type MessagePiece =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string }
  | { kind: "file"; repoId: string; path: string }
  /** path "" when the chip lost its attachment before sending. */
  | { kind: "image"; name: string; path: string };

const IMAGE = String.raw`\[Image: ([^;\]\n]*)(?:; ref=([^\]\n]+))?\]`;
const FILE = String.raw`@${FILE_SCHEME.replace(/[/]/g, "\\/")}([A-Za-z0-9_.~-]+)\/(\S+)`;
const SKILL = String.raw`(?<=^|\s)\/([A-Za-z][\w-]*(?::[\w-]+)?)(?=\s|$)`;
const PIECES = new RegExp(`${IMAGE}|${FILE}|${SKILL}`, "g");

function decodePath(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The message as text runs and tags, in order. */
export function parseUserMessage(text: string): MessagePiece[] {
  const out: MessagePiece[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(PIECES)) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      out.push({ kind: "image", name: m[1].trim() || "image", path: (m[2] ?? "").trim() });
    } else if (m[3] !== undefined) {
      const path = decodePath(m[4] ?? "");
      if (path) out.push({ kind: "file", repoId: m[3], path });
      else pushText(m[0]);
    } else {
      out.push({ kind: "skill", name: m[5] ?? "" });
    }
  }
  pushText(text.slice(last));
  return out;
}

/** The staged image paths the text refers to inline. */
export function inlineImagePaths(pieces: readonly MessagePiece[]): Set<string> {
  return new Set(pieces.flatMap((p) => (p.kind === "image" && p.path ? [p.path] : [])));
}
