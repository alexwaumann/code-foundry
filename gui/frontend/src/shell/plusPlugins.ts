/**
 * Plugin surfaces in a pane's "+" menu and a thread's Open ▸ (docs/notes/plus-menu-plugins.md),
 * as pure functions: which surfaces a menu lists and what picking one runs. A surface is listed
 * when its show command (`plugin.<plugin>.show.<surface>`) is available for the menu's context:
 * the daemon evaluates its when clause, the GUI has none. A thread's surface (scope thread or
 * pr) is listed with that thread; one of any other scope in the "+" menu's Plugins list.
 */
import type { CommandView } from "@/api/command";
import type { SurfaceManifest } from "@/stores/plugins";
import type { LinkedAction } from "./linked";

/** Whether a surface of this scope shows a thread's (its pull request's too): its tab is linked to the thread. */
export function threadScopedSurface(scope: string): boolean {
  return scope === "" || scope === "thread" || scope === "pr";
}

/** The names of the plugin show commands available in a command list. */
export function availableShowCommands(commands: readonly Pick<CommandView, "name" | "available">[]): string[] {
  return commands.flatMap((c) => (c.available && c.name.startsWith("plugin.") && c.name.includes(".show.") ? [c.name] : []));
}

/**
 * The surfaces a menu lists, in plugin then manifest order: a thread's (`forThread`) or the
 * others, each only when its show command is available.
 */
export function listedSurfaces(surfaces: readonly SurfaceManifest[], available: ReadonlySet<string>, forThread: boolean): SurfaceManifest[] {
  return surfaces.filter((m) => threadScopedSurface(m.scope) === forThread && available.has(m.showCommand));
}

/**
 * Picking a surface: an open tab (a thread's surface already open in the space) is focused
 * where it is; otherwise its show command runs, in `pane` when the "+" menu chose it (else
 * placed by the rules), with `thread` as its context for a thread's surface.
 */
export function pluginSurfaceAction(m: Pick<SurfaceManifest, "showCommand">, at: { pane?: string; thread?: string; openTab?: string } = {}): LinkedAction {
  if (at.openTab) return { focus: at.openTab };
  const args: Record<string, string> = { ...(at.thread ? { thread: at.thread } : {}), ...(at.pane ? { pane: at.pane } : {}) };
  return at.thread ? { run: m.showCommand, args, thread: at.thread } : { run: m.showCommand, args };
}
