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

/**
 * Where the thread runs: a worktree session.new creates, an existing one (the main one is
 * the current checkout), or, for a workspace, the workspace's own member worktrees.
 */
export type WorktreeChoice = { kind: "new" } | { kind: "existing"; path: string } | { kind: "members" };

/** A project's worktree choice (a workspace's "members" never applies to a project). */
export type ProjectWorktree = Exclude<WorktreeChoice, { kind: "members" }>;

/** What a composer starts a thread in: a project, or a workspace and its members. */
export type ComposeTarget = { kind: "project"; repoId: string } | { kind: "workspace"; workspaceId: string };

const WORKSPACE_KEY = "ws:";

/** The compose store's key for a target's draft: the repo id, or "ws:<workspace id>". */
export function draftKey(t: ComposeTarget): string {
  return t.kind === "project" ? t.repoId : WORKSPACE_KEY + t.workspaceId;
}

export function isWorkspaceKey(key: string): boolean {
  return key.startsWith(WORKSPACE_KEY);
}

/** The draft fields that decide where a thread starts. */
export interface PlaceInput {
  target: ComposeTarget;
  worktree: WorktreeChoice;
  /** The base the user picked for the primary member; null: its default. */
  base: string | null;
  /** Other projects a project's thread also works in (a new workspace on send). */
  alsoIn: readonly string[];
  /** Repo id of the member the thread runs in; null: the project, or the workspace's first member. */
  primary: string | null;
}

export interface WorkspaceMembersInput {
  id: string;
  members: readonly { repoId: string; worktreePath: string }[];
}

/**
 * The repositories a draft's thread works in, in member order, and the one it runs in
 * (its cwd). A project: itself, then its registered "Also in" projects. A workspace: its
 * members (none when it is gone). A primary that is not among them falls back to the
 * first.
 */
export function draftMembers(
  d: Pick<PlaceInput, "target" | "alsoIn" | "primary">,
  workspace: WorkspaceMembersInput | undefined,
  isRepo: (id: string) => boolean,
): { repoIds: string[]; primary: string } {
  let repoIds: string[];
  if (d.target.kind === "project") {
    repoIds = [d.target.repoId];
    for (const id of d.alsoIn) if (isRepo(id) && !repoIds.includes(id)) repoIds.push(id);
  } else {
    repoIds = workspace ? workspace.members.map((m) => m.repoId) : [];
  }
  const primary = d.primary !== null && repoIds.includes(d.primary) ? d.primary : (repoIds[0] ?? "");
  return { repoIds, primary };
}

/**
 * Where session.new starts the thread: in a project (a new or existing worktree, exactly
 * as before workspaces), in a workspace's member worktree (the thread belongs to the
 * workspace), or in a new workspace with a cf/<slug> worktree in every member (a
 * project with "Also in" projects, or a workspace in new-worktree mode).
 */
export type ThreadPlace =
  | { kind: "project"; repoId: string; worktree: ProjectWorktree; base: string }
  | { kind: "workspace"; workspaceId: string; repoId: string; worktreePath: string }
  /** `base` applies to the primary member only ("" : every member's default). */
  | { kind: "new-workspace"; repoIds: readonly string[]; repoId: string; base: string };

export interface PlaceEnv {
  /** The target workspace; undefined when it is gone. */
  workspace?: WorkspaceMembersInput;
  isRepo: (id: string) => boolean;
  hasWorktree: (repoId: string, path: string) => boolean;
  /** The primary repository's default base (ListRefs.default_ref); "" when unknown. */
  defaultRef: string;
  /**
   * The one checkout of a project without git (its folder); undefined for a git project.
   * Such a project's thread always runs there: no new worktree, no Also in.
   */
  noGitCheckout?: (repoId: string) => string | undefined;
}

