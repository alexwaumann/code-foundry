/**
 * Plugin surfaces (docs/notes/plugins-5-gui.md): every manifest surface is a panel surface
 * of kind `plugin.<plugin>.<surface>`. The registry falls through to this file for any
 * kind it does not list (registry.ts surfaceOf), so a plugin adds no file here.
 *
 * Availability is the surface's show command's (`plugin.<plugin>.show.<surface>`) in the
 * commands store, listed for the panel's context: the daemon evaluates the when clause,
 * the GUI has no evaluator. A surface whose command is unavailable is not listed. Plugin
 * surfaces have no hotkey letter; their title and icon come from the manifest (the icon
 * neutral, like every plugin's).
 */
import { createElement, useSyncExternalStore } from "react";
import { PluginSurface } from "@/components/plugin/PluginSurface";
import { pluginIcon } from "@/components/plugin/icons";
import { makeTab, type Tab } from "@/stores/panel";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { surfaceManifestOf, usePluginsStore, type SurfaceManifest } from "@/stores/plugins";
import type { Selection } from "@/stores/ui";
import type { SurfaceAvailability, SurfaceSpec } from "./types";

export const PLUGIN_KIND_PREFIX = "plugin.";

/** Whether a panel kind is a plugin surface's. */
export function isPluginKind(kind: string): boolean {
  return kind.startsWith(PLUGIN_KIND_PREFIX);
}

/** A context key without its terminal (a focused bottom shell does not change a surface's scope). */
function scopeKey(key: string): string {
  const parts = key.split("\u0000");
  parts.splice(1, 1);
  return parts.join("\u0000");
}

export type ShowState = "unknown" | "available" | "unavailable";

/**
 * Whether a surface can show for a selection: "unknown" while the commands store is
 * listed for another context (or the plugin is not known yet), else its show command's
 * availability.
 */
export function showState(m: SurfaceManifest | null, sel: Selection): ShowState {
  if (!m) return "unknown";
  const s = useCommandsStore.getState();
  if (s.contextKey === null || scopeKey(s.contextKey) !== scopeKey(contextKey(getUiContext(sel)))) return "unknown";
  return s.commands.some((c) => c.name === m.showCommand && c.available) ? "available" : "unavailable";
}

function subscribeShow(onChange: () => void): () => void {
  const a = useCommandsStore.subscribe(onChange);
  const b = usePluginsStore.subscribe(onChange);
  return () => {
    a();
    b();
  };
}

/** showState for a kind, kept current. */
export function useShowState(kind: string, sel: Selection): ShowState {
  return useSyncExternalStore(subscribeShow, () => showState(surfaceManifestOf(kind), sel));
}

/**
 * The show command's availability for a selection: "enabled" when the commands store,
 * listed for that selection's context, has it available; "hidden" otherwise (also while
 * the list is for another context, between a selection change and its re-list).
 */
export function showAvailability(m: SurfaceManifest | null, sel: Selection): SurfaceAvailability {
  return showState(m, sel) === "available" ? "enabled" : "hidden";
}

/** A plugin surface's tab: one per panel, no params (the panel's selection is its context). */
export function surfaceTab(m: SurfaceManifest): Tab {
  return makeTab(m.kind, m.title || m.id);
}

const specs = new Map<string, SurfaceSpec>();

/** The spec of a plugin surface kind (one object per kind, so lookups stay cheap); undefined for any other kind. */
export function pluginSurfaceSpec(kind: string): SurfaceSpec | undefined {
  if (!isPluginKind(kind)) return undefined;
  const cached = specs.get(kind);
  if (cached) return cached;
  const manifest = () => surfaceManifestOf(kind);
  const spec: SurfaceSpec = {
    kind,
    get title() {
      return manifest()?.title ?? kind.slice(PLUGIN_KIND_PREFIX.length);
    },
    get icon() {
      return pluginIcon(manifest()?.icon);
    },
    available: (ctx) => showAvailability(manifest(), ctx.selection),
    watches: [useCommandsStore, usePluginsStore],
    render: (tab) => createElement(PluginSurface, { tab }),
    openDefault: (ctx) => {
      const m = manifest();
      return m && showAvailability(m, ctx.selection) === "enabled" ? surfaceTab(m) : null;
    },
  };
  specs.set(kind, spec);
  return spec;
}
