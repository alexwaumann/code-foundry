/**
 * Pure helpers behind Settings → Skills (SkillsPage): dates, versions, pills and the words
 * the rows, the search line, the registries and the confirms use. Kept apart from the
 * components so the table tests read them directly.
 */
import type { Tone } from "@/api/plugin";
import type { InstalledSkillView, SkillEntryView, SkillKindView, SkillRegistryView, SkillTierView } from "@/api/skill";
import type { SkillAction } from "@/stores/skill";

/** The daemon's RestartWarning (internal/command/commands_skill.go): disable, uninstall and remove say it. */
export const RESTART_WARNING = "Threads that are running keep it until they restart. New threads pick this up at once.";

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

/**
 * An installed row's state pill: Missing (red), Disabled, Needs setup (amber; an enabled
 * skill whose script has not run), Enabled (emerald). A disabled skill says Disabled even
 * when it needs setup (its Run setup button says the rest). A local skill has none (it
 * says Local).
 */
export function installedPill(r: Pick<InstalledSkillView, "state" | "enabled" | "needsSetup" | "kind">): SkillPill | null {
  if (r.state === "local") return null;
  if (r.state === "missing") return { label: "Missing", tone: "error" };
  if (!r.enabled) return { label: "Disabled", tone: "muted" };
  if (r.kind === "skill" && r.needsSetup) return { label: "Needs setup", tone: "attention" };
  return { label: "Enabled", tone: "ok" };
}

/** Browse's words for an installed entry with nothing to update ("Installed", "Installed, disabled"). */
export function installedWords(e: Pick<SkillEntryView, "state">): string {
  return e.state === "disabled" ? "Installed, disabled" : "Installed";
}

/** The search's count line: "42 results", "1 result", "1,234 results, showing the first 200". */
export function resultsWords(total: number, shown: number): string {
  const n = `${total.toLocaleString("en-US")} ${total === 1 ? "result" : "results"}`;
  return shown < total ? `${n}, showing the first ${shown.toLocaleString("en-US")}` : n;
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

/** The confirming actions: the page asks with its own dialog, then runs the command preconfirmed. */
export type ConfirmAction = Extract<SkillAction, "disable" | "uninstall" | "remove">;

export function needsConfirm(a: SkillAction): a is ConfirmAction {
  return a === "disable" || a === "uninstall" || a === "remove";
}

/** The confirm dialog's words for an action on a row. */
export function confirmCopy(action: ConfirmAction, r: Pick<InstalledSkillView, "kind" | "name" | "dir">): { title: string; body: string; label: string } {
  const what = r.kind === "plugin" ? "plugin" : "skill";
  switch (action) {
    case "disable":
      return { title: `Disable ${r.name}?`, body: `Claude Code stops loading the ${what}; Enable brings it back. ${RESTART_WARNING}`, label: "Disable" };
    case "uninstall":
      return {
        title: `Uninstall ${r.name}?`,
        body: `${r.kind === "plugin" ? "Claude Code removes the plugin and its skills" : "Its directory is deleted"}; you can install it again from Browse. ${RESTART_WARNING}`,
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