/** Where a draft's thread starts, or null when its workspace is gone or has no members. */
export function threadPlace(d: PlaceInput, env: PlaceEnv): ThreadPlace | null {
  const checkout = d.target.kind === "project" ? env.noGitCheckout?.(d.target.repoId) : undefined;
  if (d.target.kind === "project" && checkout !== undefined) {
    return { kind: "project", repoId: d.target.repoId, worktree: { kind: "existing", path: checkout }, base: "" };
  }
  const { repoIds, primary } = draftMembers(d, env.workspace, env.isRepo);
  if (d.target.kind === "project") {
    if (repoIds.length > 1) return { kind: "new-workspace", repoIds, repoId: primary, base: d.base ?? "" };
    const repoId = d.target.repoId;
    const worktree: ProjectWorktree = d.worktree.kind === "existing" && env.hasWorktree(repoId, d.worktree.path) ? d.worktree : { kind: "new" };
    return { kind: "project", repoId, worktree, base: d.base ?? env.defaultRef };
  }
  const member = env.workspace?.members.find((m) => m.repoId === primary);
  if (!env.workspace || !member) return null;
  if (d.worktree.kind === "new") return { kind: "new-workspace", repoIds, repoId: primary, base: d.base ?? "" };
  return { kind: "workspace", workspaceId: env.workspace.id, repoId: primary, worktreePath: member.worktreePath };
}

/**
 * The read-only branch indicator for an existing worktree or the current checkout:
 * `text` for the pill ("On main", "Detached at 3c3c465") and `label` for assistive tech
 * ("Current checkout is on main", "Worktree is detached at 3c3c465").
 */
export function checkoutBranch(w: { branch: string; head: string; detached: boolean; isMain: boolean }): { text: string; label: string } {
  const subject = w.isMain ? "Current checkout" : "Worktree";
  if (w.branch && !w.detached) return { text: `On ${w.branch}`, label: `${subject} is on ${w.branch}` };
  const short = w.head.slice(0, 7);
  if (short) return { text: `Detached at ${short}`, label: `${subject} is detached at ${short}` };
  return { text: "Detached HEAD", label: `${subject} has a detached HEAD` };
}

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

/** The prompt and Claude options of a draft, as session.new takes them. */
export interface PromptArgsInput {
  text: string;
  model: string;
  effort: string;
  permission: string;
}

export interface DraftArgsInput extends PromptArgsInput {
  worktree: ProjectWorktree;
  /** Base ref for a new worktree; "" lets the daemon pick (origin/<default branch>, or the default branch without a remote). */
  base: string;
}

/** session.new's args for a project draft (threadArgs with a project place). */
export function sessionNewArgs(repoId: string, d: DraftArgsInput, attachments: readonly string[]): Record<string, string> {
  return threadArgs({ kind: "project", repoId, worktree: d.worktree, base: d.base }, d, attachments);
}

/**
 * session.new's args for a thread. Empty values are omitted so the daemon applies its
 * defaults. A project: `worktree` is the path for an existing worktree, `new-worktree` +
 * `base` otherwise. A workspace: `workspace` and the member (`repo` + its `worktree`).
 * A new workspace: `new-worktree` + `repos`, the primary's own base as `<repo>:<base>`,
 * `repo` the member the thread runs in.
 */
export function threadArgs(place: ThreadPlace, d: PromptArgsInput, attachments: readonly string[]): Record<string, string> {
  const args: Record<string, string> = { repo: place.repoId };
  switch (place.kind) {
    case "project":
      if (place.worktree.kind === "existing") args.worktree = place.worktree.path;
      else {
        args["new-worktree"] = "true";
        if (place.base) args.base = place.base;
      }
      break;
    case "workspace":
      args.workspace = place.workspaceId;
      args.worktree = place.worktreePath;
      break;
    case "new-workspace":
      args["new-worktree"] = "true";
      args.repos = place.repoIds.map((id) => (id === place.repoId && place.base ? `${id}:${place.base}` : id)).join(",");
      break;
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

/**
 * The project picker's subtitle source: "No git" for a project without git, "Local only"
 * without remotes, else the GitHub slug or the remote's name.
 */
export function repoSource(r: { githubSlug: string; remotes: readonly string[]; git?: boolean }): string {
  if (r.git === false) return "No git";
  if (r.remotes.length === 0) return "Local only";
  return r.githubSlug || (r.remotes.includes("origin") ? "origin" : (r.remotes[0] ?? ""));
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
