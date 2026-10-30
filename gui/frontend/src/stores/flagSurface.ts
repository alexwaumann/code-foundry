/**
 * From a plugin's flag on a thread to that plugin's surface (docs/notes/plugins-11-gui-gaps.md):
 * a click on a sidebar row whose line 2 shows a flag opens the thread and, when the flag's
 * plugin has a thread- or pr-scoped surface available for it, that surface's tab in the
 * thread's side panel, through the ShowView path its show command takes.
 *
 * Availability is the show command's, listed for the thread's context (surfaces/plugin.ts
 * showState): right after the click the commands list is still the old selection's, so the
 * open waits for the thread's list (or gives up after a few seconds).
 */
import type { ThreadFlagView } from "@/api/threads";
import { statusLine } from "@/lib/statusLine";
import { topFlag } from "@/lib/thread";
import { showState } from "@/surfaces/plugin";
import { useCommandsStore } from "./commands";
import { allSurfaces, usePluginsStore, type PluginsState, type SurfaceManifest } from "./plugins";
import { useUiStore, type Selection } from "./ui";
import { showView } from "./views";

/** The flag a thread's line 2 shows (Claude's own prompts and errors win over a flag); null for none. */
export function shownFlag(t: Parameters<typeof statusLine>[0]): ThreadFlagView | null {
  const kind = statusLine(t).kind;
  return (kind === "flagAttention" || kind === "flagError") && t ? topFlag(t) : null;
}

/** The surfaces a flag can open: its plugin's thread- or pr-scoped ones, in manifest order. Pure. */
export function flagSurfaces(plugin: string, s: PluginsState = usePluginsStore.getState()): SurfaceManifest[] {
  return allSurfaces(s).filter((m) => m.plugin === plugin && (m.scope === "thread" || m.scope === "pr"));
}

/**
 * The first of a plugin's flag surfaces available for a selection: its manifest, null when
 * none is (or the plugin has none), "unknown" while the commands list for that selection
 * has not arrived.
 */
export function flagSurfaceFor(plugin: string, sel: Selection): SurfaceManifest | null | "unknown" {
  const candidates = flagSurfaces(plugin);
  if (candidates.length === 0) return null;
  for (const m of candidates) {
    const st = showState(m, sel);
    if (st === "unknown") return "unknown";
    if (st === "available") return m;
  }
  return null;
}

function subscribe(onChange: () => void): () => void {
  const a = useCommandsStore.subscribe(onChange);
  const b = usePluginsStore.subscribe(onChange);
  return () => {
    a();
    b();
  };
}

/** Opens a flag surface's tab in a thread's panel the way its show command's ShowView does. */
function show(m: SurfaceManifest, threadId: string): string {
  showFlagSurface(m.kind, threadId);
  return m.kind;
}

/**
 * After a click on a row whose line 2 shows a plugin's flag (the thread is selected by the
 * caller): once it is known which of the plugin's thread- or pr-scoped surfaces is
 * available for the thread, opens the first in its panel. Nothing when none is, when the
 * selection moved on, or after timeoutMs. Resolves the kind opened, or null.
 */
export function openFlagSurface(threadId: string, plugin: string, timeoutMs = 3000): Promise<string | null> {
  const sel: Selection = { kind: "thread", id: threadId };
  const stillThere = () => {
    const cur = useUiStore.getState().selection;
    return cur.kind === "thread" && cur.id === threadId;
  };
  const now = flagSurfaceFor(plugin, sel);
  if (now !== "unknown") return Promise.resolve(now && stillThere() ? show(now, threadId) : null);
  return new Promise((resolve) => {
    const done = (kind: string | null) => {
      clearTimeout(timer);
      unsub();
      resolve(kind);
    };
    const timer = setTimeout(() => {
      done(null);
    }, timeoutMs);
    const unsub = subscribe(() => {
      if (!stillThere()) {
        done(null);
        return;
      }
      const m = flagSurfaceFor(plugin, sel);
      if (m !== "unknown") done(m ? show(m, threadId) : null);
    });
  });
}

/** Opens a flag surface by kind in a thread's panel. */
export function showFlagSurface(kind: string, threadId: string): void {
  showView(`panel.${kind}?thread=${encodeURIComponent(threadId)}`);
}
