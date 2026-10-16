/**
 * The composer prompt's text model. The draft keeps the prompt as a plain string in which
 * each inline tag is a Markdown-link token:
 *
 *   image  ![shot.png](cf-attachment://a3)            a draft attachment (an image or a PDF), by id
 *   skill  [/deploy](cf-skill://~/deploy)              a user skill (~/.claude)
 *          [/deploy](cf-skill://<repoId>/deploy)       a project skill (the project's .claude)
 *   file   [Composer.tsx](cf-file://<repoId>/src/components/Composer.tsx)
 *          a project file or directory (ending in "/"), path segments percent-encoded
 *
 * The editor (components/compose/PromptEditor.tsx) parses the string into its document
 * and serializes it back on every edit; on send, projectPrompt turns each token into what
 * Claude gets: `[Image: <name>; ref=<staged path>]` (`[PDF: …]` for a PDF), `/<skill>`, or `@cf-file://…` (the
 * daemon resolves that to the thread's worktree; docs/notes/composer-tags-1-daemon.md).
 * Skill and file labels are derived from the URL, never read back from the token. Pure
 * functions only.
 */

export const ATTACHMENT_SCHEME = "cf-attachment://";
export const SKILL_SCHEME = "cf-skill://";
export const FILE_SCHEME = "cf-file://";
/** The repo slot of a user-scope skill token. */
const USER_SCOPE = "~";

/** What an inline tag refers to. */
export type PromptTag =
  | { tagKind: "image"; id: string; name: string }
  /** repoId "" for a user skill. */
  | { tagKind: "skill"; name: string; repoId: string }
  /** path is relative to the checkout, "/"-separated, a directory's ending in "/". */
  | { tagKind: "file"; repoId: string; path: string };

export type TagKind = PromptTag["tagKind"];

export type PromptPiece = { kind: "text"; text: string } | ({ kind: "tag" } & PromptTag);

// Groups: 1 image label, 2 attachment id | 3 label, 4 skill|file, 5 repo slot, 6 the rest.
// Labels exclude "[" (tokens never have one), so an unclosed "[" typed before a tag stays text.
const TOKEN = /!\[([^[\]\n]*)\]\(cf-attachment:\/\/([A-Za-z0-9_-]+)\)|\[([^[\]\n]*)\]\(cf-(skill|file):\/\/([A-Za-z0-9_.~-]+)\/([^\s()]+)\)/g;

/** A chip label safe inside the token and the projection: no brackets, semicolons or newlines. */
export function cleanLabel(name: string): string {
  return name.replace(/[[\];\r\n]+/g, " ").trim() || "image";
}

/** Percent-encodes one path segment or skill name, including the characters that would end a token. */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
}

/** A relative path with each segment encoded ("/" kept, so a directory's trailing "/" stays). */
export function encodeTagPath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The text a tag shows: the image name, `/skill`, or a file's base name (a directory's with "/"). */
export function tagLabel(tag: PromptTag): string {
  switch (tag.tagKind) {
    case "image":
      return cleanLabel(tag.name);
    case "skill":
      return `/${tag.name}`;
    case "file": {
      const dir = tag.path.endsWith("/");
      const trimmed = dir ? tag.path.slice(0, -1) : tag.path;
      return `${trimmed.slice(trimmed.lastIndexOf("/") + 1)}${dir ? "/" : ""}`;
    }
  }
}

/** A label inside `[…]`: brackets and newlines would end it early. */
function linkLabel(s: string): string {
  return s.replace(/[[\]\r\n]+/g, " ");
}

/** The token for a tag. */
export function tagToken(tag: PromptTag): string {
  switch (tag.tagKind) {
    case "image":
      return `![${cleanLabel(tag.name)}](${ATTACHMENT_SCHEME}${tag.id})`;
    case "skill":
      return `[${linkLabel(tagLabel(tag))}](${SKILL_SCHEME}${tag.repoId || USER_SCOPE}/${encodeSegment(tag.name)})`;
    case "file":
      return `[${linkLabel(tagLabel(tag))}](${FILE_SCHEME}${tag.repoId}/${encodeTagPath(tag.path)})`;
  }
}

/** The token for an attachment chip. */
export function chipToken(id: string, name: string): string {
  return tagToken({ tagKind: "image", id, name });
}

/** The tag a token match stands for, or null when it does not decode. */
function matchTag(m: RegExpExecArray): PromptTag | null {
  if (m[2] !== undefined) return { tagKind: "image", id: m[2], name: m[1] ?? "" };
  const slot = m[5] ?? "";
  const rest = decode(m[6] ?? "");
  if (rest === null || rest === "") return null;
  if (m[4] === "skill") {
    if (rest.includes("/")) return null;
    return { tagKind: "skill", name: rest, repoId: slot === USER_SCOPE ? "" : slot };
  }
  if (slot === USER_SCOPE) return null;
  return { tagKind: "file", repoId: slot, path: rest };
}

/** Every well-formed token of the text with its tag, in order. */
function tokens(text: string): { m: RegExpExecArray; tag: PromptTag }[] {
  const out: { m: RegExpExecArray; tag: PromptTag }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const tag = matchTag(m);
    if (tag) out.push({ m, tag });
  }
  return out;
}

