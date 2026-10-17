/**
 * Pure pieces of the new-thread composer: picker options, attachment checks, and the
 * thread.new args a draft turns into. The store (stores/compose.ts) and components
 * (components/compose) use these; they hold no state.
 */
import type { PermissionModeView } from "@/api/threads";
import { retainRepoTags } from "./prompt";

export interface Choice {
  value: string;
  label: string;
}

export const EFFORT_CHOICES: readonly Choice[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export type ComposePermission = Exclude<PermissionModeView, "">;

/** thread.new `permission` values. Full access (bypassPermissions) is never offered. */
export const PERMISSION_CHOICES: readonly (Choice & { value: ComposePermission; hint: string })[] = [
  { value: "supervised", label: "Supervised", hint: "Confirm every tool call" },
  { value: "accept-edits", label: "Accept edits", hint: "File edits run; the rest asks" },
  { value: "auto", label: "Auto", hint: "Claude's classifier decides" },
];

export const DEFAULT_MODEL = "claude-opus-4-8[1m]";
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
 * Where the thread runs: a worktree thread.new creates, an existing one (the main one is
 * the current checkout), or, for a workspace, the workspace's own member worktrees.
 */
export type WorktreeChoice = { kind: "new" } | { kind: "existing"; path: string } | { kind: "members" };

/** A project's worktree choice (a workspace's "members" never applies to a project). */
export type ProjectWorktree = Exclude<WorktreeChoice, { kind: "members" }>;

/**
 * Where a project's new thread works by default (threads.default_worktree, and the
 * choice remembered per project): a fresh copy (a new worktree) or the project folder
 * itself (the main checkout).
 */
export type WorkInMode = "new" | "current";

export const WORK_IN_SETTING_KEY = "threads.default_worktree";

function workInMode(v: string | undefined): WorkInMode | undefined {
  return v === "new" || v === "current" ? v : undefined;
}

/**
 * A project draft's worktree before the user picks one: the choice remembered for the
 * project, else the setting, else a fresh copy. "current" is the main checkout, or a
 * fresh copy while the main checkout is not known.
 */
export function defaultWorktree(p: { setting?: string; remembered?: string; mainPath?: string }): ProjectWorktree {
  const mode = workInMode(p.remembered) ?? workInMode(p.setting) ?? "new";
  return mode === "current" && p.mainPath ? { kind: "existing", path: p.mainPath } : { kind: "new" };
}

/**
 * What picking a worktree teaches the project's default: a fresh copy or the main
 * checkout; null for another existing worktree (a one-off; the memory stays as it was).
 */
export function workInMemory(choice: ProjectWorktree, mainPath: string | undefined): WorkInMode | null {
  if (choice.kind === "new") return "new";
  return mainPath !== undefined && choice.path === mainPath ? "current" : null;
}

/**
 * The Work in pill's text. A project: "Fresh copy" (a new worktree), "In place" (the main
 * checkout, or the folder of a project without git), else the worktree's branch (its short
 * head when detached). A workspace keeps "Workspace worktrees" / "New worktree".
 */
export function workInText(p: {
  workspace: boolean;
  noGit: boolean;
  worktree: WorktreeChoice;
  chosen?: { isMain: boolean; branch: string; head: string };
}): string {
  if (p.workspace) return p.worktree.kind === "new" ? "New worktree" : "Workspace worktrees";
  if (p.noGit) return "In place";
  if (p.worktree.kind !== "existing" || !p.chosen) return "Fresh copy";
  return p.chosen.isMain ? "In place" : p.chosen.branch || p.chosen.head.slice(0, 7);
}

/**
 * What a composer starts a thread in: a project, a workspace and its members, or no
 * project at all (`home`: the thread runs in the daemon's home directory, thread.new
 * --no-project; docs/notes/no-project-2-gui.md).
 */
export type ComposeTarget = { kind: "project"; repoId: string } | { kind: "workspace"; workspaceId: string } | { kind: "home" };

const WORKSPACE_KEY = "ws:";

/** The draft key (and picker row value) of the no-project target. */
export const HOME_KEY = "home:";

/** The compose store's key for a target's draft: the repo id, "ws:<workspace id>", or HOME_KEY. */
export function draftKey(t: ComposeTarget): string {
  switch (t.kind) {
    case "project":
      return t.repoId;
    case "workspace":
      return WORKSPACE_KEY + t.workspaceId;
    case "home":
      return HOME_KEY;
  }
}

export function isWorkspaceKey(key: string): boolean {
  return key.startsWith(WORKSPACE_KEY);
}

/** The draft fields a move to another target rewrites (stores/compose.ts Draft has them all). */
export interface MovableDraft {
  /** The prompt with tag tokens (lib/prompt.ts). */
  text: string;
  /** null: the project's default (defaultWorktree). */
  worktree: WorktreeChoice | null;
  base: string | null;
  alsoIn: readonly string[];
  primary: string | null;
  error: string | null;
}

/**
 * A draft moved to another target (the composer heading's project switch). Carried
 * over: every field this does not name (text, attachments, model, effort, permission,
 * notice, phase). Reset: the worktree (a project's default, a workspace's "members"), the
 * base (it was one of the old primary's refs) and the error.
 *
 * Also in: the old project is dropped (never demoted to Also in); the new project leaves
 * Also in (a swap); a workspace, a project without git, or no project has none. The
 * primary stays only while it is still one of the moved draft's Also in projects.
 *
 * Tags: project skills and files of a project that is not a member of the moved draft
 * (the project and its Also in projects, `workspaceMembers` for a workspace target,
 * none without a project) leave the text (lib/prompt retainRepoTags); images and user
 * skills stay.
 */
export function movedDraft<D extends MovableDraft>(
  d: D,
  from: ComposeTarget,
  to: ComposeTarget,
  isGitRepo: (id: string) => boolean,
  workspaceMembers: readonly string[] = [],
): D {
  const dropped = new Set<string>();
  if (from.kind === "project") dropped.add(from.repoId);
  if (to.kind === "project") dropped.add(to.repoId);
  const alsoIn = to.kind !== "project" || !isGitRepo(to.repoId) ? [] : d.alsoIn.filter((id) => !dropped.has(id));
  const members = to.kind === "project" ? [to.repoId, ...alsoIn] : to.kind === "workspace" ? workspaceMembers : [];
  const primary = d.primary !== null && alsoIn.includes(d.primary) ? d.primary : null;
  return {
    ...d,
    text: retainRepoTags(d.text, members),
    worktree: to.kind === "workspace" ? { kind: "members" } : null,
    base: null,
    alsoIn,
    primary,
    error: null,
  };
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
 * members (none when it is gone). No project: none (primary ""). A primary that is not
 * among them falls back to the first.
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
  } else if (d.target.kind === "workspace") {
    repoIds = workspace ? workspace.members.map((m) => m.repoId) : [];
  } else {
    repoIds = [];
  }
  const primary = d.primary !== null && repoIds.includes(d.primary) ? d.primary : (repoIds[0] ?? "");
  return { repoIds, primary };
}

