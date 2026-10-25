/**
 * What a page's bridge forwards for each `cf:on` source (docs/notes/bridge-2-gui.md): the
 * GUI's own slices, fed by the one EventService stream it already holds, as their view
 * models. A registry, not a switch: a source is one entry. Nothing here opens a stream.
 *
 * A source with `snapshot` is state: the page gets it at once (when there is one) and
 * again after every change, whole. One with `events` only is a feed: the `ui` source's
 * intents, which no slice keeps.
 */
import type { BridgeSource } from "@/lib/bridge";
import { useActionsStore } from "./actions";
import { useEmberStore } from "./ember";
import { onDaemonEvent } from "./events";
import { dashboardResource } from "./gh";
import { usePluginsStore } from "./plugins";
import { useProjectsStore } from "./projects";
import { useSettingsStore } from "./settings";
import { useTerminalsStore } from "./terminals";
import { useThreadStore } from "./thread";
import { useThreadsStore } from "./threads";
import { useUpdateStore } from "./update";
import { useWorkspacesStore } from "./workspaces";

export interface SourceSpec {
  /**
   * The source's current state, or undefined while it has none yet (the PR dashboard
   * before its first read). Called after `subscribe` reported a change.
   */
  snapshot?: (threadId: string) => unknown;
  /** Calls cb on every change (state sources) or with every event (feeds). Returns the unsubscribe. */
  subscribe: (threadId: string, cb: (event?: unknown) => void) => () => void;
}

interface Subscribable {
  subscribe: (listener: () => void) => () => void;
}

/** Changes of any of the stores. */
function onStores(...stores: Subscribable[]): (threadId: string, cb: () => void) => () => void {
  return (_threadId, cb) => {
    const stops = stores.map((s) => s.subscribe(cb));
    return () => {
      for (const stop of stops) stop();
    };
  };
}

/** The dashboard key the PRs views read: the registered projects' pull requests. */
const DASHBOARD_KEY = "tracked";

export const bridgeSources: Record<BridgeSource, SourceSpec> = {
  // The user's threads in the sidebar's order (owned ones, a plugin's, left out).
  "thread-list": {
    snapshot: () => {
      const s = useThreadsStore.getState();
      return s.order.flatMap((id) => s.byId[id] ?? []);
    },
    subscribe: onStores(useThreadsStore),
  },
  // The page's own thread: its row (status, names, usage) and its pending requests; no items.
  thread: {
    snapshot: (threadId) => ({
      thread: useThreadsStore.getState().byId[threadId] ?? null,
      pending: useThreadStore.getState().pending[threadId]?.pending ?? [],
    }),
    subscribe: onStores(useThreadsStore, useThreadStore),
  },
  // The PR dashboard (registered projects): held while subscribed, as the PRs page holds it.
  gh: {
    snapshot: () => dashboardResource.store.getState().entries[DASHBOARD_KEY]?.data ?? undefined,
    subscribe: (_threadId, cb) => {
      const release = dashboardResource.watch(DASHBOARD_KEY);
      const stop = dashboardResource.store.subscribe(cb);
      return () => {
        stop();
        release();
      };
    },
  },
  action: {
    snapshot: () => {
      const s = useActionsStore.getState();
      return { actions: Object.values(s.byProject).flatMap((ids) => ids.flatMap((id) => s.byId[id] ?? [])), runs: Object.values(s.runs) };
    },
    subscribe: onStores(useActionsStore),
  },
  plugin: {
    snapshot: () => {
      const s = usePluginsStore.getState();
      return s.order.flatMap((n) => s.byName[n] ?? []);
    },
    subscribe: onStores(usePluginsStore),
  },
  terminal: {
    snapshot: () => {
      const s = useTerminalsStore.getState();
      return s.order.flatMap((id) => s.byId[id] ?? []);
    },
    subscribe: onStores(useTerminalsStore),
  },
  project: {
    snapshot: () => {
      const s = useProjectsStore.getState();
      return s.order.flatMap((id) => s.byId[id] ?? []);
    },
    subscribe: onStores(useProjectsStore),
  },
  workspace: {
    snapshot: () => {
      const s = useWorkspacesStore.getState();
      return s.order.flatMap((id) => s.byId[id] ?? []);
    },
    subscribe: onStores(useWorkspacesStore),
  },
  settings: {
    snapshot: () => useSettingsStore.getState().snapshot ?? undefined,
    subscribe: onStores(useSettingsStore),
  },
  update: {
    snapshot: () => useUpdateStore.getState().status ?? undefined,
    subscribe: onStores(useUpdateStore),
  },
  // Ember's board while the app holds its stream (its sidebar row, chat or Board panel).
  ember: {
    snapshot: () => useEmberStore.getState().board ?? undefined,
    subscribe: onStores(useEmberStore),
  },
  // UI intents (toasts, focus, palette) as they arrive; there is no state to send first.
  ui: {
    subscribe: (_threadId, cb) =>
      onDaemonEvent((ev) => {
        if (ev.source === "ui") cb(ev.event);
      }),
  },
};
