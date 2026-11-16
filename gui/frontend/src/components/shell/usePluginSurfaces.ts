/**
 * Which plugin surfaces a menu lists (components/shell/PluginSurfaceItems.tsx): the show commands
 * available for its context, and the kinds of the surfaces they show.
 */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listCommands } from "@/api/command";
import { availableShowCommands, listedSurfaces, threadScopedSurface } from "@/shell/plusPlugins";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { allSurfaces, usePluginsStore } from "@/stores/plugins";
import { scopeKey } from "@/surfaces/plugin";

const NONE: readonly string[] = [];

/**
 * The plugin show commands available for a menu's context: the window's (the commands store as
 * listed), or a thread's. For a thread the store serves when it is listed for that thread;
 * otherwise (the "+" of a pane that is not the focused one, a sidebar row's menu) the daemon is
 * asked once for that thread's list, and again after an availability epoch.
 */
export function useShowCommands(threadId = ""): ReadonlySet<string> {
  const want = threadId ? scopeKey(contextKey(getUiContext({ kind: "thread", id: threadId }))) : "";
  const listed = useCommandsStore(useShallow((s) => (want === "" || (s.contextKey !== null && scopeKey(s.contextKey) === want) ? availableShowCommands(s.commands) : null)));
  const anyThreadSurface = usePluginsStore((s) => allSurfaces(s).some((m) => threadScopedSurface(m.scope)));
  const epoch = usePluginsStore((s) => s.epoch);
  const [fetched, setFetched] = useState<{ want: string; names: string[] } | null>(null);
  const ask = want !== "" && listed === null && anyThreadSurface;
  useEffect(() => {
    if (!ask) return;
    const ctl = new AbortController();
    listCommands(getUiContext({ kind: "thread", id: threadId }), { includeUnavailable: true, signal: ctl.signal })
      .then((cs) => {
        setFetched({ want, names: availableShowCommands(cs) });
      })
      .catch(() => undefined);
    return () => {
      ctl.abort();
    };
  }, [ask, threadId, want, epoch]);
  const names = listed ?? (fetched?.want === want ? fetched.names : NONE);
  const key = names.join("\n");
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/** The kinds of the surfaces a menu lists: a thread's or the others (shell/plusPlugins.ts listedSurfaces). */
export function useListedSurfaceKinds(forThread: boolean, available: ReadonlySet<string>): string[] {
  return usePluginsStore(useShallow((s) => listedSurfaces(allSurfaces(s), available, forThread).map((m) => m.kind)));
}