/**
 * Where thread.new starts the thread: in a project (a new or existing worktree, exactly
 * as before workspaces), in a workspace's member worktree (the thread belongs to the
 * workspace), or in a new workspace with a cf/<slug> worktree in every member (a
 * project with "Also in" projects, or a workspace in new-worktree mode), or without a
 * project in the home directory.
 */
export type ThreadPlace =
  | { kind: "project"; repoId: string; worktree: ProjectWorktree; base: string }
  | { kind: "workspace"; workspaceId: string; repoId: string; worktreePath: string }
  /** `base` applies to the primary member only ("" : every member's default). */
  | { kind: "new-workspace"; repoIds: readonly string[]; repoId: string; base: string }
  /** thread.new --no-project: no repo, worktree or workspace. */
  | { kind: "home" };

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
  if (d.target.kind === "home") return { kind: "home" };
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

/** The branch placeholder a new cf/<slug> worktree shows before its name exists. */
export const NEW_BRANCH = "cf/…";

/**
 * What a project's member chip shows in its branch slot: nothing (and the No git badge)
 * for a project without git, "cf/…" for a new worktree, else the chosen checkout's
 * branch (its short head when detached; "" when it is not known).
 */
export function projectChipBranch(p: { noGit: boolean; newWorktree: boolean; checkout?: { branch: string; head: string } }): { branch: string; noGit: boolean } {
  if (p.noGit) return { branch: "", noGit: true };
  if (p.newWorktree) return { branch: NEW_BRANCH, noGit: false };
  return { branch: p.checkout ? p.checkout.branch || p.checkout.head.slice(0, 7) : "", noGit: false };
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

/** The prompt and Claude options of a draft, as thread.new takes them. */
export interface PromptArgsInput {
  /** The prompt as Claude gets it (lib/prompt.ts projectPrompt). */
  text: string;
  /** The composer's text with its tag tokens (lib/userMessage sentComposerText): composer-prompt, for the thread's first message. */
  composerText?: string;
  model: string;
  effort: string;
  permission: string;
}

export interface DraftArgsInput extends PromptArgsInput {
  worktree: ProjectWorktree;
  /** Base ref for a new worktree; "" lets the daemon pick (origin/<default branch>, or the default branch without a remote). */
  base: string;
}

/** thread.new's args for a project draft (threadArgs with a project place). */
export function threadNewArgs(repoId: string, d: DraftArgsInput, attachments: readonly string[]): Record<string, string> {
  return threadArgs({ kind: "project", repoId, worktree: d.worktree, base: d.base }, d, attachments);
}

/**
 * thread.new's args for a thread. Empty values are omitted so the daemon applies its
 * defaults. A project: `worktree` is the path for an existing worktree, `new-worktree` +
 * `base` otherwise. A workspace: `workspace` and the member (`repo` + its `worktree`).
 * A new workspace: `new-worktree` + `repos`, the primary's own base as `<repo>:<base>`,
 * `repo` the member the thread runs in. No project: `no-project` alone (the daemon
 * refuses it beside any of the others).
 */
export function threadArgs(place: ThreadPlace, d: PromptArgsInput, attachments: readonly string[]): Record<string, string> {
  const args: Record<string, string> = place.kind === "home" ? { "no-project": "true" } : { repo: place.repoId };
  switch (place.kind) {
    case "home":
      break;
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
  // The thread keeps the composer's text on its first message to draw the tags
  // (only when it has any: without tags it is the prompt itself).
  const composer = d.composerText?.trim() ?? "";
  if (prompt && composer && composer !== prompt) args["composer-prompt"] = composer;
  if (attachments.length > 0) args.attachments = attachments.join(",");
  return args;
}

/** The thread id in thread.new's result JSON (the created Thread), or null. */
export function createdThreadId(resultJson: string): string | null {
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
