/**
 * Pure helpers behind Settings → Plugins (PluginsPage, docs/notes/plugins-page-redesign.md):
 * the groups, what a row shows and offers, the search, and the page menu's words. Kept apart
 * from the components so the table tests read them directly.
 */
import type { IndexEntryView, PluginView, RegistryView, Tone } from "@/api/plugin";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { countWords, flatIds, matchesWords } from "@/components/settings/catalog/model";
import type { PluginFailure, RegistryAction } from "@/stores/pluginRegistry";
import { shortSource } from "./registry";
import { keepsSecrets, statePill } from "./state";

/** The groups of the default list: what wants something done, then the rest by the switch. */
export type PluginGroup = "needs" | "running" | "disabled";

export const GROUP_LABELS: Readonly<Record<string, string>> = { needs: "Needs you", running: "Running", disabled: "Disabled", installed: "Installed" };

/** A registry lists a newer version it can install: a dev link updates from its folder. */
export function hasUpdate(p: Pick<PluginView, "updateAvailable" | "dev">): boolean {
  return p.updateAvailable && !p.dev;
}

type GroupedPlugin = Pick<PluginView, "name" | "state" | "enabled" | "dev" | "updateAvailable" | "needsConsent" | "disabledReason">;

/**
 * Where a plugin goes: Needs you for an update, a crash or failure, or consent it lost (and a
 * row an Update all finished, until the page is next opened); else by its switch. A new
 * plugin that has never been enabled is simply Disabled.
 */
export function pluginGroup(p: GroupedPlugin, updated: Readonly<Record<string, string>>): PluginGroup {
  if (p.name in updated || hasUpdate(p) || p.state === "crashed" || p.state === "failed" || (p.state === "disabled" && p.needsConsent && p.disabledReason !== "")) return "needs";
  return p.enabled ? "running" : "disabled";
}

/** Whether a plugin's name or description has every word. */
export function matchesPlugin(p: Pick<PluginView, "name" | "displayName" | "description">, words: readonly string[]): boolean {
  return matchesWords(words, [p.displayName, p.name, p.description]);
}

/** Whether a registry entry has every word, in its name, description or repository. */
export function matchesEntry(e: Pick<IndexEntryView, "name" | "displayName" | "description" | "repo">, words: readonly string[]): boolean {
  return matchesWords(words, [e.displayName, e.name, e.description, e.repo]);
}

/** The default list's flat ids (catalog flatIds): the groups in order, the store's order in each. */
export function groupedIds(plugins: readonly GroupedPlugin[], updated: Readonly<Record<string, string>>): string[] {
  const groups: Record<PluginGroup, string[]> = { needs: [], running: [], disabled: [] };
  for (const p of plugins) groups[pluginGroup(p, updated)].push(p.name);
  return flatIds([
    ["needs", groups.needs],
    ["running", groups.running],
    ["disabled", groups.disabled],
  ]);
}

/** The names of the entries with every word. */
export function matchingEntries(entries: readonly Parameters<typeof matchesEntry>[0][], words: readonly string[]): string[] {
  return entries.filter((e) => matchesEntry(e, words)).map((e) => e.name);
}

/** A search's Installed group as flat ids: what matches, and what a matching entry names (found by its repository). */
export function searchedIds(plugins: readonly Pick<PluginView, "name" | "displayName" | "description">[], hits: readonly string[], words: readonly string[]): string[] {
  return flatIds([["installed", plugins.filter((p) => matchesPlugin(p, words) || hits.includes(p.name)).map((p) => p.name)]]);
}

/** The registry entries to list: those matching, less any the Installed group shows. */
export function entryNames(entries: readonly Parameters<typeof matchesEntry>[0][], words: readonly string[], shown: ReadonlySet<string>): string[] {
  return entries.filter((e) => !shown.has(e.name) && matchesEntry(e, words)).map((e) => e.name);
}

/** The rows an Update all takes. */
export function updatablePlugins<P extends Pick<PluginView, "updateAvailable" | "dev">>(plugins: readonly P[]): P[] {
  return plugins.filter(hasUpdate);
}

