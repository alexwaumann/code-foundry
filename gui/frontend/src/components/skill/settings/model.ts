/**
 * Pure helpers behind Settings → Skills (SkillsPage): dates, versions, pills and the words
 * the rows, the search line, the registries and the confirms use. Kept apart from the
 * components so the table tests read them directly.
 */
import type { Tone } from "@/api/plugin";
import type { InstalledSkillView, SkillEntryView, SkillKindView, SkillRegistryView, SkillTierView } from "@/api/skill";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { countWords, flatIds, groupId, matchesWords } from "@/components/settings/catalog/model";
import { RESTART_WARNING, type SkillAction, type SkillFailure } from "@/stores/skill";

/** A pill: its words and tone (the plugin pills' table, components/plugin/tones.ts). */
export interface SkillPill {
  label: string;
  tone: Tone;
}

/** A time as the YYYYMMDD a skill's version is (UTC, as the daemon writes it). */
export function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * How long ago, at a skill's pace (commits weeks or months apart): "today", "yesterday",
 * "5 days ago", "3 weeks ago", "4 months ago", "2 years ago". A time ahead reads "today".
 */
export function ageWords(ms: number, now: number): string {
  const days = Math.floor(Math.max(0, now - ms) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${String(days)} days ago`;
  if (days < 60) return `${String(Math.floor(days / 7))} weeks ago`;
  if (days < 730) return `${String(Math.floor(days / 30))} months ago`;
  return `${String(Math.floor(days / 365))} years ago`;
}

/** When a marketplace was read: "read just now", "read 5 min ago", "read 3 h ago", "read 2 d ago"; "not read yet". */
export function readWords(ms: number | null, now: number): string {
  if (ms === null) return "not read yet";
  const mins = Math.round(Math.max(0, now - ms) / 60_000);
  if (mins < 1) return "read just now";
  if (mins < 60) return `read ${String(mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `read ${String(hours)} h ago`;
  return `read ${String(Math.round(hours / 24))} d ago`;
}

/**
 * What a row shows for its version: a plugin's version as it is; a skill's YYYYMMDD with
 * how long ago ("20261016 · 4 days ago"), from its last commit. "" when there is neither.
 */
export function versionWords(r: { kind: SkillKindView; version: string; lastUpdatedMs: number | null }, now: number): string {
  if (r.kind === "plugin") return r.version;
  const at = r.lastUpdatedMs !== null && r.lastUpdatedMs > 0 ? r.lastUpdatedMs : null;
  const ver = r.version || (at !== null ? ymd(at) : "");
  if (!ver) return "";
  return at !== null ? `${ver} · ${ageWords(at, now)}` : ver;
}

export function kindLabel(k: SkillKindView): string {
  return k === "plugin" ? "Plugin" : "Skill";
}

export function tierLabel(t: SkillTierView): string {
  return t === "enterprise" ? "Enterprise" : t === "community" ? "Community" : "";
}

/** "1 skill", "4 skills". */
export function skillCount(n: number): string {
  return `${String(n)} ${n === 1 ? "skill" : "skills"}`;
}

/** Where an installed row comes from: "from <marketplace>", or "Local" for a skill Code Foundry did not install. */
export function sourceWords(r: Pick<InstalledSkillView, "state" | "registry">): string {
  if (r.state === "local") return "Local";
  return r.registry ? `from ${r.registry}` : "";
}

/** Browse's words for an installed entry with nothing to update ("Installed", "Installed, disabled"). */
export function installedWords(e: Pick<SkillEntryView, "state">): string {
  return e.state === "disabled" ? "Installed, disabled" : "Installed";
}

/** What the marketplace group's count leaves out: "showing the first 200" when the daemon stopped short of every match. */
export function shownWords(total: number, shown: number): string {
  return shown < total ? `showing the first ${countWords(shown)}` : "";
}

/** A marketplace's line: "3 plugins · 39 skills · read 5 min ago". */
export function registryLine(r: Pick<SkillRegistryView, "plugins" | "skills" | "readAtMs">, now: number): string {
  return [`${String(r.plugins)} ${r.plugins === 1 ? "plugin" : "plugins"}`, skillCount(r.skills), readWords(r.readAtMs, now)].join(" · ");
}

/** The chips in a group: none or both on is "any" (""), one on is its value. */
export function chipValue<T extends string>(on: readonly T[]): T | "" {
  return on.length === 1 ? (on[0] ?? "") : "";
}

/** One chip pressed: on when it was off, off when it was on (the others in the group stay). */
export function toggleChip<T extends string>(on: readonly T[], value: T): T[] {
  return on.includes(value) ? on.filter((v) => v !== value) : [...on, value];
}

/** The confirming actions: the page asks with its own dialog, then runs the command preconfirmed. A switch does not ask. */
export type ConfirmAction = Extract<SkillAction, "uninstall" | "remove">;

/** The confirm dialog's words for an action on a row. */
export function confirmCopy(action: ConfirmAction, r: Pick<InstalledSkillView, "kind" | "name" | "dir">): { title: string; body: string; label: string } {
  switch (action) {
    case "uninstall":
      return {
        title: `Uninstall ${r.name}?`,
        body: `${r.kind === "plugin" ? "Claude Code removes the plugin and its skills" : "Its directory is deleted"}; you can install it again from Browse all. ${RESTART_WARNING}`,
        label: "Uninstall",
      };
    case "remove":
      return {
        title: `Remove ${r.name}?`,
        body: `This deletes ${r.dir || "its directory"}, a skill you wrote: no marketplace has it, so it cannot be installed again. ${RESTART_WARNING}`,
        label: "Remove",
      };
  }
}

// ---------------------------------------------------------------------------------------
// The list

/** The groups of the default list: what wants something done, then the rest by the switch. */
export type SkillGroup = "needs" | "enabled" | "disabled";

export const GROUP_LABELS: Readonly<Record<string, string>> = { needs: "Needs you", enabled: "Enabled", disabled: "Disabled", installed: "Installed" };

type GroupedRow = Pick<InstalledSkillView, "key" | "kind" | "state" | "enabled" | "update" | "needsSetup">;

/**
 * Where a row goes: Needs you for an update, setup to run or a missing directory (and a row
 * an Update all finished, until the page is next opened); a local skill has no switch and
 * counts as Enabled; else by its switch.
 */
export function skillGroup(r: GroupedRow, updated: Readonly<Record<string, string>>): SkillGroup {
  if (r.key in updated || r.state === "missing" || r.update || (r.kind === "skill" && r.needsSetup)) return "needs";
  if (r.state === "local") return "enabled";
  return r.enabled ? "enabled" : "disabled";
}

type FilteredRow = GroupedRow & Pick<InstalledSkillView, "name" | "description" | "by" | "registry" | "skills">;

/** Whether a row passes the search and the Plugins/Skills chips ("" for either). */
export function matchesInstalled(r: FilteredRow, words: readonly string[], kind: SkillKindView | ""): boolean {
  return (!kind || r.kind === kind) && matchesWords(words, [r.name, r.description, r.by, r.registry, ...r.skills]);
}

/** The default list's flat ids (catalog flatIds): the groups in order, the daemon's order in each. */
export function groupedIds(rows: readonly FilteredRow[], kind: SkillKindView | "", updated: Readonly<Record<string, string>>): string[] {
  const groups: Record<SkillGroup, string[]> = { needs: [], enabled: [], disabled: [] };
  for (const r of rows) if (matchesInstalled(r, [], kind)) groups[skillGroup(r, updated)].push(r.key);
  return flatIds([
    ["needs", groups.needs],
    ["enabled", groups.enabled],
    ["disabled", groups.disabled],
  ]);
}

/**
 * A search's Installed group as flat ids: one group, whatever the rows' states. The filter
 * is the client's, plus what the marketplace's answer found by what an installed row does
 * not carry (its keywords): `hits`, the keys of that answer.
 */
export function searchedIds(rows: readonly FilteredRow[], words: readonly string[], kind: SkillKindView | "", hits: ReadonlySet<string>): string[] {
  return flatIds([["installed", rows.filter((r) => matchesInstalled(r, words, kind) || (hits.has(r.key) && (!kind || r.kind === kind))).map((r) => r.key)]]);
}

/** The rows an Update all takes: a missing one's Reinstall is its own. */
export function updatableRows<R extends Pick<InstalledSkillView, "state" | "update">>(rows: readonly R[]): R[] {
  return rows.filter((r) => r.update !== null && r.state !== "missing");
}

/** The hits a search lists under the marketplace: what the Installed group above already shows goes. */
export function marketKeys(entries: readonly Pick<SkillEntryView, "key">[], shown: ReadonlySet<string>): string[] {
  return entries.filter((e) => !shown.has(e.key)).map((e) => e.key);
}

/** The Installed group's rows among flat ids. */
export function rowKeys(ids: readonly string[]): Set<string> {
  return new Set(ids.filter((id) => id !== groupId("installed")));
}

/** A row's kind pill: "Plugin · 4" for a Claude Code plugin with skills. */
export function kindWords(kind: SkillKindView, skills: number): string {
  return kind === "plugin" && skills > 0 ? `Plugin · ${String(skills)}` : kindLabel(kind);
}

/** What an installed row shows before its switch: the one thing it wants, or how it stands. */
export type RowMain =
  | { kind: "working"; words: string }
  | { kind: "updated"; version: string }
  | { kind: "updating" }
  | { kind: "update"; version: string; retry: boolean }
  | { kind: "reinstall" }
  | { kind: "setup" }
  | null;

/**
 * An installed row's main action. A run's finished row says so; a failed update offers its
 * retry (the failure is under the row); an update comes before setup, which it may change.
 */
export function rowMain(
  r: Pick<InstalledSkillView, "kind" | "state" | "update" | "needsSetup">,
  busy: SkillAction | null,
  failure: SkillFailure | null,
  updatedTo: string | undefined,
): RowMain {
  if (busy === "uninstall") return { kind: "working", words: "Uninstalling…" };
  if (busy === "remove") return { kind: "working", words: "Removing…" };
  if (r.state === "local") return null;
  if (r.state === "missing") return { kind: "reinstall" };
  if (busy === "update") return { kind: "updating" };
  // Run setup again, from the menu: the row's own Run setup spins instead.
  if (busy === "setup" && !r.needsSetup) return { kind: "working", words: "Starting setup…" };
  if (updatedTo !== undefined && !r.update) return { kind: "updated", version: updatedTo };
  if (r.update) return { kind: "update", version: r.update.version, retry: failure?.action === "update" };
  if (r.kind === "skill" && r.needsSetup) return { kind: "setup" };
  return null;
}

/** A row has a switch unless it cannot be turned off: a missing or a local skill. */
export function hasSwitch(r: Pick<InstalledSkillView, "state">): boolean {
  return r.state === "installed";
}

/** The file View SKILL.md opens in a skill's folder. */
export const SKILL_FILE = "SKILL.md";

/**
 * A row's ⋯ menu, also its right-click menu: text only. A plugin has only Uninstall; a skill
 * can show its file (not a missing one) and run its setup script again. Disable and Update
 * are on the row. Setup needs an owner for its terminal: without one the item says so.
 */
export function skillMenu(
  r: Pick<InstalledSkillView, "kind" | "state" | "dir" | "setupScript">,
  o: { owner: boolean; noOwner: string; busy: boolean; onView: () => void; onSetup: () => void; onConfirm: (a: ConfirmAction) => void },
): OverflowItem[] {
  const items: OverflowItem[] = [];
  if (r.kind === "skill" && r.state !== "missing") {
    if (r.dir) items.push({ label: "View SKILL.md", onSelect: o.onView, testId: "skill-menu-view" });
    if (r.setupScript) items.push({ label: "Run setup again", onSelect: o.onSetup, testId: "skill-menu-setup", disabled: !o.owner || o.busy, ...(o.owner ? {} : { hint: o.noOwner }) });
  }
  if (items.length > 0) items.push("separator");
  const action = r.state === "local" ? "remove" : "uninstall";
  items.push({
    label: action === "remove" ? "Remove" : "Uninstall",
    onSelect: () => {
      o.onConfirm(action);
    },
    destructive: true,
    disabled: o.busy,
    testId: `skill-menu-${action}`,
  });
  return items;
}

// ---------------------------------------------------------------------------------------
// The page menu

/** How many a marketplace search can list: every plugin and skill the marketplaces have; null before they are read. */
export function marketplaceCount(rs: readonly Pick<SkillRegistryView, "plugins" | "skills">[] | undefined): number | null {
  return rs ? rs.reduce((n, r) => n + r.plugins + r.skills, 0) : null;
}

/** Refresh marketplaces' hint: when the marketplaces were last read ("Read 5 min ago"), by the newest read. */
export function refreshHint(rs: readonly Pick<SkillRegistryView, "readAtMs">[] | undefined, now: number): string {
  const read = (rs ?? []).map((r) => r.readAtMs).filter((ms) => ms !== null);
  const words = readWords(read.length > 0 ? Math.max(...read) : null, now);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Registries' hint: "ai-marketplace · 3 plugins · 1,237 skills", "2 marketplaces · …", "None configured". */
export function registriesSummary(rs: readonly Pick<SkillRegistryView, "name" | "plugins" | "skills">[] | undefined): string {
  if (!rs || rs.length === 0) return "None configured";
  const plugins = rs.reduce((n, r) => n + r.plugins, 0);
  const skills = rs.reduce((n, r) => n + r.skills, 0);
  const first = rs.length === 1 ? (rs[0]?.name ?? "") : `${String(rs.length)} marketplaces`;
  return [first, `${countWords(plugins)} ${plugins === 1 ? "plugin" : "plugins"}`, `${countWords(skills)} ${skills === 1 ? "skill" : "skills"}`].join(" · ");
}
