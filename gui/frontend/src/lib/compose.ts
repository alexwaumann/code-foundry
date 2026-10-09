/**
 * Pure pieces of the new-thread composer: picker options, attachment checks, and the
 * session.new args a draft turns into. The store (stores/compose.ts) and components
 * (components/compose) use these; they hold no state.
 */
import type { PermissionModeView } from "@/api/session";

export interface Choice {
  value: string;
  label: string;
}

/** session.new `model` values with the names the composer shows. */
export const MODEL_CHOICES: readonly Choice[] = [
  { value: "fable", label: "Fable 5.1" },
  { value: "opus", label: "Opus 5.5" },
  { value: "sonnet", label: "Sonnet 5.5" },
  { value: "haiku", label: "Haiku 5.5" },
];

export const EFFORT_CHOICES: readonly Choice[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export type ComposePermission = Exclude<PermissionModeView, "">;

/** session.new `permission` values. Full access (bypassPermissions) is never offered. */
export const PERMISSION_CHOICES: readonly (Choice & { value: ComposePermission; hint: string })[] = [
  { value: "supervised", label: "Supervised", hint: "Confirm every tool call" },
  { value: "accept-edits", label: "Accept edits", hint: "File edits run; the rest asks" },
  { value: "auto", label: "Auto", hint: "Claude's classifier decides" },
];

export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_PERMISSION: ComposePermission = "auto";

export function choiceLabel(choices: readonly Choice[], value: string): string {
  return choices.find((c) => c.value === value)?.label ?? value;
}

/** A settings default if it is one of the choices, else the fallback. */
export function pickDefault(choices: readonly Choice[], setting: string | undefined, fallback: string): string {
  return setting && choices.some((c) => c.value === setting) ? setting : fallback;
}

/** Where the thread runs: a worktree session.new creates, or an existing one (the main one is the current checkout). */
export type WorktreeChoice = { kind: "new" } | { kind: "existing"; path: string };

export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_TYPE_NAMES = "PNG, JPEG, GIF or WebP";

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

/**
 * Splits dropped/pasted/picked files into the ones to attach and one message per
 * rejection (wrong type, too big, over the count cap).
 */
export function checkAttachments<F extends FileLike>(
  files: readonly F[],
  existing: number,
  opts: { types: readonly string[]; maxBytes: number; max?: number },
): { accepted: F[]; rejected: string[] } {
  const max = opts.max ?? MAX_ATTACHMENTS;
  const accepted: F[] = [];
  const rejected: string[] = [];
  let over = 0;
  for (const f of files) {
    const name = f.name || "pasted image";
    if (!opts.types.includes(f.type)) rejected.push(`${name}: not a ${ATTACHMENT_TYPE_NAMES} image`);
    else if (f.size > opts.maxBytes) rejected.push(`${name}: larger than ${String(Math.round(opts.maxBytes / (1024 * 1024)))} MB`);
    else if (existing + accepted.length >= max) over++;
    else accepted.push(f);
  }
  if (over > 0) rejected.push(`At most ${String(max)} images per thread; ${String(over)} not attached`);
  return { accepted, rejected };
}

export interface DraftArgsInput {
  text: string;
  model: string;
  effort: string;
  permission: string;
  worktree: WorktreeChoice;
  /** Base ref for a new worktree; "" lets the daemon pick (origin/<default branch>). */
  base: string;
}

/**
 * session.new's args for a draft. Empty values are omitted so the daemon applies its
 * defaults; `worktree` is the path for an existing worktree, `new-worktree` + `base`
 * otherwise.
 */
export function sessionNewArgs(repoId: string, d: DraftArgsInput, attachments: readonly string[]): Record<string, string> {
  const args: Record<string, string> = { repo: repoId };
  if (d.worktree.kind === "existing") args.worktree = d.worktree.path;
  else {
    args["new-worktree"] = "true";
    if (d.base) args.base = d.base;
  }
  if (d.model) args.model = d.model;
  if (d.effort) args.effort = d.effort;
  if (d.permission) args.permission = d.permission;
  const prompt = d.text.trim();
  if (prompt) args.prompt = prompt;
  if (attachments.length > 0) args.attachments = attachments.join(",");
  return args;
}

/** The session id in session.new's result JSON (the created Session), or null. */
export function createdSessionId(resultJson: string): string | null {
  if (!resultJson) return null;
  try {
    const v = JSON.parse(resultJson) as unknown;
    if (v && typeof v === "object" && "id" in v && typeof v.id === "string" && v.id) return v.id;
  } catch {
    // Not JSON: the daemon's focus intent still selects the thread.
  }
  return null;
}

/** Two-letter badge text for a project: initials of its first two words, else its first two letters. */
export function projectInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [a = "", b = ""] = words;
  const letters = words.length >= 2 ? (a[0] ?? "") + (b[0] ?? "") : a.slice(0, 2);
  return (letters || "?").toUpperCase();
}

/** Stable hue (0–359) for a project badge, hashed from its name. */
export function projectHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h) % 360;
}
