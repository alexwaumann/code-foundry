/**
 * Plugins as the daemon reports them (the EventService plugin source: a snapshot on every
 * connect, then each changed plugin, removals and availability epochs). Any plugin event
 * re-lists commands, since plugin surfaces are available exactly when their show
 * commands are (docs/notes/plugins-2-surfaces.md, "Show commands").
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PluginEventView, PluginSurfaceView, PluginView } from "@/api/plugin";
import { refreshCommands } from "./commands";
import { onInstallProgress, onRegistryEpoch } from "./pluginRegistry";

export interface PluginsState {
  byName: Readonly<Record<string, PluginView>>;
  /** Names, sorted. */
  order: readonly string[];
  loaded: boolean;
  /** The last availability epoch heard (PluginEvent.availability_epoch). */
  epoch: number;
}

export const usePluginsStore = create<PluginsState>()(() => ({ byName: {}, order: [], loaded: false, epoch: 0 }));

function sorted(byName: Readonly<Record<string, PluginView>>): string[] {
  return Object.keys(byName).sort();
}

/** The state after one plugin event. Pure. */
export function applyPluginEvent(s: PluginsState, ev: PluginEventView): PluginsState {
  switch (ev.kind) {
    case "snapshot": {
      const byName = Object.fromEntries(ev.plugins.map((p) => [p.name, p]));
      return { ...s, byName, order: sorted(byName), loaded: true };
    }
    case "updated": {
      const had = ev.plugin.name in s.byName;
      const byName = { ...s.byName, [ev.plugin.name]: ev.plugin };
      return { ...s, byName, order: had ? s.order : sorted(byName), loaded: true };
    }
    case "removed": {
      if (!(ev.name in s.byName)) return s;
      const { [ev.name]: _gone, ...byName } = s.byName;
      return { ...s, byName, order: sorted(byName) };
    }
    case "availability":
      return ev.epoch === s.epoch ? s : { ...s, epoch: ev.epoch };
    case "install-progress":
    case "registry":
      return s; // stores/pluginRegistry.ts
  }
}

let relist: ReturnType<typeof setTimeout> | undefined;

/** Applies a plugin event and re-lists commands soon after (a burst re-lists once). */
export function onPluginEvent(ev: PluginEventView): void {
  if (ev.kind === "install-progress") {
    onInstallProgress(ev.progress);
    return;
  }
  if (ev.kind === "registry") {
    onRegistryEpoch(ev.epoch);
    return;
  }
  usePluginsStore.setState((s) => applyPluginEvent(s, ev));
  clearTimeout(relist);
  relist = setTimeout(() => void refreshCommands(), 50);
}

/** A manifest surface with its plugin's names. */
export interface SurfaceManifest extends PluginSurfaceView {
  plugin: string;
  pluginDisplayName: string;
}

/** The surface a panel kind (plugin.<plugin>.<surface>) names, if a known plugin declares it. */
export function surfaceManifestOf(kind: string, s: PluginsState = usePluginsStore.getState()): SurfaceManifest | null {
  const m = /^plugin\.([^.]+)\.(.+)$/.exec(kind);
  if (!m?.[1]) return null;
  const p = s.byName[m[1]];
  const surf = p?.surfaces.find((x) => x.kind === kind);
  return p && surf ? { ...surf, plugin: p.name, pluginDisplayName: p.displayName } : null;
}

/** Every plugin's surfaces, in plugin name then manifest order. */
export function allSurfaces(s: PluginsState = usePluginsStore.getState()): SurfaceManifest[] {
  return s.order.flatMap((n) => {
    const p = s.byName[n];
    return p ? p.surfaces.map((surf) => ({ ...surf, plugin: p.name, pluginDisplayName: p.displayName })) : [];
  });
}

/** The plugin names (stable while the set does not change). */
export function usePluginNames(): readonly string[] {
  return usePluginsStore((s) => s.order);
}

export function usePlugin(name: string): PluginView | undefined {
  return usePluginsStore((s) => s.byName[name]);
}

/** Every surface's kind, for lists that render one row per surface. */
export function useSurfaceKinds(): string[] {
  return usePluginsStore(useShallow((s) => allSurfaces(s).map((x) => x.kind)));
}

/** A plugin's display name ("" when unknown). */
export function usePluginDisplayName(name: string): string {
  return usePluginsStore((s) => s.byName[name]?.displayName ?? "");
}
