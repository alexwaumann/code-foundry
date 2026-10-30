/**
 * The project set of a new thread (workspaces v2, docs/notes/workspaces-v2-3-composer.md):
 * which projects it works in, the workspace it references, and its primary (where it
 * runs: one of the projects, or the workspace's folder). Pure; the compose store keeps the
 * draft's choices and the composer reads them through these.
 */

/** The primary that runs a thread in its workspace's folder (thread.new --project workspace). */
export const WORKSPACE_PRIMARY = "workspace";

/**
 * How the GUI names a workspace's folder as a place to run (the Runs in picker, Run
 * in…): never just "Workspace", which reads like a project named "workspace".
 */
export const WORKSPACE_FOLDER = "Workspace folder";

/** A workspace as the set logic needs it. */
export interface SetWorkspace {
  /** Member project ids. */
  members: readonly string[];
  /** A member project id, or WORKSPACE_PRIMARY; "" or absent when unknown. */
  defaultPrimary?: string;
}

/** What a draft says about its set; null fields follow the composer's target. */
export interface SetChoice {
  /** The picked projects in the order the user picked them; null: the target's. */
  projects: readonly string[] | null;
  /** The referenced workspace id; "" none; null: the target's. */
  workspace: string | null;
  /** A picked project id or WORKSPACE_PRIMARY; null (or one no longer in the set): the default. */
  primary: string | null;
}

/** What the composer's target gives a draft before the user picks anything. */
export interface SetDefaults {
  projects: readonly string[];
  workspace: string;
}

export interface ResolvedSet {
  /** The set, sorted by project id (how it is shown and sent). */
  projectIds: string[];
  /** The set in the order it was picked (the default primary is the first). */
  picked: string[];
  /** The referenced workspace; "" without one. */
  workspaceId: string;
  /** The primary: a project id, WORKSPACE_PRIMARY, or "" for an empty set without a workspace. */
  primary: string;
  /** Sent as a set (projects, workspace): more than one project, or a workspace. */
  isSet: boolean;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether two sets of project ids hold the same ids, whatever their order. */
export function sameProjects(a: readonly string[], b: readonly string[]): boolean {
  const x = unique(a).sort(byId);
  const y = unique(b).sort(byId);
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

/**
 * The draft's set. Projects the registry no longer knows drop out. A set picked from a
 * named workspace that no longer matches its members (a project added or removed in the
 * picks) leaves the workspace, as a thread's does (docs/notes/thread-project-set.md): the
 * heading names the set, not the workspace, and the thread is created without the
 * reference; picks that match again bring it back, since nothing was sent. The primary is
 * the draft's pick while it is still in the set (WORKSPACE_PRIMARY only with a workspace),
 * else the workspace's default primary when that is the folder or in the set, else the
 * first picked project, else the workspace's folder (a workspace without projects).
 */
export function resolveSet(d: SetChoice, defaults: SetDefaults, env: { workspace: (id: string) => SetWorkspace | undefined; known: (id: string) => boolean }): ResolvedSet {
  const named = d.workspace ?? defaults.workspace;
  const picked = unique(d.projects ?? defaults.projects).filter(env.known);
  const found = named ? env.workspace(named) : undefined;
  // An unknown workspace (not listed yet) keeps the reference: its members cannot be compared.
  const workspaceId = found && !sameProjects(picked, found.members.filter(env.known)) ? "" : named;
  const projectIds = [...picked].sort(byId);
  const valid = (p: string | null | undefined): p is string => !!p && ((p === WORKSPACE_PRIMARY && workspaceId !== "") || projectIds.includes(p));
  const fallback = picked[0] ?? (workspaceId ? WORKSPACE_PRIMARY : "");
  // A set that left its workspace keeps running where the workspace would (its default primary, while in the set).
  const primary = valid(d.primary) ? d.primary : valid(found?.defaultPrimary) ? found.defaultPrimary : fallback;
  return { projectIds, picked, workspaceId, primary, isSet: projectIds.length > 1 || workspaceId !== "" };
}

/** The set with a project added (at the end of the pick order) or, when it is in, removed. */
export function toggled(picked: readonly string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
}

/**
 * The heading's name for a set: the workspace's name, else the one project's name, else
 * "N projects". `name` maps a project id to its name.
 */
export function setName(s: Pick<ResolvedSet, "projectIds" | "workspaceId">, workspaceName: string, name: (id: string) => string): string {
  if (s.workspaceId) return workspaceName || s.workspaceId;
  if (s.projectIds.length === 1) return name(s.projectIds[0] ?? "");
  return `${String(s.projectIds.length)} projects`;
}

/**
 * Project ids in display order: by name, case-insensitively (then by id). The set is
 * stored and sent by id; ids look random to a user, names do not.
 */
export function byName(ids: readonly string[], name: (id: string) => string): string[] {
  return [...ids].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) || byId(a, b));
}

/** A primary picker option: the workspace's folder (WORKSPACE_FOLDER, "<name>'s folder") first when there is a workspace, then the projects by name. */
export interface PrimaryOption {
  value: string;
  label: string;
  detail?: string;
}

export function primaryOptions(s: Pick<ResolvedSet, "projectIds" | "workspaceId">, workspaceName: string, name: (id: string) => string): PrimaryOption[] {
  const out: PrimaryOption[] = [];
  if (s.workspaceId) out.push({ value: WORKSPACE_PRIMARY, label: WORKSPACE_FOLDER, detail: `${workspaceName || s.workspaceId}'s folder` });
  for (const id of byName(s.projectIds, name)) out.push({ value: id, label: name(id) });
  return out;
}

/** The members of a saved workspace equal to this set (sorted ids compared); undefined when none matches. */
export function matchingWorkspace<W extends { id: string; members: readonly string[] }>(projectIds: readonly string[], workspaces: readonly W[]): W | undefined {
  const key = [...projectIds].sort(byId).join("\u0000");
  return workspaces.find((w) => [...w.members].sort(byId).join("\u0000") === key);
}

/**
 * Whether "Save as workspace" applies to a thread: two or more projects and no saved
 * workspace with the same set. Never for a thread running in its workspace's folder
 * (`inWorkspaceFolder`): it belongs to that workspace, and the daemon refuses to change
 * its reference.
 */
export function canSaveAsWorkspace(projectIds: readonly string[], workspaces: readonly { id: string; members: readonly string[] }[], inWorkspaceFolder = false): boolean {
  return !inWorkspaceFolder && projectIds.length >= 2 && matchingWorkspace(projectIds, workspaces) === undefined;
}
