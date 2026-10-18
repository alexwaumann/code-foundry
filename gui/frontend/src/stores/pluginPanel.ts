/**
 * Opening a plugin surface from a `ShowView panel.plugin.<plugin>.<surface>[?thread=…|
 * ?project=…|?worktree=…]` intent (the surface's show command, docs/notes/plugins-2-surfaces.md):
 * the query's thread or project becomes the selection when it is not already, then the
 * surface's tab opens (or activates) in that selection's panel. A worktree query keeps the
 * selection (the panel shows for whatever holds that worktree now). The caller (views.ts
 * showView) closes a page over the content area first, since it hides the panel.
 */
import { toast } from "sonner";
import { getUiContext } from "./context";
import { openSurface } from "./panel";
import { surfaceManifestOf } from "./plugins";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { surfaceTab } from "@/surfaces/plugin";

export const PLUGIN_VIEW_PREFIX = "panel.plugin.";

/** A ShowView name's kind and its query. */
export function parsePluginView(name: string): { kind: string; params: URLSearchParams } | null {
  if (!name.startsWith(PLUGIN_VIEW_PREFIX)) return null;
  const rest = name.slice("panel.".length);
  const q = rest.indexOf("?");
  const kind = q < 0 ? rest : rest.slice(0, q);
  return /^plugin\.[^.?]+\.[^?]+$/.test(kind) ? { kind, params: new URLSearchParams(q < 0 ? "" : rest.slice(q + 1)) } : null;
}

/** Shows a plugin surface named by a ShowView; false when the name is not one (or names no known surface). */
export function showPluginView(name: string): boolean {
  const parsed = parsePluginView(name);
  if (!parsed) return false;
  const m = surfaceManifestOf(parsed.kind);
  if (!m) {
    toast.error("That plugin surface is not available", { description: parsed.kind });
    return true;
  }
  const ui = useUiStore.getState();
  const thread = parsed.params.get("thread") ?? "";
  const project = parsed.params.get("project") ?? "";
  if (thread) {
    if (!(ui.selection.kind === "thread" && ui.selection.id === thread) && thread in useThreadsStore.getState().byId) ui.select({ kind: "thread", id: thread });
  } else if (project && getUiContext().activeProjectId !== project) {
    ui.select({ kind: "compose", projectId: project });
  }
  openSurface("current", surfaceTab(m));
  return true;
}
