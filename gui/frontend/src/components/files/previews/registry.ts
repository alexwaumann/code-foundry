/**
 * The File tab's preview kinds (types.ts PreviewKind): every module under `kinds/` whose
 * default export is a kind, found at build time, so a new preview is a new file there and
 * nothing else changes. Which kind a file is does not depend on the order they load in:
 * an extension beats an exact mime, which beats a wildcard mime ("image/*"), which beats a
 * sniff of the text; two kinds claiming the same extension or exact mime is an error
 * (registryProblems, checked by registry.test.ts). Pure but for the glob.
 */
import type { FileReadView } from "@/api/files";
import { extOf } from "@/lib/filePath";
import { SOURCE, type PreviewKind, type PreviewMode } from "./types";

const modules = import.meta.glob<{ default: PreviewKind }>(["./kinds/*.{ts,tsx}", "!./kinds/*.test.{ts,tsx}"], { eager: true });

/** Every registered kind, by id. */
export const PREVIEW_KINDS: readonly PreviewKind[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.id.localeCompare(b.id));

/** "text/markdown; charset=utf-8" → "text/markdown". */
function bareMime(mime: string): string {
  const i = mime.indexOf(";");
  return (i < 0 ? mime : mime.slice(0, i)).trim().toLowerCase();
}

const wildcardHit = (pattern: string, mime: string) => pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1));

/** Whether `kind` can show this read (PreviewKind.shows; default: it has text). */
export function previewShows(kind: PreviewKind, file: FileReadView): boolean {
  return kind.shows ? kind.shows(file) : file.text !== null;
}

/**
 * The kind a file is shown as, or null for the code view (or binary). With no read yet
 * (`file` null), only the extension counts: that is the kind whose `read` reads it. With a
 * read, a kind that cannot show it (previewShows) gives way to the next match.
 */
export function previewKindOf(path: string, file: FileReadView | null, kinds: readonly PreviewKind[] = PREVIEW_KINDS): PreviewKind | null {
  const ext = extOf(path);
  const mime = file ? bareMime(file.mime) : "";
  const text = file?.text ?? null;
  const tiers: ((k: PreviewKind) => boolean)[] = [(k) => ext !== "" && (k.match.ext?.includes(ext) ?? false)];
  if (file) {
    tiers.push(
      (k) => mime !== "" && (k.match.mime?.includes(mime) ?? false),
      (k) => mime !== "" && (k.match.mime?.some((m) => wildcardHit(m, mime)) ?? false),
      (k) => text !== null && (k.match.sniff?.(text) ?? false),
    );
  }
  for (const tier of tiers) {
    const hit = kinds.find((k) => tier(k) && (!file || previewShows(k, file)));
    if (hit) return hit;
  }
  return null;
}

/** The kind's switch for this read: its preview modes, then Source when the read has text. One choice means no switch. */
export function previewModes(kind: PreviewKind, file: FileReadView): readonly PreviewMode[] {
  return file.text === null ? kind.modes : [...kind.modes, SOURCE];
}

/** The mode a file opens in: the remembered one when this read offers it, else the kind's first. */
export function pickMode(modes: readonly PreviewMode[], remembered: string | undefined): string {
  return modes.find((m) => m.id === remembered)?.id ?? modes[0]?.id ?? SOURCE.id;
}

/** What is wrong with a set of kinds: a repeated id, an extension or exact mime claimed twice, a mode called "source", no modes. */
export function registryProblems(kinds: readonly PreviewKind[]): string[] {
  const problems: string[] = [];
  const claim = (seen: Map<string, string>, what: string, id: string) => {
    const other = seen.get(what);
    if (other !== undefined && other !== id) problems.push(`${what} is claimed by ${other} and ${id}`);
    seen.set(what, id);
  };
  const ids = new Map<string, string>();
  const exts = new Map<string, string>();
  const mimes = new Map<string, string>();
  for (const k of kinds) {
    if (ids.has(k.id)) problems.push(`id ${k.id} is used twice`);
    ids.set(k.id, k.id);
    for (const e of k.match.ext ?? []) claim(exts, `.${e}`, k.id);
    for (const m of k.match.mime ?? []) claim(mimes, m, k.id);
    if (k.modes.some((m) => m.id === SOURCE.id)) problems.push(`${k.id} lists Source itself`);
    if (k.modes.length === 0) problems.push(`${k.id} has no modes`);
  }
  return problems;
}
