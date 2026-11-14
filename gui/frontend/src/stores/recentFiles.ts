/**
 * Files each thread showed in a File tab, most recent first: the file finder's
 * "Recently opened" group (lib/fileFinder.ts emptyGroups). A file counts when its tab
 * becomes the active tab of one of the panel's groups (opened, or switched to), however
 * that happened (a path chip, the finder, view.panel.file), and stays after its tab
 * closes. A tab that is its thread's page (view.panel.page) does not count. Keyed by the
 * panel's key (shell/host.ts targetOf), RECENT_FILES_MAX per panel, persisted beside the
 * panel's state (localStorage "code-foundry.recent-files"); a removed thread's list is
 * dropped with its panel (stores/archiveCleanup.ts).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { FILE_KIND, fileOfTab } from "@/surfaces/fileTarget";
import { isRecord, persistedRecord, recordOf } from "./persisted";
import { subscribeTabs, type TabPlace } from "@/shell/host";

/** A file a File tab showed: its tab's params. */
export interface RecentFile {
  project: string;
  /** The directory the tab read a relative path against (the thread's checkout). */
  base: string;
  /** Absolute (normalized) path: the File tab's key. */
  path: string;
}

/** Kept per panel: more than the finder shows (it drops those listed under Changed). */
export const RECENT_FILES_MAX = 10;

interface RecentFilesState {
  byKey: Readonly<Record<string, readonly RecentFile[]>>;
}

function recentFile(v: unknown): RecentFile | undefined {
  if (!isRecord(v) || typeof v.path !== "string" || !v.path.startsWith("/")) return undefined;
  return { project: typeof v.project === "string" ? v.project : "", base: typeof v.base === "string" ? v.base : "", path: v.path };
}

export const useRecentFilesStore = create<RecentFilesState>()(
  persist((): RecentFilesState => ({ byKey: {} }), {
    name: "code-foundry.recent-files",
    version: 1,
    // Only well-formed files in lists (stores/persisted.ts).
    merge: (persisted, current) => ({
      ...current,
      byKey: recordOf(persistedRecord(persisted).byKey, (v) => {
        const list = Array.isArray(v) ? v.map(recentFile).filter((r) => r !== undefined) : [];
        return list.length > 0 ? list.slice(0, RECENT_FILES_MAX) : undefined;
      }),
    }),
  }),
);

/** `file` moved to the front of `list` (one entry per path), at most RECENT_FILES_MAX. Pure. */
export function withRecent(list: readonly RecentFile[], file: RecentFile): RecentFile[] {
  return [file, ...list.filter((f) => f.path !== file.path)].slice(0, RECENT_FILES_MAX);
}

/** Records a file a panel showed. */
export function addRecentFile(panelKey: string, file: RecentFile): void {
  useRecentFilesStore.setState((s) => {
    const prev = s.byKey[panelKey] ?? EMPTY;
    if (prev[0]?.path === file.path && prev[0].base === file.base && prev[0].project === file.project) return s;
    return { byKey: { ...s.byKey, [panelKey]: withRecent(prev, file) } };
  });
}

const EMPTY: readonly RecentFile[] = [];

/** A panel's recent files, most recent first (a stable empty list when it has none). */
export function useRecentFiles(panelKey: string): readonly RecentFile[] {
  return useRecentFilesStore((s) => s.byKey[panelKey] ?? EMPTY);
}

/**
 * The File tabs that became active between two states of a panel: a group's active tab
 * that is a File tab (not a thread's page) and was not that group's active tab before.
 * Pure.
 */
export function newlyShownFiles(prev: TabPlace | undefined, next: TabPlace): RecentFile[] {
  const out: RecentFile[] = [];
  next.groups.forEach((g, i) => {
    const tab = g.active;
    if (!tab || tab.id === prev?.groups[i]?.active?.id) return;
    if (tab.kind !== FILE_KIND) return;
    const f = fileOfTab(tab);
    if (!f || f.page || !f.path.startsWith("/")) return;
    out.push({ project: f.project, base: f.base, path: f.path });
  });
  return out;
}

/** Records the File tabs every panel shows from now on (App's startApp). Returns the stop. */
export function startRecentFiles(): () => void {
  return subscribeTabs((now, prev) => {
    for (const [key, e] of Object.entries(now)) {
      const before = prev[key];
      if (e === before) continue;
      for (const f of newlyShownFiles(before, e)) addRecentFile(key, f);
    }
  });
}