/** A row's state pill, when the group and switch do not say it: not for running or plainly disabled. */
export function rowPill(p: Pick<PluginView, "state" | "enabled" | "needsConsent" | "disabledReason">): { label: string; tone: Tone } | null {
  const pill = statePill(p);
  return p.state === "running" || pill.label === "Disabled" ? null : pill;
}

/** What a row shows before its switch: the one thing it wants, or what it is doing. */
export type PluginMain = { kind: "working"; words: string } | { kind: "updated"; version: string } | { kind: "updating" } | { kind: "update"; version: string; retry: boolean } | null;

const WORKING: Readonly<Partial<Record<RegistryAction, string>>> = { restart: "Restarting…", reload: "Reloading…", uninstall: "Uninstalling…" };

/** A row's main action. A run's finished row says so; a failed update offers its retry (the failure is under the row). */
export function pluginMain(p: Pick<PluginView, "updateAvailable" | "dev" | "updateVersion">, busy: RegistryAction | null, failure: PluginFailure | null, updatedTo: string | undefined): PluginMain {
  const working = busy ? WORKING[busy] : undefined;
  if (working) return { kind: "working", words: working };
  if (busy === "update") return { kind: "updating" };
  if (hasUpdate(p)) return { kind: "update", version: p.updateVersion, retry: failure?.action === "update" };
  if (updatedTo !== undefined) return { kind: "updated", version: updatedTo };
  return null;
}

/** The surface's menu item when it cannot open: why. */
export const NOT_AVAILABLE = "Not available for what is selected";

/**
 * A row's ⋯ menu, also its right-click menu: text only. Open <surface> for each surface of
 * an enabled plugin (its show command, available or not for the selection), Restart, Logs,
 * Secrets, Reload for a dev link, then Uninstall. Disable and Update are on the row.
 */
export function pluginMenu(
  p: Pick<PluginView, "name" | "enabled" | "dev" | "surfaces" | "permissions" | "granted">,
  o: { available: ReadonlySet<string>; busy: boolean; onSurface: (command: string) => void; onRestart: () => void; onLogs: () => void; onSecrets: () => void; onReload: () => void; onUninstall: () => void },
): OverflowItem[] {
  const items: OverflowItem[] = [];
  if (p.enabled) {
    for (const s of p.surfaces) {
      const on = o.available.has(s.showCommand);
      items.push({
        label: `Open ${s.title}`,
        onSelect: () => {
          o.onSurface(s.showCommand);
        },
        testId: `plugin-menu-surface-${s.id}`,
        disabled: !on,
        ...(on ? {} : { hint: NOT_AVAILABLE }),
      });
    }
    items.push({ label: "Restart", onSelect: o.onRestart, testId: "plugin-menu-restart", disabled: o.busy });
  }
  items.push({ label: "Logs", onSelect: o.onLogs, testId: "plugin-menu-logs" });
  if (keepsSecrets(p)) items.push({ label: "Secrets", onSelect: o.onSecrets, testId: "plugin-menu-secrets" });
  if (p.dev) items.push({ label: "Reload", onSelect: o.onReload, testId: "plugin-menu-reload", disabled: o.busy });
  items.push("separator", { label: "Uninstall", onSelect: o.onUninstall, destructive: true, disabled: o.busy, testId: "plugin-menu-uninstall" });
  return items;
}

/** Registries' hint: "plugins.acme.dev/index.json · 18 plugins", "2 registries · 18 plugins", "None configured". */
export function registriesSummary(rs: readonly Pick<RegistryView, "url" | "plugins">[] | undefined): string {
  if (!rs || rs.length === 0) return "None configured";
  const plugins = rs.reduce((n, r) => n + r.plugins, 0);
  return [rs.length === 1 ? shortSource(rs[0]?.url ?? "") : `${String(rs.length)} registries`, `${countWords(plugins)} ${plugins === 1 ? "plugin" : "plugins"}`].join(" · ");
}
