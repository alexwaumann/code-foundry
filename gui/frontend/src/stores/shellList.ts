/**
 * What the shell's sidebar is built from (lib/shellSections.ts): the classic list's keys
 * (stores/context.ts) with each thread's space, the current space's drafts, and the options.
 * Also the sidebar's thread order for the keys (cmd+1..9, thread.next/previous).
 * See docs/notes/shell-16-sidebar.md.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { needsBySpace, needsList, needsScopeOf, shellThreadOrder, type ShellDraft, type ShellListOptions, type ShellListThread } from "@/lib/shellSections";
import { decodeThreadListKeys, getListOptions, getListThreads, useThreadListKeys } from "./context";
import { spaceOfThread, useCurrentSpaceId, useLayoutStore } from "./layout";
import { useSettingsStore, useSettingValue } from "./settings";
import { useShellSidebarStore } from "./shellSidebar";
import { useThreadsStore } from "./threads";

/** The setting the Needs you section's scope is stored in. */
export const NEEDS_SCOPE_KEY = "sidebar.needs_scope";

/** Each thread's space, in the threads store's order (a primitive per thread, so moves rebuild and nothing else does). */
export function useThreadSpaces(): string[] {
  const order = useThreadsStore((s) => s.order);
  return useLayoutStore(useShallow((s) => order.map((id) => spaceOfThread(s, id))));
}

const NO_DRAFTS: readonly ShellDraft[] = [];

/** The current space's drafts, newest first: id and label only (a param change does not rebuild the list). */
export function useCurrentDrafts(): readonly ShellDraft[] {
  const keys = useLayoutStore(useShallow((s) => (s.spaces[s.currentSpaceId]?.drafts ?? NO_DRAFTS).map((d) => `${d.id}\u0001${d.label}`)));
  return keys.length === 0
    ? NO_DRAFTS
    : keys.map((k) => {
        const [id = "", label = ""] = k.split("\u0001");
        return { id, label };
      });
}

export function useNeedsScope(): "all" | "space" {
  return needsScopeOf(useSettingValue(NEEDS_SCOPE_KEY));
}

/** The shell list's threads read imperatively. */
export function getShellListThreads(): ShellListThread[] {
  const layout = useLayoutStore.getState();
  return getListThreads().map((t) => ({ ...t, spaceId: spaceOfThread(layout, t.id) }));
}

/** The shell list's options read imperatively, as the sidebar renders them. */
export function getShellListOptions(): ShellListOptions {
  const layout = useLayoutStore.getState();
  const prefs = useShellSidebarStore.getState();
  return {
    ...getListOptions(),
    currentSpaceId: layout.currentSpaceId,
    needsScope: needsScopeOf(useSettingsStore.getState().snapshot?.values[NEEDS_SCOPE_KEY]),
    needsCollapsed: prefs.needsCollapsed,
    activeCollapsed: prefs.activeCollapsed,
  };
}

/** Thread ids in the sidebar's order as drawn. */
export function sidebarThreadOrder(): string[] {
  return shellThreadOrder(getShellListThreads(), getShellListOptions());
}

/**
 * The Needs you list as the sidebar's section draws it, collapsed or not: its ids in order in
 * the scope in force, and whether any thread in any space waits on the user (the top bar's
 * control for a collapsed sidebar; docs/notes/shell-17-needs-you.md).
 */
export function useNeedsList(): { ids: readonly string[]; any: boolean } {
  const keys = useThreadListKeys();
  const spaces = useThreadSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const needsScope = useNeedsScope();
  return useMemo(() => needsList(decodeThreadListKeys(keys).map((t, i) => ({ ...t, spaceId: spaces[i] ?? "" })), { currentSpaceId, needsScope }), [keys, spaces, currentSpaceId, needsScope]);
}

/** The Needs you list's ids read imperatively (cmd+shift+a). */
export function getNeedsIds(): string[] {
  return needsList(getShellListThreads(), getShellListOptions()).ids;
}

/**
 * The count each space tab shows: the threads in that space that Needs you lists for it
 * (lib/shellSections.ts needsBySpace), by space id. Rebuilt when a thread's list key or space
 * changes, as the sidebar is.
 */
export function useNeedsBySpace(): Readonly<Record<string, number>> {
  const keys = useThreadListKeys();
  const spaces = useThreadSpaces();
  return useMemo(() => needsBySpace(decodeThreadListKeys(keys).map((t, i) => ({ ...t, spaceId: spaces[i] ?? "" }))), [keys, spaces]);
}