/** One line (no newlines) as text runs and tags. */
export function parseLine(line: string): PromptPiece[] {
  const out: PromptPiece[] = [];
  let last = 0;
  for (const { m, tag } of tokens(line)) {
    if (m.index > last) out.push({ kind: "text", text: line.slice(last, m.index) });
    out.push({ kind: "tag", ...tag });
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
  return lines.map((pieces) => pieces.map((p) => (p.kind === "text" ? p.text : tagToken(p))).join("")).join("\n");
}

/** Attachment ids the prompt references, in order of first appearance. */
export function referencedIds(text: string): string[] {
  return [...new Set(tokens(text).flatMap(({ tag }) => (tag.tagKind === "image" ? [tag.id] : [])))];
}

export function isReferenced(text: string, id: string): boolean {
  return referencedIds(text).includes(id);
}

/** The prompt without its image chips: is there prose to put a chip into? */
export function proseOf(text: string): string {
  let out = "";
  let last = 0;
  for (const { m, tag } of tokens(text)) {
    if (tag.tagKind !== "image") continue;
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/**
 * Removes every tag `drop` picks, each with one adjacent space (the following one, else
 * the preceding one), and trims trailing whitespace when anything was removed.
 */
function removeTags(text: string, drop: (tag: PromptTag) => boolean): string {
  const matches = tokens(text).filter(({ tag }) => drop(tag));
  let out = text;
  for (const { m } of matches.reverse()) {
    let start = m.index;
    let end = start + m[0].length;
    if (out[end] === " ") end++;
    else if (start > 0 && out[start - 1] === " ") start--;
    out = out.slice(0, start) + out.slice(end);
  }
  return matches.length > 0 ? out.trimEnd() : text;
}

/**
 * Removes every reference to an attachment, each with one adjacent space (the following
 * one, else the preceding one), and trims trailing whitespace.
 */
export function removeReferences(text: string, id: string): string {
  return removeTags(text, (t) => t.tagKind === "image" && t.id === id);
}

/** The project a tag belongs to: a project skill's or a file's repo; "" for images and user skills. */
export function tagRepo(tag: PromptTag): string {
  return tag.tagKind === "image" ? "" : tag.repoId;
}

/**
 * Repo ids the prompt's project-scoped tags (project skills, files) refer to, in order of
 * first appearance: what a change of the draft's projects has to look at.
 */
export function tagsByRepo(text: string): string[] {
  return [...new Set(tokens(text).flatMap(({ tag }) => (tagRepo(tag) ? [tagRepo(tag)] : [])))];
}

/** How many project-scoped tags refer to the repo. */
export function repoTagCount(text: string, repoId: string): number {
  return tokens(text).filter(({ tag }) => tagRepo(tag) === repoId).length;
}

/** Removes every project-scoped tag of a repo (removeReferences' spacing rules). */
export function removeRepoTags(text: string, repoId: string): string {
  return removeTags(text, (t) => tagRepo(t) === repoId);
}

/**
 * Keeps only the project-scoped tags whose repo is one of `repoIds` (for a draft moved to
 * other projects); the rest go, with removeReferences' spacing rules. Images and user
 * skills always stay.
 */
export function retainRepoTags(text: string, repoIds: readonly string[]): string {
  return removeTags(text, (t) => tagRepo(t) !== "" && !repoIds.includes(tagRepo(t)));
}

/** A chip's attachment kind when only its name is known (the attachment is gone): a ".pdf" name is a PDF. */
export function kindFromName(name: string): "image" | "pdf" {
  return /\.pdf$/i.test(name.trim()) ? "pdf" : "image";
}

/**
 * The prompt Claude gets. An attachment chip becomes `[Image: <name>; ref=<ref>]`, or
 * `[PDF: <name>; ref=<ref>]` for a PDF, at its position (ref is the staged path; a chip
 * whose attachment is gone keeps only its name, its kind guessed from the name).
 * A skill becomes `/<name>`, a file `@cf-file://<repoId>/<encoded path>`; a space is put
 * after either when anything but whitespace follows, because a slash command and the
 * daemon's file reference both end at whitespace.
 */
export function projectPrompt(text: string, lookup: (id: string) => { name: string; ref: string; kind: "image" | "pdf" } | undefined): string {
  let out = "";
  let last = 0;
  for (const { m, tag } of tokens(text)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const next = text.charAt(last);
    const gap = next !== "" && !/\s/.test(next) ? " " : "";
    switch (tag.tagKind) {
      case "image": {
        const a = lookup(tag.id);
        const label = (a?.kind ?? kindFromName(tag.name)) === "pdf" ? "PDF" : "Image";
        out += a ? `[${label}: ${cleanLabel(a.name)}; ref=${a.ref}]` : `[${label}: ${cleanLabel(tag.name)}]`;
        break;
      }
      case "skill":
        out += `/${tag.name}${gap}`;
        break;
      case "file":
        out += `@${FILE_SCHEME}${tag.repoId}/${encodeTagPath(tag.path)}${gap}`;
        break;
    }
  }
  return out + text.slice(last);
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
