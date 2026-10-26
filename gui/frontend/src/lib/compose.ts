/**
 * Pure pieces of the new-thread composer: picker options, attachment checks, and the
 * thread.new args a draft turns into. The store (stores/compose.ts) and components
 * (components/compose) use these; they hold no state.
 */
import type { PermissionModeView } from "@/api/threads";
import { retainProjectTags } from "./prompt";

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
  { value: "supervised", label: "Supervised", hint: "Edits and commands ask; reads run" },
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
 * Where the thread runs: a worktree thread.new creates on a new branch ("new"), the
 * worktree of an existing branch (`branch`: the daemon reuses the branch's worktree or
 * makes one; in a set, every git project's), an existing worktree by path (the sidebar's
 * "+" on a worktree row; the main one is the current checkout), or the projects' own
 * checkouts ("current": in place, whichever projects the draft has; a single project's is
 * its main checkout).
 */
export type WorktreeChoice = { kind: "new" } | { kind: "branch"; name: string } | { kind: "existing"; path: string } | { kind: "current" };

/** A single project's worktree choice once resolved ("current" is its main checkout). */
export type ProjectWorktree = Exclude<WorktreeChoice, { kind: "current" }>;

/**
 * Where a project's new thread works by default (threads.default_worktree): a fresh copy
 * (a new worktree) or the project folder itself (the main checkout).
 */
export type WorkInMode = "new" | "current";

export const WORK_IN_SETTING_KEY = "threads.default_worktree";

function workInMode(v: string | undefined): WorkInMode | undefined {
  return v === "new" || v === "current" ? v : undefined;
}

/**
 * A project draft's worktree before the user picks one: the setting, else the project
 * folder itself (the daemon's default for threads.default_worktree). "current" is the
 * main checkout, or a fresh copy while the main checkout is not known. A pick in the Work
 * in picker applies to its draft only (docs/notes/work-in-draft-only.md).
 */
export function defaultWorktree(p: { setting?: string; mainPath?: string }): ProjectWorktree {
  const mode = workInMode(p.setting) ?? "current";
  return mode === "current" && p.mainPath ? { kind: "existing", path: p.mainPath } : { kind: "new" };
}

/**
 * A set's mode (more than one project, or a workspace): worktrees on one branch ("new": a
 * new branch, or an existing one picked by name) or every project's own checkout
 * ("current"). The draft's pick (any existing worktree path counts as in place), else the
 * setting, else in place. Always in place for a set
 * without a git project (`hasGit` false: plain folders only, or a workspace without
 * projects): there is nothing to make a worktree of.
 */
export function setWorkIn(choice: WorktreeChoice | null, setting: string | undefined, hasGit = true): WorkInMode {
  if (!hasGit) return "current";
  if (choice) return choice.kind === "new" || choice.kind === "branch" ? "new" : "current";
  return workInMode(setting) ?? "current";
}

/**
 * The Work in pill's text, which is also its option's title in the picker. A picked
 * existing branch: its name, for a project or a set. A project: "Fresh copy" (a new
 * worktree), "Project folder" (the main checkout, or the folder of a project without
 * git), else the worktree's branch (its short head when detached). A set: the same words,
 * plural when it has more than one project (`many`).
 */
export function workInText(p: {
  set: boolean;
  /** A set of more than one project: plural titles. */
  many?: boolean;
  noGit: boolean;
  worktree: WorktreeChoice;
  chosen?: { isMain: boolean; branch: string; head: string };
}): string {
  if (p.worktree.kind === "branch" && !p.noGit) return p.worktree.name;
  if (p.set) return p.worktree.kind === "new" ? (p.many ? FRESH_COPIES : FRESH_COPY) : p.many ? PROJECT_FOLDERS : PROJECT_FOLDER;
  if (p.noGit) return PROJECT_FOLDER;
  if (p.worktree.kind !== "existing" || !p.chosen) return FRESH_COPY;
  return p.chosen.isMain ? PROJECT_FOLDER : p.chosen.branch || p.chosen.head.slice(0, 7);
}

/** The Work in choices' titles: the pill and the picker option show the same words. */
export const FRESH_COPY = "Fresh copy";
export const PROJECT_FOLDER = "Project folder";
export const FRESH_COPIES = "Fresh copies";
export const PROJECT_FOLDERS = "Project folders";

/**
 * Work in's existing branches: every git project's ListRefs.branches (each newest commit
 * first) merged by name, position by position in request order, so the newest of every
 * project come first, minus every project's default branch (`defaults`: Project
 * folder(s) is the way to work on it, and the daemon refuses a worktree on a branch a
 * main checkout has). Stable for the same lists.
 */
