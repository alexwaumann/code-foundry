/**
 * The Skills marketplace (docs/notes/skills-3-api.md): Claude Code plugins and standalone
 * skills from the marketplaces Claude Code has, mapped to view models. SkillService only
 * reads (Search, Installed, Registries; the EventService skill source carries the epoch
 * that says when to read again); the actions are the skill.* commands, which
 * stores/skill.ts runs. The only file that uses the generated skill types.
 *
 * Not to be confused with api/filesystem.ts's ListSkills (the "/" commands a composer
 * offers): that lists what Claude Code would load, this what a marketplace offers.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import {
  InstalledSkillState,
  SkillEntryState,
  SkillKind,
  SkillService,
  SkillTier,
  type InstalledSkill,
  type ListInstalledSkillsResponse,
  type ListSkillRegistriesResponse,
  type SearchSkillsResponse,
  type SkillEntry,
  type SkillEvent,
  type SkillRegistry,
} from "@/gen/codefoundry/v1/skill_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** A Claude Code plugin the marketplace index lists, or a standalone skill directory. */
export type SkillKindView = "plugin" | "skill";

/** The marketplace's top-level folder; "" for neither (a public marketplace's plugin). */
export type SkillTierView = "enterprise" | "community" | "";

const kinds: Record<SkillKind, SkillKindView | ""> = {
  [SkillKind.UNSPECIFIED]: "",
  [SkillKind.PLUGIN]: "plugin",
  [SkillKind.SKILL]: "skill",
};

const tiers: Record<SkillTier, SkillTierView> = {
  [SkillTier.UNSPECIFIED]: "",
  [SkillTier.ENTERPRISE]: "enterprise",
  [SkillTier.COMMUNITY]: "community",
};

function toKind(k: SkillKind): SkillKindView {
  return kinds[k] || "skill";
}

function toKindProto(k: SkillKindView | ""): SkillKind {
  return k === "plugin" ? SkillKind.PLUGIN : k === "skill" ? SkillKind.SKILL : SkillKind.UNSPECIFIED;
}

function toTierProto(t: SkillTierView): SkillTier {
  return t === "enterprise" ? SkillTier.ENTERPRISE : t === "community" ? SkillTier.COMMUNITY : SkillTier.UNSPECIFIED;
}

function ms(t: Timestamp | undefined): number | null {
  return t ? timestampMs(t) : null;
}

/**
 * One id for a thing a row acts on, shared by Browse and Installed: a plugin is
 * `plugin:<name>@<marketplace>` (one name may come from two marketplaces), a skill
 * `skill:<name>` (a skill is installed under its name, one per name).
 */
export function skillItemKey(kind: SkillKindView, name: string, registry: string): string {
  return kind === "plugin" && registry ? `plugin:${name}@${registry}` : `${kind}:${name}`;
}

/**
 * The name argument the skill.* commands take for a row: a plugin's
 * `<name>@<marketplace>` (exact even when two marketplaces list the name), a skill's
 * name.
 */
export function skillCommandName(kind: SkillKindView, name: string, registry: string): string {
  return kind === "plugin" && registry ? `${name}@${registry}` : name;
}

// ---------------------------------------------------------------------------------------
// Browse

/** How a Browse entry stands to what is installed of it. */
export type EntryStateView = "not-installed" | "enabled" | "disabled";

const entryStates: Record<SkillEntryState, EntryStateView> = {
  [SkillEntryState.UNSPECIFIED]: "not-installed",
  [SkillEntryState.NOT_INSTALLED]: "not-installed",
  [SkillEntryState.ENABLED]: "enabled",
  [SkillEntryState.DISABLED]: "disabled",
};

/** A plugin or skill a marketplace offers, with what is installed of it. */
export interface SkillEntryView {
  /** skillItemKey: the busy and failure maps' key, the list's React key. */
  key: string;
  kind: SkillKindView;
  tier: SkillTierView;
  name: string;
  /** One line ("" when it has none). */
  description: string;
  /** Who it is by ("" when unknown). */
  by: string;
  /** A plugin's index version; a skill's YYYYMMDD of its last commit ("" without history). */
  version: string;
  /** A skill's frontmatter metadata.version, display only. */
  declaredVersion: string;
  /** The last commit touching it; null without history. */
  lastUpdatedMs: number | null;
  /** The marketplace's name. */
  registry: string;
  /** Its directory in the marketplace ("" for a plugin from another repository). */
  path: string;
  keywords: string[];
  /** A plugin's skill names, sorted ("N skills ▸"). */
  skills: string[];
  /** A skill's setup script, repo-relative ("" for none). */
  setupScript: string;
  state: EntryStateView;
  /** The installed version ("" when not installed). */
  installedVersion: string;
  /** "Update to X": the version an update brings ("" for none). */
  updateVersion: string;
}

