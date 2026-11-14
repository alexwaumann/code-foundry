/**
 * The shell sidebar's own window prefs (docs/notes/shell-16-sidebar.md): whether the Needs you
 * and Active sections are collapsed. Persisted (localStorage "code-foundry.shellSidebar");
 * Working, Snoozed and Archived keep theirs in the UI store, shared with the classic sidebar.
 * Which spaces Needs you looks in is a setting (sidebar.needs_scope), not a pref: it is global.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bool, persistedRecord } from "./persisted";

interface ShellSidebarState {
  needsCollapsed: boolean;
  activeCollapsed: boolean;
}

export const useShellSidebarStore = create<ShellSidebarState>()(
  persist((): ShellSidebarState => ({ needsCollapsed: false, activeCollapsed: false }), {
    name: "code-foundry.shellSidebar",
    version: 1,
    // Only known fields of the right type (stores/persisted.ts).
    merge: (persisted, current) => {
      const p = persistedRecord(persisted);
      return { ...current, needsCollapsed: bool(p.needsCollapsed, current.needsCollapsed), activeCollapsed: bool(p.activeCollapsed, current.activeCollapsed) };
    },
  }),
);

export function toggleNeedsCollapsed(): void {
  useShellSidebarStore.setState((s) => ({ needsCollapsed: !s.needsCollapsed }));
}

export function toggleActiveCollapsed(): void {
  useShellSidebarStore.setState((s) => ({ activeCollapsed: !s.activeCollapsed }));
}