export function mergedBranches(lists: readonly (readonly string[])[], defaults: readonly string[] = []): string[] {
  const seen = new Set<string>(defaults);
  const out: string[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) {
      const b = l[i];
      if (b !== undefined && !seen.has(b)) {
        seen.add(b);
        out.push(b);
      }
    }
  }
  return out;
}

/**
 * Branch from's branches: the names every git project has (`lists`, one ListRefs.branches
 * each), in the first one's (recency) order, minus every project's default branch (the
 * picker's first row stands for those).
 */
export function commonBranches(lists: readonly (readonly string[])[], defaults: readonly string[]): string[] {
  const [first = [], ...rest] = lists;
  const others = rest.map((l) => new Set(l));
  return first.filter((b) => !defaults.includes(b) && others.every((o) => o.has(b)));
}

/** Branch from's first row: each project's default branch. */
export function defaultBranchLabel(many: boolean): string {
  return many ? "Default branches" : "Default branch";
}

/** The Branch from pill: the picked branch, else the default branch(es). */
export function baseText(base: string, many: boolean): string {
  return base ? `From ${base}` : many ? "From defaults" : "From default";
}

/** Branch from's footer while projects.base_from_origin is on (the rule, docs/notes/base-origin-rule.md). */
export function baseRuleText(many: boolean): string {
  return many ? "Each project takes origin's copy of the branch, or its own when that is ahead." : "The project takes origin's copy of the branch, or its own when that is ahead.";
}

export const BASE_FROM_ORIGIN_KEY = "projects.base_from_origin";

/**
 * What a composer starts a thread in: a project (and whatever the user adds to its set),
 * a workspace and its members, the set of an existing thread (`like`: "New thread on this
 * branch", thread.new-like), or no project at all (`home`: the thread runs in the
 * daemon's home directory, thread.new --no-project; docs/notes/no-project-2-gui.md).
 */
export type ComposeTarget =
  | { kind: "project"; projectId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "like"; threadId: string }
  | { kind: "home" };

const WORKSPACE_KEY = "ws:";
const LIKE_KEY = "like:";

/** The draft key (and picker row value) of the no-project target. */
export const HOME_KEY = "home:";