export function toSkillEntry(e: SkillEntry): SkillEntryView {
  const kind = toKind(e.kind);
  return {
    key: skillItemKey(kind, e.name, e.registry),
    kind,
    tier: tiers[e.tier],
    name: e.name,
    description: e.description,
    by: e.by,
    version: e.version,
    declaredVersion: e.declaredVersion,
    lastUpdatedMs: ms(e.lastUpdated),
    registry: e.registry,
    path: e.path,
    keywords: [...e.keywords],
    skills: [...e.skills],
    setupScript: e.setupScript,
    state: entryStates[e.state],
    installedVersion: e.installedVersion,
    updateVersion: e.updateVersion,
  };
}

/** A Browse search: words, and the chips (tier, kind; "" for any). */
export interface SkillQuery {
  text: string;
  tier: SkillTierView;
  kind: SkillKindView | "";
}

export const EMPTY_SKILL_QUERY: SkillQuery = { text: "", tier: "", kind: "" };

/** One page of hits, best first. */
export interface SkillSearchView {
  entries: SkillEntryView[];
  /** How many matched before the limit ("200 of 1,234"). */
  total: number;
  /** Why the refresh asked for failed (the search ran over the last read). */
  refreshError: string;
  /** The daemon's read the search ran over. */
  epoch: number;
}

export function toSkillSearch(r: SearchSkillsResponse): SkillSearchView {
  return { entries: r.entries.map(toSkillEntry), total: r.total, refreshError: r.refreshError, epoch: Number(r.epoch) };
}

