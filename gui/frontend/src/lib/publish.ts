/**
 * Rules for the Add Project dialog's New tab and the publish picker (pure, table
 * tested): project names (the daemon's project.ValidateName), the projects directory
 * shown as the destination, and which visibilities an owner offers and which is the
 * default.
 */

/** A GitHub repository visibility, as gh's flags and repo.github.publish spell it. */
export type Visibility = "public" | "internal" | "private";

/** Most open first: the order the picker lists them and picks a default in. */
export const visibilityOrder: readonly Visibility[] = ["public", "internal", "private"];

export const visibilityLabels: Record<Visibility, string> = { public: "Public", internal: "Internal", private: "Private" };

/** Where the viewer can publish a repository (RepoService.ListPublishOwners). */
export interface PublishOwnerView {
  login: string;
  kind: "user" | "org";
  /** Visibilities allowed there, most open first. All three when known is false. */
  allowed: Visibility[];
  /** allowed is the owner's policy; false when GitHub did not say (only org owners see it). */
  known: boolean;
}

/** The longest project name (GitHub's limit for repository names). */
export const MAX_PROJECT_NAME = 100;

/**
 * Why name cannot be a new project's folder name, or null when it can: not empty, at
 * most 100 characters, not starting with ".", only letters, digits, "-", "_" and ".".
 * Same rules as the daemon.
 */
export function projectNameError(name: string): string | null {
  if (name === "") return "Type a name.";
  if (name.length > MAX_PROJECT_NAME) return `At most ${String(MAX_PROJECT_NAME)} characters.`;
  if (name.startsWith(".")) return "A name cannot start with “.”.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Use letters, digits, “-”, “_” and “.” only.";
  return null;
}

/** The default config home's projects directory, when the daemon's is not known. */
export const DEFAULT_PROJECTS_DIR = "~/.code-foundry/projects";

/**
 * The projects directory from the settings file's path (<config home>/settings.toml):
 * <config home>/projects. The default one when the path is unknown.
 */
export function projectsDirFrom(settingsPath: string | undefined): string {
  const m = settingsPath ? /^(.*)\/settings\.toml$/.exec(settingsPath) : null;
  return m?.[1] ? `${m[1]}/projects` : DEFAULT_PROJECTS_DIR;
}

/** The visibilities the picker offers for owner, most open first. */
export function visibilityOptions(owner: PublishOwnerView | undefined): Visibility[] {
  if (!owner) return [];
  if (!owner.known) return [...visibilityOrder];
  return visibilityOrder.filter((v) => owner.allowed.includes(v));
}

/**
 * The picker's default for owner: the most open allowed visibility, Public when the
 * policy is unknown. Never Private (an org that allows only Private gets no default, so
 * the choice is deliberate).
 */
export function defaultVisibility(owner: PublishOwnerView | undefined): Visibility | null {
  const opts = visibilityOptions(owner);
  return opts.find((v) => v !== "private") ?? null;
}

/**
 * The visibility to keep when the owner changes: the current choice if the new owner
 * allows it, else the new owner's default.
 */
export function keepVisibility(current: Visibility | null, owner: PublishOwnerView | undefined): Visibility | null {
  return current && visibilityOptions(owner).includes(current) ? current : defaultVisibility(owner);
}