/** The compose store's key for a target's draft: the project id, "ws:<workspace id>", "like:<thread id>", or HOME_KEY. */
export function draftKey(t: ComposeTarget): string {
  switch (t.kind) {
    case "project":
      return t.projectId;
    case "workspace":
      return WORKSPACE_KEY + t.workspaceId;
    case "like":
      return LIKE_KEY + t.threadId;
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
  /** null: the default (defaultWorktree, setWorkIn). */
  worktree: WorktreeChoice | null;
  base: string | null;
  /** The picked projects (lib/projectSet SetChoice); null: the target's. */
  projects: readonly string[] | null;
  workspace: string | null;
  primary: string | null;
  error: string | null;
}

/**
 * A draft moved to another target (the composer heading's switch to or from No project).
 * Carried over: every field this does not name (text, attachments, model, effort,
 * permission, notice, phase). Reset to the new target's: the set, the workspace, the
 * primary, the worktree, the base (it was one of the old primary's refs) and the error.
 *
 * Tags: project skills and files of a project the new target does not have (`members`)
 * leave the text (lib/prompt retainProjectTags); images and user skills stay.
 */
export function movedDraft<D extends MovableDraft>(d: D, members: readonly string[]): D {
  return {
    ...d,
    text: retainProjectTags(d.text, members),
    worktree: null,
    base: null,
    projects: null,
    workspace: null,
    primary: null,
    error: null,
  };
}

/**
 * Where thread.new starts the thread: in one project (a new or existing worktree, exactly
 * as before sets), in a set of projects (several, or a workspace's: one primary, fresh
 * worktrees on one new branch or every project's own checkout), like an existing thread
 * (thread.new-like: its set, branch, workspace and mode; `primary` "" keeps its own), or
 * without a project in the home directory.
 */
export type ThreadPlace =
  | { kind: "project"; projectId: string; worktree: ProjectWorktree; base: string }
  /**
   * `primary` is a project id or "workspace". `branch`: an existing branch every git
   * project works on ("" a new one). `base` (a branch name, "": each project's default)
   * applies to every project of `baseFor` (the set's git projects; empty without a base).
   */
  | {
      kind: "set";
      projectIds: readonly string[];
      primary: string;
      workspaceId: string;
      newWorktree: boolean;
      branch: string;
      base: string;
      baseFor: readonly string[];
    }
  | { kind: "like"; threadId: string; primary: string }
  /** thread.new --no-project: no project, worktree or workspace. */
  | { kind: "home" };

/** The draft fields that decide where a thread starts. */
export interface PlaceInput {
  target: ComposeTarget;
  /** The draft's choice resolved for its set (setWorkIn for a set). */
  worktree: WorktreeChoice;
  /** The branch the user picked to branch from (every git project's); null: each project's default. */
  base: string | null;
  /** The draft's set (lib/projectSet resolveSet). */
  set: { projectIds: readonly string[]; workspaceId: string; primary: string; isSet: boolean };
  /** like: the primary the user picked when it is not the thread's own; "" keeps it. */
  likePrimary?: string;
}

export interface PlaceEnv {
  isGitProject: (id: string) => boolean;
  hasWorktree: (projectId: string, path: string) => boolean;
  /** A project's main checkout ("current" for a single project); undefined when unknown. */
  mainPath?: (projectId: string) => string | undefined;
  /**
   * The one checkout of a project without git (its folder); undefined for a git project.
   * Such a project's thread always runs there: no new worktree.
   */
  noGitCheckout?: (projectId: string) => string | undefined;
}

/** Where a draft's thread starts, or null when nothing is left to start it in (its projects or workspace are gone). */
export function threadPlace(d: PlaceInput, env: PlaceEnv): ThreadPlace | null {
  if (d.target.kind === "home") return { kind: "home" };
  if (d.target.kind === "like") return { kind: "like", threadId: d.target.threadId, primary: d.likePrimary ?? "" };
  const { projectIds, workspaceId, primary } = d.set;
  if (d.set.isSet) {
    const branch = d.worktree.kind === "branch" ? d.worktree.name : "";
    const newWorktree = d.worktree.kind === "new" || branch !== "";
    // The picked base is a branch every git project has; none for an existing branch.
    const gitIds = projectIds.filter((id) => env.isGitProject(id));
    const base = d.worktree.kind === "new" && gitIds.length > 0 ? (d.base ?? "") : "";
    return { kind: "set", projectIds, primary, workspaceId, newWorktree, branch, base, baseFor: base ? gitIds : [] };
  }
  const projectId = projectIds[0];
  if (projectId === undefined) return null;
  const checkout = env.noGitCheckout?.(projectId);
  if (checkout !== undefined) return { kind: "project", projectId, worktree: { kind: "existing", path: checkout }, base: "" };
  if (d.worktree.kind === "branch") return { kind: "project", projectId, worktree: d.worktree, base: "" };
  const main = d.worktree.kind === "current" ? env.mainPath?.(projectId) : undefined;
  const picked: WorktreeChoice = main ? { kind: "existing", path: main } : d.worktree;
  const worktree: ProjectWorktree = picked.kind === "existing" && env.hasWorktree(projectId, picked.path) ? picked : { kind: "new" };
  // Nothing picked: no base, the daemon's default (docs/notes/base-origin-rule.md).
  return { kind: "project", projectId, worktree, base: worktree.kind === "new" ? (d.base ?? "") : "" };
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
export const ATTACHMENT_TYPE_NAMES = "PNG, JPEG, GIF, WebP or PDF";

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

/** What the composer accepts (api/threads.ts has the daemon's values). */
export interface AttachmentLimits {
  types: readonly string[];
  /** The PDF type; every other accepted type is an image. */
  pdfType: string;
  /** Per file, by type. */
  maxBytes: (type: string) => number;
  /** What one message sends inline: images, and PDFs of at most maxInlinePages pages. */
  maxInlineBytes: number;
  maxInlinePages: number;
  /** Files per message (MAX_ATTACHMENTS). */
  max?: number;
}

/** An attachment as the inline cap sees it: pages null while a PDF is still being counted. */
export interface InlineLike {
  kind: "image" | "pdf";
  size: number;
  pages: number | null;
}

/**
 * Whether an attachment goes to Claude inline (in the request) rather than as a path:
 * every image, and a PDF of at most `maxPages` pages. A PDF whose pages are not known
 * yet (or could not be counted) is not counted as inline: the cap applies to it once
 * its count arrives (stores/compose.ts), and the daemon checks again on send.
 */
export function sentInline(a: InlineLike, maxPages: number): boolean {
  return a.kind === "image" || (a.pages !== null && a.pages <= maxPages);
}

/** The bytes the attachments send inline (sentInline). */
export function inlineBytes(list: readonly InlineLike[], maxPages: number): number {
  return list.reduce((sum, a) => sum + (sentInline(a, maxPages) ? a.size : 0), 0);
}

/** The notice for an attachment that would take the message over the inline cap. */
export function inlineCapNotice(name: string, maxInlineBytes: number): string {
  return `Attachments sent with one message must total under ${String(Math.round(maxInlineBytes / (1024 * 1024)))} MB; ${name} not attached`;
}

/** The notice for a PDF too long to go inline. */
export function longPdfNotice(name: string, pages: number): string {
  return `${name} has ${String(pages)} pages; Claude reads it page by page`;
}

/** "1 page", "12 pages". */
export function pageCount(pages: number): string {
  return `${String(pages)} ${pages === 1 ? "page" : "pages"}`;
}

/** An attachment tile's label: "Preview a.png, 58 KB", "Preview spec.pdf, PDF, 12 pages, 1.4 MB" (pages and size when known). */
export function previewLabel(name: string, kind: "image" | "pdf", pages: number | null, size: string): string {
  const parts = [`Preview ${name}`, kind === "pdf" ? "PDF" : "", pages === null ? "" : pageCount(pages), size];
  return parts.filter(Boolean).join(", ");
}

/**
 * Splits dropped/pasted/picked files into the ones to attach and one message per
 * rejection (wrong type, too big, over the count cap, over the inline cap). `existing`
 * is what the draft already has. An image counts toward the inline cap at once; a PDF
 * only once its pages are counted (sentInline): one whose `pages` are known already (a
 * path the daemon staged, which names the count) is checked here, any other is not.
 */
export function checkAttachments<F extends FileLike & { pages?: number | null }>(
  files: readonly F[],
  existing: { count: number; inlineBytes: number },
  limits: AttachmentLimits,
): { accepted: F[]; rejected: string[] } {
  const max = limits.max ?? MAX_ATTACHMENTS;
  const accepted: F[] = [];
  const rejected: string[] = [];
  let inline = existing.inlineBytes;
  let over = 0;
  const inlineNow = (f: F) => sentInline({ kind: f.type === limits.pdfType ? "pdf" : "image", size: f.size, pages: f.pages ?? null }, limits.maxInlinePages);
  for (const f of files) {
    const name = f.name || "pasted image";
    const maxBytes = limits.maxBytes(f.type);
    if (!limits.types.includes(f.type)) rejected.push(`${name}: not a ${ATTACHMENT_TYPE_NAMES} file`);
    else if (f.size > maxBytes) rejected.push(`${name}: larger than ${String(Math.round(maxBytes / (1024 * 1024)))} MB`);
    else if (existing.count + accepted.length >= max) over++;
    else if (inlineNow(f) && inline + f.size > limits.maxInlineBytes) rejected.push(inlineCapNotice(name, limits.maxInlineBytes));
    else {
      if (inlineNow(f)) inline += f.size;
      accepted.push(f);
    }
  }
  if (over > 0) rejected.push(`At most ${String(max)} attachments per message; ${String(over)} not attached`);
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
  /** Base ref for a new worktree; "" lets the daemon pick (the default branch: origin's copy unless the local branch is ahead of it, or projects.base_from_origin is off). */
  base: string;
}

/** thread.new's args for a project draft (threadArgs with a project place). */
export function threadNewArgs(projectId: string, d: DraftArgsInput, attachments: readonly string[]): Record<string, string> {
  return threadArgs({ kind: "project", projectId, worktree: d.worktree, base: d.base }, d, attachments);
}

/**
 * The args of the command a place starts the thread with (thread.new; thread.new-like for
 * a like place). Empty values are omitted so the daemon applies its defaults. A project:
 * `worktree` is the path for an existing worktree, `new-worktree` + `branch` for an
 * existing branch, `new-worktree` + `base` otherwise. A set: `projects` (sorted; a picked
 * base on every git project as `<project>:<base>`), `project` the primary (a project, or
 * `workspace` for the workspace's folder), `workspace` when one is referenced, `branch`
 * for an existing branch, and `new-worktree` true (worktrees on one branch) or false
 * (every project's own checkout). Like: the thread's `id`, and the primary only when the user
 * changed it. No project: `no-project` alone (the daemon refuses it beside any of the others).
 */
export function threadArgs(place: ThreadPlace, d: PromptArgsInput, attachments: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  switch (place.kind) {
    case "home":
      args["no-project"] = "true";
      break;
    case "project":
      args.project = place.projectId;
      if (place.worktree.kind === "existing") args.worktree = place.worktree.path;
      else if (place.worktree.kind === "branch") {
        args["new-worktree"] = "true";
        args.branch = place.worktree.name;
      } else {
        args["new-worktree"] = "true";
        if (place.base) args.base = place.base;
      }
      break;
    case "set":
      args.project = place.primary;
      // Never an empty list: the daemon reads none as the workspace's members. Only a
      // workspace without projects has none (sendDraft refuses any other empty set).
      if (place.projectIds.length > 0) args.projects = place.projectIds.map((id) => (place.base && place.baseFor.includes(id) ? `${id}:${place.base}` : id)).join(",");
      if (place.workspaceId) args.workspace = place.workspaceId;
      args["new-worktree"] = String(place.newWorktree);
      if (place.branch) args.branch = place.branch;
      break;
    case "like":
      args.id = place.threadId;
      if (place.primary) args.project = place.primary;
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
export function projectSource(r: { githubSlug: string; remotes: readonly string[]; git?: boolean }): string {
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