/** SkillService.Search: at most `limit` hits (the daemon caps it at 500). */
export async function searchSkills(q: SkillQuery, limit: number, signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<SkillSearchView> {
  const c = await conn.client(SkillService);
  return toSkillSearch(await c.search({ query: q.text, tier: toTierProto(q.tier), kind: toKindProto(q.kind), limit }, { signal }));
}

// ---------------------------------------------------------------------------------------
// Installed

/**
 * Where an installed row stands: from a marketplace (a plugin, or a skill Code Foundry
 * installed); local (a skill directory Code Foundry did not install: only Remove); or
 * missing (a skill Code Foundry installed whose directory is gone: Update reinstalls it,
 * Uninstall forgets it).
 */
export type InstalledStateView = "installed" | "local" | "missing";

const installedStates: Record<InstalledSkillState, InstalledStateView> = {
  [InstalledSkillState.UNSPECIFIED]: "installed",
  [InstalledSkillState.INSTALLED]: "installed",
  [InstalledSkillState.LOCAL]: "local",
  [InstalledSkillState.MISSING]: "missing",
};

/** A newer version in the marketplace. */
export interface SkillOfferView {
  version: string;
  lastUpdatedMs: number | null;
  commitSha: string;
}

/** A plugin or skill on this Mac. */
export interface InstalledSkillView {
  /** skillItemKey (a Browse entry of the same thing has the same key). */
  key: string;
  kind: SkillKindView;
  name: string;
  /** name@marketplace for a plugin, the name for a skill. */
  id: string;
  /** The marketplace it came from ("" for a local skill: "Local"). */
  registry: string;
  path: string;
  tier: SkillTierView;
  description: string;
  by: string;
  /** A plugin's installed version, a recorded skill's YYYYMMDD ("" for a local skill). */
  version: string;
  /** A plugin's last install or update, a recorded skill's commit time. */
  lastUpdatedMs: number | null;
  enabled: boolean;
  state: InstalledStateView;
  /** Where it is on disk. */
  dir: string;
  /** A plugin's Claude Code scope (user, project, local). */
  scope: string;
  /** A plugin's skill names ("N skills" expanding to the list). */
  skills: string[];
  /** A recorded skill's setup script, relative to dir. */
  setupScript: string;
  /** "Needs setup": Run setup runs the script. */
  needsSetup: boolean;
  /** The marketplace's newer version (Update in amber), null for none. */
  update: SkillOfferView | null;
}

export function toInstalledSkill(s: InstalledSkill): InstalledSkillView {
  const kind = toKind(s.kind);
  return {
    key: skillItemKey(kind, s.name, s.registry),
    kind,
    name: s.name,
    id: s.id,
    registry: s.registry,
    path: s.path,
    tier: tiers[s.tier],
    description: s.description,
    by: s.by,
    version: s.version,
    lastUpdatedMs: ms(s.lastUpdated),
    enabled: s.enabled,
    state: installedStates[s.state],
    dir: s.dir,
    scope: s.scope,
    skills: [...s.skills],
    setupScript: s.setupScript,
    needsSetup: s.needsSetup,
    update: s.update ? { version: s.update.version, lastUpdatedMs: ms(s.update.lastUpdated), commitSha: s.update.commitSha } : null,
  };
}

export interface InstalledListView {
  /** By name, then kind. */
  installed: InstalledSkillView[];
  /** Why `claude plugin list` failed (the plugins are the last good list's). */
  pluginsError: string;
  epoch: number;
}

export function toInstalledList(r: ListInstalledSkillsResponse): InstalledListView {
  return { installed: r.installed.map(toInstalledSkill), pluginsError: r.pluginsError, epoch: Number(r.epoch) };
}

/** SkillService.Installed. */
export async function listInstalledSkills(signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<InstalledListView> {
  const c = await conn.client(SkillService);
  return toInstalledList(await c.installed({}, { signal }));
}

// ---------------------------------------------------------------------------------------
// Registries

/** One marketplace Claude Code has, as last read. */
export interface SkillRegistryView {
  name: string;
  /** owner/repo for a github source ("" otherwise). */
  repo: string;
  /** github, git, directory, ... */
  source: string;
  url: string;
  ref: string;
  /** The checkout (Claude Code's installLocation). */
  dir: string;
  /** marketplace.json's owner.name. */
  owner: string;
  plugins: number;
  skills: number;
  /** A shallow clone: dates are its last commit's until a refresh. */
  shallow: boolean;
  /** "read <relative>"; null when never read. */
  readAtMs: number | null;
  /** When a refresh last updated it (null: not since the daemon started). */
  refreshedAtMs: number | null;
  /** Why the last read or refresh failed ("" when it worked). */
  error: string;
  /** What the read skipped, a sentence each. */
  issues: string[];
}

export function toSkillRegistry(r: SkillRegistry): SkillRegistryView {
  return {
    name: r.name,
    repo: r.repo,
    source: r.source,
    url: r.url,
    ref: r.ref,
    dir: r.dir,
    owner: r.owner,
    plugins: r.plugins,
    skills: r.skills,
    shallow: r.shallow,
    readAtMs: ms(r.readAt),
    refreshedAtMs: ms(r.refreshedAt),
    error: r.error,
    issues: [...r.issues],
  };
}

export interface SkillRegistriesView {
  /** Empty: Claude Code has no marketplace (the empty state names expectedMarketplace). */
  registries: SkillRegistryView[];
  /** Why the marketplaces could not be listed (the registries are the last good list's). */
  error: string;
  /** The marketplace the empty state names as an example to add: ai-marketplace. */
  expectedMarketplace: string;
  epoch: number;
}

export function toSkillRegistries(r: ListSkillRegistriesResponse): SkillRegistriesView {
  return { registries: r.registries.map(toSkillRegistry), error: r.error, expectedMarketplace: r.expectedMarketplace, epoch: Number(r.epoch) };
}

/** SkillService.Registries. */
export async function listSkillRegistries(signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<SkillRegistriesView> {
  const c = await conn.client(SkillService);
  return toSkillRegistries(await c.registries({}, { signal }));
}

// ---------------------------------------------------------------------------------------
// Events and command results

/** The EventService skill source: the daemon read again (epoch moved), so re-read. */
export interface SkillEventView {
  epoch: number;
}

export function toSkillEventView(ev: SkillEvent): SkillEventView {
  return { epoch: Number(ev.epoch) };
}

/** What a skill.* command did (its result JSON, skill.Change). */
export interface SkillChangeView {
  op: string;
  kind: SkillKindView;
  name: string;
  registry: string;
  message: string;
  version: string;
  previousVersion: string;
  /** Nothing to do (installed already, up to date, disabled already). */
  unchanged: boolean;
  dir: string;
  /** The skill has a setup script that has not run: offer Run setup. */
  needsSetup: boolean;
  setupScript: string;
  /** One update of several failed (skill.update with no name). */
  error: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The changes in a skill.* command's result JSON: one Change, or a list (skill.update). */
export function skillChanges(resultJson: string): SkillChangeView[] {
  let v: unknown;
  try {
    v = JSON.parse(resultJson || "null");
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? (v as unknown[]) : v && typeof v === "object" ? [v] : [];
  return list.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const c = x as Record<string, unknown>;
    if (typeof c.op !== "string") return [];
    return [
      {
        op: c.op,
        kind: c.kind === "plugin" ? "plugin" : "skill",
        name: str(c.name),
        registry: str(c.registry),
        message: str(c.message),
        version: str(c.version),
        previousVersion: str(c.previousVersion),
        unchanged: c.unchanged === true,
        dir: str(c.dir),
        needsSetup: c.needsSetup === true,
        setupScript: str(c.setupScript),
        error: str(c.error),
      } satisfies SkillChangeView,
    ];
  });
}
